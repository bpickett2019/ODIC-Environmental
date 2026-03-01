/**
 * ODIC ESA Pipeline — Full AI-Powered Server
 *
 * Express server with REST API for the dashboard.
 * Wired to the full AI classification + report writing + assembly pipeline.
 *
 * Run with: npx tsx src/server.ts
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import AdmZip from 'adm-zip';
import { dotenvLoad } from './core/env-loader.js';

dotenvLoad();

// Core pipeline imports
import { loadAppConfig, loadESATemplate, loadDocumentTypes } from './core/config-loader.js';
import { StateManager } from './core/state.js';
import { LLMClient } from './core/llm-client.js';
import { PDFReaderSkill } from './skills/pdf-reader.js';
import { DocumentClassifierSkill } from './skills/document-classifier.js';
import { FileReceiver } from './core/sftp-server.js';
import { FTPPullClient, type RemoteFTPConfig } from './core/ftp-client.js';
import {
  createMultiPageText,
  createTableOfContents,
  getPageCount,
  ensureDir,
  convertToPdf,
  convertImageToPdf,
} from './core/pdf-utils.js';
import type { DocumentType, ReportSection, ReportType } from './types/index.js';
import { EmailDeliveryService, checkRateLimit } from './core/email-delivery.js';
import type { DeliveryRequest } from './core/email-delivery.js';
import { RECDetectorSkill, type RECDetectorOutput } from './skills/rec-detector.js';
import { AddressResearchSkill, type AddressResearchOutput } from './skills/address-research.js';
import { VisionAnalyzerSkill } from './skills/vision-analyzer.js';

const logger = pino({
  name: 'ODIC-Server',
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

// ── Pipeline Singletons ─────────────────────────────────────────────────────

let config: Awaited<ReturnType<typeof loadAppConfig>>;
let esaTemplate: Awaited<ReturnType<typeof loadESATemplate>>;
let docTypes: Awaited<ReturnType<typeof loadDocumentTypes>>;
let state: StateManager;
let llm: LLMClient | null = null;
let pdfReader: PDFReaderSkill;
let classifier: DocumentClassifierSkill | null = null;
let pipelineReady = false;
let ftpReceiver: FileReceiver | null = null;
let emailService: EmailDeliveryService | null = null;
let remoteFtpClient: FTPPullClient | null = null;

async function initPipeline() {
  config = await loadAppConfig();
  esaTemplate = await loadESATemplate();
  docTypes = await loadDocumentTypes();
  state = new StateManager('projects/pipeline.db');
  await state.init();
  pdfReader = new PDFReaderSkill(config);

  // AI: uses Claude Code CLI (your subscription) or ANTHROPIC_API_KEY as fallback.
  // QC checking and report assembly are fully local and never require AI.
  try {
    llm = new LLMClient(config.llm);
    classifier = new DocumentClassifierSkill(config, llm);
    logger.info('AI pipeline ready — full classification enabled via Claude Code subscription');
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'AI classification unavailable — using heuristic mode (works for well-named files)');
  }

  // Email delivery service
  if (config.email_delivery.enabled) {
    try {
      emailService = new EmailDeliveryService(config.email_delivery);
      await emailService.init();
      logger.info({ provider: config.email_delivery.provider }, 'Email delivery service ready');
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Email delivery unavailable — continuing without it');
      emailService = null;
    }
  }

  // Check availability of optional CLI tools (non-blocking)
  const tools: Record<string, boolean> = { ghostscript: false, libreoffice: false, sharp: false, qpdf: false };
  try {
    const { existsSync } = await import('fs');
    const gsCandidates = ['/opt/homebrew/bin/gs', '/usr/local/bin/gs', '/usr/bin/gs'];
    tools.ghostscript = gsCandidates.some(p => existsSync(p));
  } catch {}
  try {
    const { existsSync } = await import('fs');
    const loCandidates = ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/libreoffice', '/usr/local/bin/libreoffice', '/opt/homebrew/bin/soffice'];
    tools.libreoffice = loCandidates.some(p => existsSync(p));
  } catch {}
  try { await import('sharp'); tools.sharp = true; } catch {}
  try {
    const { existsSync } = await import('fs');
    const qpdfCandidates = ['/opt/homebrew/bin/qpdf', '/usr/local/bin/qpdf', '/usr/bin/qpdf'];
    tools.qpdf = qpdfCandidates.some(p => existsSync(p));
  } catch {}
  logger.info({ tools }, 'Optional tool availability');
  if (!tools.ghostscript) logger.warn('Ghostscript not found — PDF compression will be unavailable (brew install ghostscript)');
  if (!tools.libreoffice) logger.warn('LibreOffice not found — VSD/Office file conversion will be unavailable');

  // Pre-convert the site location map VSD template to PDF (cached for assembly)
  if (tools.libreoffice) {
    try {
      const vsdTemplatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'config', 'site-location-map-template.vsd');
      const cachedPdfPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'config', 'site-location-map-template.pdf');
      if (fs.existsSync(vsdTemplatePath) && !fs.existsSync(cachedPdfPath)) {
        const result = await convertToPdf(vsdTemplatePath, path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'config'));
        if (result) {
          logger.info({ output: result }, 'Site location map VSD template converted to PDF');
        } else {
          logger.warn('Failed to convert site location map VSD template to PDF');
        }
      } else if (fs.existsSync(cachedPdfPath)) {
        logger.info('Site location map template PDF already cached');
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Failed to pre-convert site location map template');
    }
  }

  pipelineReady = true;
}

// ── Express Setup ───────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join('uploads', req.params.id as string as string);
    fs.ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 50 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.pdf', '.vsd', '.vsdx', '.doc', '.docx', '.xls', '.xlsx', '.dbf', '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic'];
    if (file.mimetype === 'application/pdf' || allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not supported. Accepted: PDF, VSD, Office docs, images`));
    }
  },
});

// Multer instance for PDF insert uploads (saves to uploads/{id}/_inserts/{uuid}.pdf)
const insertStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join('uploads', req.params.id as string, '_inserts');
    fs.ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}.pdf`),
});
const uploadInsert = multer({
  storage: insertStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype === 'application/pdf' || ext === '.pdf') cb(null, true);
    else cb(new Error('Only PDF files accepted for insert'));
  },
});

// ── Types ───────────────────────────────────────────────────────────────────

interface ProjectState {
  id: string;
  name: string;
  clientName: string;
  propertyAddress: string;
  reportType: ReportType;
  isSbaLoan: boolean;
  reportDate: string;
  epName: string;
  createdAt: string;
  status: string;
  files: FileRecord[];
  manifest?: any;
  aiUsage?: AIUsage;
  scorecard?: Scorecard;
  qcResult?: any;
  /** Address research data from public APIs */
  researchData?: any;
  /** REC analysis results */
  recAnalysis?: any;
  /** Vision analysis narratives keyed by filename */
  visionAnalyses?: Record<string, string>;
  /** Site visit observations */
  siteVisitObservations?: any[];
  /** AI QC results (post-assembly AI review — separate from local QC) */
  aiQcResult?: AIQCResult;
  /** Email delivery records */
  deliveries?: any[];
}

interface FileRecord {
  filename: string;
  uploadedAt: string;
  documentType: string;
  section: string;
  label: string;
  confidence: number;
  reasoning: string;
  needsReview: boolean;
  classifiedBy: string;
  pageCount: number;
}

interface AIUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  classificationCalls: number;
  writingCalls: number;
}

interface Scorecard {
  totalFiles: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  needsReview: number;
  averageConfidence: number;
  heuristicClassified: number;
  aiClassified: number;
}

interface AIQCResult {
  passed: boolean;
  findings: Array<{
    severity: 'error' | 'warning' | 'info';
    category: 'cross_property' | 'ordering' | 'content_mismatch' | 'missing_content' | 'duplicate';
    section: string;
    message: string;
  }>;
  summary: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadProject(id: string): ProjectState | null {
  const p = path.join('uploads', id, 'project.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}

function saveProject(id: string, project: ProjectState): void {
  const target = path.join('uploads', id, 'project.json');
  const tmp = target + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(project, null, 2));
    fs.renameSync(tmp, target);
  } catch (err) {
    logger.error({ id, error: (err as Error).message }, 'Failed to save project state');
    try { fs.removeSync(tmp); } catch {}
  }
}

function buildScorecard(files: FileRecord[]): Scorecard {
  const c = files.map(f => f.confidence);
  return {
    totalFiles: files.length,
    highConfidence: files.filter(f => f.confidence >= 0.90).length,
    mediumConfidence: files.filter(f => f.confidence >= 0.70 && f.confidence < 0.90).length,
    lowConfidence: files.filter(f => f.confidence < 0.70).length,
    needsReview: files.filter(f => f.needsReview).length,
    averageConfidence: c.length ? c.reduce((a, b) => a + b, 0) / c.length : 0,
    heuristicClassified: files.filter(f => f.classifiedBy === 'heuristic').length,
    aiClassified: files.filter(f => f.classifiedBy === 'haiku' || f.classifiedBy === 'sonnet').length,
  };
}

function sendSSE(res: Response, data: any): void {
  try {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  } catch {
    // Client disconnected — pipeline continues, results still saved to disk
  }
}

// ── Cross-Property Spot Check ──────────────────────────────────────────────
// After classification, verify heuristic-classified files aren't from a different property/project

async function crossPropertySpotCheck(opts: {
  files: FileRecord[];
  projectId: string;
  project: ProjectState;
  dir: string;
  sendProgress: (event: any) => void;
}): Promise<{ flagged: string[]; checked: number }> {
  const { files, projectId, project, dir, sendProgress } = opts;

  if (!llm || !classifier) return { flagged: [], checked: 0 };
  const activeLlm = llm; // capture non-null reference for async callbacks

  // Identify suspicious heuristic-classified files
  const suspicious = files.filter(f => {
    if (f.classifiedBy !== 'heuristic') return false;
    if (f.documentType === 'other_unknown') return false; // already going to AI

    // Large PDFs (20+ pages) — could be complete reports from another project
    if (f.pageCount >= 20) return true;

    // Files with project numbers in filename that don't match current project
    const projNumMatch = f.filename.match(/\d{5,}/);
    if (projNumMatch && projectId && !projectId.includes(projNumMatch[0]) && !project.name?.includes(projNumMatch[0])) return true;

    // Report body classified by heuristic — verify it's actually this project's report
    if (f.documentType === 'report_body') return true;

    // Very large PDFs (50+ pages) classified as a single appendix type
    if (f.pageCount >= 50 && f.section?.startsWith('appendix_')) return true;

    return false;
  });

  if (suspicious.length === 0) return { flagged: [], checked: 0 };

  // ── Phase 1: Read all suspicious file texts in parallel (no AI) ──────────
  const pLimitMod = await import('p-limit');
  const readLimit = pLimitMod.default(8);

  sendProgress({ phase: 'cross_check', message: `Reading ${suspicious.length} file(s) for cross-property check...` });

  type FileWithText = { file: FileRecord; text: string };
  const readResults = await Promise.allSettled(
    suspicious.map(file => readLimit(async (): Promise<FileWithText | null> => {
      const filePath = path.join(dir, file.filename);
      if (!fs.existsSync(filePath)) return null;
      const readResult = await pdfReader.process({ filePath, maxTextPages: 3 });
      if (!readResult.success || !readResult.data.combinedText?.trim()) return null;
      return { file, text: readResult.data.combinedText.substring(0, 1500) };
    }))
  );

  const readable: FileWithText[] = readResults
    .filter((r): r is PromiseFulfilledResult<FileWithText> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  if (readable.length === 0) {
    sendProgress({ phase: 'cross_check_complete', checked: 0, flagged: 0, message: 'No readable files to check' });
    return { flagged: [], checked: 0 };
  }

  // ── Phase 2: Batch all files into parallel AI calls (25 per batch) ───────
  const BATCH_SIZE = 25;
  const batches: FileWithText[][] = [];
  for (let i = 0; i < readable.length; i += BATCH_SIZE) {
    batches.push(readable.slice(i, i + BATCH_SIZE));
  }

  sendProgress({ phase: 'cross_check', message: `Verifying ${readable.length} file(s) in ${batches.length} batch(es)...` });

  interface BatchVerdict {
    filename: string;
    belongs_to_project: boolean;
    detected_address: string | null;
    detected_project_id: string | null;
    confidence: number;
    reasoning: string;
  }

  const batchResults = await Promise.allSettled(
    batches.map(async (batch) => {
      const fileEntries = batch.map((item, i) =>
        `DOCUMENT ${i + 1}: "${item.file.filename}" (${item.file.label}, ${item.file.pageCount} pages)\n${item.text}`
      ).join('\n\n---\n\n');

      const batchPrompt = `You are verifying whether documents belong to the correct environmental project.

CURRENT PROJECT:
- Project ID: ${projectId}
- Project Name: ${project.name || 'Unknown'}
- Property Address: ${project.propertyAddress || 'Unknown'}
- Client: ${project.clientName || 'Unknown'}

For each document below, determine if it belongs to this project based on addresses, project IDs, and client names in the text.

${fileEntries}

Respond with a JSON array — one entry per document in the same order:
[
  {
    "filename": "exact filename",
    "belongs_to_project": true,
    "detected_address": "address found or null",
    "detected_project_id": "project number found or null",
    "confidence": 0.95,
    "reasoning": "brief explanation"
  }
]

If you cannot determine with confidence, set belongs_to_project to true (benefit of the doubt).`;

      const response = await activeLlm.call<BatchVerdict[]>(
        { text: batchPrompt },
        {
          modelTier: 'classifier',
          system: 'You are a document verification assistant. Respond only with a valid JSON array.',
          maxTokens: 2000,
          temperature: 0,
          parseJson: true,
        }
      );

      // llm.call with parseJson may wrap single objects — handle both array and {results: [...]} shapes
      const verdicts: BatchVerdict[] = Array.isArray(response.data)
        ? response.data
        : (response.data as any)?.results ?? [];
      return verdicts;
    })
  );

  // ── Phase 3: Apply verdicts ────────────────────────────────────────────────
  const flagged: string[] = [];
  let checked = 0;

  for (const batchResult of batchResults) {
    if (batchResult.status !== 'fulfilled') continue;
    for (const verdict of batchResult.value) {
      checked++;
      if (verdict.belongs_to_project === false && verdict.confidence >= 0.7) {
        const idx = files.findIndex(f2 => f2.filename === verdict.filename);
        if (idx >= 0) {
          files[idx] = {
            ...files[idx],
            documentType: 'prior_environmental_report',
            section: 'appendix_i_additional',
            label: `Prior Report${verdict.detected_address ? ` (${verdict.detected_address})` : ''}`,
            reasoning: `⚠️ Cross-property detected: ${verdict.reasoning}`,
            needsReview: true,
            classifiedBy: 'ai-verified',
          };
          flagged.push(verdict.filename);
          sendProgress({ phase: 'cross_check', step: 'flagged', file: verdict.filename,
            message: `Flagged: ${verdict.filename} — ${verdict.reasoning}`,
            detectedAddress: verdict.detected_address });
        }
      } else {
        sendProgress({ phase: 'cross_check', step: 'ok', file: verdict.filename,
          message: `Verified: ${verdict.filename} belongs to this project` });
      }
    }
  }

  sendProgress({ phase: 'cross_check_complete', checked, flagged: flagged.length,
    message: flagged.length > 0
      ? `Spotted ${flagged.length} potential cross-property file(s) out of ${checked} checked`
      : `Verified ${checked} file(s) — no cross-property issues detected` });

  return { flagged, checked };
}

// ── Post-Assembly AI QC Agent ──────────────────────────────────────────────
// Runs AFTER the local QC checker — reviews assembled PDF for correctness

async function aiQualityCheck(opts: {
  assembledPath: string;
  project: ProjectState;
  dir: string;
  sendProgress: (event: any) => void;
}): Promise<AIQCResult | null> {
  const { assembledPath, project, dir, sendProgress } = opts;

  if (!llm) return null;
  if (!fs.existsSync(assembledPath)) return null;

  sendProgress({ phase: 'ai_qc', message: 'Running AI quality review on assembled report...' });

  try {
    // Sample pages at section boundaries using the manifest
    const manifest = project.manifest;
    const pagesToRead: number[] = [];

    if (manifest?.sections) {
      for (const section of manifest.sections) {
        for (const doc of section.documents || []) {
          // First page of each document section
          if (doc.pageStart) pagesToRead.push(doc.pageStart);
          // Last page of previous section boundary
          if (doc.pageEnd && doc.pageEnd > doc.pageStart) pagesToRead.push(doc.pageEnd);
        }
      }
    }

    // Deduplicate and sort, cap at ~30 pages
    const uniquePages = [...new Set(pagesToRead)].sort((a, b) => a - b);
    const samplePages = uniquePages.length > 30 ? uniquePages.filter((_, i) => i % Math.ceil(uniquePages.length / 30) === 0) : uniquePages;

    // Read a generous sample from the assembled PDF (pdfReader samples evenly across pages)
    let sampleText = '';
    try {
      const readResult = await pdfReader.process({ filePath: assembledPath, maxTextPages: 30 });
      if (readResult.success && readResult.data.combinedText?.trim()) {
        sampleText = readResult.data.combinedText.substring(0, 50000);
      }
    } catch {}

    if (!sampleText.trim()) {
      sendProgress({ phase: 'ai_qc_complete', skipped: true, reason: 'Could not read assembled PDF text' });
      return null;
    }

    // Build manifest summary for context
    const manifestSummary = manifest?.sections?.map((s: any) => {
      const docs = (s.documents || []).map((d: any) => `  - ${d.filename} (pages ${d.pageStart}-${d.pageEnd})`).join('\n');
      return `${s.section}:\n${docs}`;
    }).join('\n') || 'No manifest available';

    const prompt = `You are a quality assurance reviewer for Phase I Environmental Site Assessment reports.

PROJECT CONTEXT:
- Property Address: ${project.propertyAddress || 'Not specified'}
- Client: ${project.clientName || 'Not specified'}
- Project Name: ${project.name || 'Not specified'}
- Report Type: ${project.reportType || 'phase1_esa'}
- EP: ${project.epName || 'Not specified'}

ASSEMBLY MANIFEST (expected structure):
${manifestSummary}

SAMPLED TEXT FROM ASSEMBLED REPORT (${samplePages.length || '~15'} pages sampled at section boundaries):
${sampleText.substring(0, 50000)}

Review this assembled report for the following issues:

1. **Cross-Property Contamination**: Are there references to different property addresses, project numbers, or firm names that don't match the project context? (This is the most critical check.)
2. **Section Ordering**: Does the content follow the expected order (front matter → body sections → appendices A through F)?
3. **Content Mismatches**: Does appendix content match its divider label? (e.g., Appendix D should contain historical records, not site photos)
4. **Missing Content References**: Does the report body reference appendices or documents that don't appear to exist in the assembly?
5. **Duplicates**: Are there any obviously duplicated sections or out-of-place content?

Respond with ONLY valid JSON in this exact format:
{
  "passed": true/false,
  "findings": [
    {
      "severity": "error"|"warning"|"info",
      "category": "cross_property"|"ordering"|"content_mismatch"|"missing_content"|"duplicate",
      "section": "section name where issue found",
      "message": "concise description of the issue"
    }
  ],
  "summary": "1-2 sentence overall assessment"
}

If everything looks correct, return passed=true with an empty findings array and a positive summary.
Mark as "error" only clear problems (wrong address, wrong project). Use "warning" for potential issues. Use "info" for minor observations.`;

    sendProgress({ phase: 'ai_qc', step: 'analyzing', message: 'AI reviewing report structure and content...' });

    const response = await llm.call<AIQCResult>(
      { text: prompt },
      {
        modelTier: 'reasoning',
        system: 'You are an expert environmental report QA reviewer. Respond only with valid JSON.',
        maxTokens: 2000,
        temperature: 0,
        parseJson: true,
      },
    );

    if (response.data) {
      const result: AIQCResult = {
        passed: response.data.passed ?? true,
        findings: (response.data.findings || []).map(f => ({
          severity: f.severity || 'info',
          category: f.category || 'content_mismatch',
          section: f.section || 'Unknown',
          message: f.message || '',
        })),
        summary: response.data.summary || 'AI review complete.',
      };

      sendProgress({
        phase: 'ai_qc_complete',
        passed: result.passed,
        findings: result.findings,
        summary: result.summary,
        errorCount: result.findings.filter(f => f.severity === 'error').length,
        warningCount: result.findings.filter(f => f.severity === 'warning').length,
        infoCount: result.findings.filter(f => f.severity === 'info').length,
        costUsd: response.costUsd.toFixed(4),
      });

      return result;
    }
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'AI QC check failed');
    sendProgress({ phase: 'ai_qc_complete', skipped: true, reason: (err as Error).message });
  }

  return null;
}

// ── Shared Post-Assembly Pipeline ──────────────────────────────────────────
// Compress → Split → QC — called by manual assemble, auto-pipeline, and address-report

interface PostAssemblyResult {
  compressedSizeMB: number;
  splitParts: Array<{ label: string; sizeMB: number; pageCount: number; downloadUrl: string }>;
  qcResult: any;
  aiQcResult: AIQCResult | null;
}

async function postAssembly(opts: {
  assembledPath: string;
  project: ProjectState;
  projectId: string;
  dir: string;
  res: Response;
}): Promise<PostAssemblyResult> {
  const { assembledPath, project, projectId, dir, res } = opts;
  const assembledSizeMB = (await fs.stat(assembledPath)).size / (1024 * 1024);

  // ── Compress ──
  let compressedSizeMB = assembledSizeMB;
  try {
    const { compressPDF } = await import('./core/pdf-postprocess.js');
    sendSSE(res, { phase: 'compressing', message: `Compressing ${assembledSizeMB.toFixed(1)}MB report...`, inputSizeMB: +assembledSizeMB.toFixed(1) });

    const compressResult = await compressPDF(assembledPath, path.join(dir, 'assembled-compressed.pdf'), {
      quality: 'ebook', maxSizeMB: 25,
    });
    compressedSizeMB = compressResult.outputSizeMB;
    await fs.move(path.join(dir, 'assembled-compressed.pdf'), assembledPath, { overwrite: true });

    sendSSE(res, { phase: 'compressed',
      inputSizeMB: +compressResult.inputSizeMB.toFixed(1),
      outputSizeMB: +compressResult.outputSizeMB.toFixed(1),
      reductionPercent: +compressResult.reductionPercent.toFixed(0),
    });
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'Compression unavailable — skipping');
    sendSSE(res, { phase: 'compressed', skipped: true, reason: (err as Error).message });
  }

  // ── Split (if over 20MB) ──
  let splitParts: PostAssemblyResult['splitParts'] = [];
  if (compressedSizeMB > 20) {
    try {
      const { splitReport } = await import('./core/pdf-postprocess.js');
      sendSSE(res, { phase: 'splitting', message: `Report is ${compressedSizeMB.toFixed(1)}MB — splitting for email delivery...` });

      const splitResult = await splitReport(assembledPath, project.files, { maxPartSizeMB: 20 });
      splitParts = splitResult.parts.map((p: any) => ({
        label: p.label, sizeMB: +p.sizeMB.toFixed(1), pageCount: p.pageCount,
        downloadUrl: `/api/projects/${projectId}/download?part=${path.basename(p.path)}`,
      }));

      sendSSE(res, { phase: 'split', parts: splitParts, totalParts: splitResult.totalParts });
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Splitting unavailable — skipping');
    }
  }

  // ── QC Check (fully local — no API calls needed) ──
  let qcResult: any = null;
  try {
    const { QCCheckerSkill } = await import('./skills/qc-checker.js');
    sendSSE(res, { phase: 'qc', message: 'Running quality checks...' });

    const qc = new QCCheckerSkill(config);
    const qcOutput = await qc.process({
      projectDir: dir,
      files: project.files.map(f => ({
        filename: f.filename, documentType: f.documentType,
        label: f.label, section: f.section, confidence: f.confidence,
      })),
      projectInfo: {
        propertyAddress: project.propertyAddress || '',
        clientName: project.clientName || '',
        reportType: project.reportType,
        epName: project.epName,
      },
    });

    if (qcOutput.success) {
      qcResult = qcOutput.data;
      project.qcResult = {
        passed: qcResult.passed, score: qcResult.score,
        summary: qcResult.summary, checks: qcResult.checks,
        recordsAnalysis: qcResult.recordsAnalysis,
      };
      saveProject(projectId, project);

      sendSSE(res, { phase: 'qc_complete',
        passed: qcResult.passed, score: qcResult.score,
        checks: qcResult.checks, summary: qcResult.summary,
        recordsAnalysis: qcResult.recordsAnalysis,
      });
    }
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'QC checker unavailable — skipping');
    sendSSE(res, { phase: 'qc_complete', skipped: true, reason: (err as Error).message });
  }

  // ── AI QC (post-assembly AI review — separate from local QC above) ──
  let aiQcResult: AIQCResult | null = null;
  try {
    aiQcResult = await aiQualityCheck({
      assembledPath, project, dir,
      sendProgress: (event: any) => sendSSE(res, event),
    });
    if (aiQcResult) {
      project.aiQcResult = aiQcResult;
      saveProject(projectId, project);
    }
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'AI QC check failed — skipping');
    sendSSE(res, { phase: 'ai_qc_complete', skipped: true, reason: (err as Error).message });
  }

  return { compressedSizeMB, splitParts, qcResult, aiQcResult };
}

// ── Shared Assembly Function ──────────────────────────────────────────────────
// Single source of truth for report PDF assembly — replaces 3 duplicated loops

interface AssemblyManifest {
  assembledAt: string;
  totalPages: number;
  sections: Array<{ section: string; documents: Array<{ filename: string; pageStart: number; pageEnd: number; pages: number; label: string }> }>;
  dividerPages: number;
  generatedNarrativePages: number;
  filesAdded: number;
  filesSkipped: Array<{ filename: string; reason: string }>;
  filesErrored: Array<{ filename: string; error: string }>;
}

const NARRATIVE_MAP: Record<string, string> = {
  body_executive_summary: 'executive_summary', body_introduction: 'introduction',
  body_property_description: 'property_description', body_property_reconnaissance: 'property_reconnaissance',
  body_property_history: 'property_history', body_records_research: 'records_research',
  body_user_information: 'user_information', body_references: 'references',
};

async function assembleReport(opts: {
  dir: string;
  files: FileRecord[];
  propertyAddress?: string;
  sendProgress: (event: any) => void;
}): Promise<{ pdfBytes: Uint8Array; manifest: AssemblyManifest; sectionPageStarts: Array<{ section: string; startPage: number }> }> {
  const { dir, files, propertyAddress, sendProgress } = opts;
  const narrativeDir = path.join(dir, '_narratives');
  const appendixSections = new Set(Object.keys(APPENDIX_INFO));

  // Determine assembly order based on whether reliance letter is present
  const hasReliance = files.some(f => f.documentType === 'reliance_letter' || f.section === 'front_reliance');
  const SECTION_ORDER = getSectionOrder(hasReliance);

  // Within-section type ordering: Rose's exact sub-order for sections that need it
  const SECTION_TYPE_ORDER: Record<string, Record<string, number>> = {
    appendix_a_maps: { location_map: 1, plot_plan: 2 },
    appendix_b_photographs: { site_photograph: 1 },
    appendix_d_historical: { sanborn_map: 1, aerial_photograph: 2, topographic_map: 3, city_directory: 4, fire_insurance_map: 5 },
    appendix_e_agency_records: { agency_records: 1, regulatory_correspondence: 2, title_record: 3, tax_record: 4, building_permit: 5, client_correspondence: 6 },
  };

  const filesBySection: Record<string, FileRecord[]> = {};
  for (const s of SECTION_ORDER) {
    const sectionFiles = files.filter(f => f.section === s && !(f as any).excluded);
    // First: natural sort by filename
    sectionFiles.sort((a, b) =>
      a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' })
    );
    // Then: stable sort by document type priority (files of same type keep filename order)
    const typeOrder = SECTION_TYPE_ORDER[s];
    if (typeOrder) {
      sectionFiles.sort((a, b) => {
        const pa = typeOrder[a.documentType] ?? 99;
        const pb = typeOrder[b.documentType] ?? 99;
        if (pa !== pb) return pa - pb;
        return a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' });
      });
    }
    filesBySection[s] = sectionFiles;
  }

  // Default site location map: if no location_map uploaded for appendix_a_maps, use the template
  const hasLocationMap = (filesBySection['appendix_a_maps'] || []).some(
    f => f.documentType === 'location_map'
  );
  if (!hasLocationMap) {
    const cachedTemplatePdf = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'config', 'site-location-map-template.pdf');
    if (fs.existsSync(cachedTemplatePdf)) {
      // Copy the template into the project dir and add as a virtual file
      const destName = 'site-location-map-template.pdf';
      const destPath = path.join(dir, destName);
      if (!fs.existsSync(destPath)) {
        fs.copySync(cachedTemplatePdf, destPath);
      }
      const templateRecord: FileRecord = {
        filename: destName,
        uploadedAt: new Date().toISOString(),
        documentType: 'location_map',
        section: 'appendix_a_maps',
        label: 'Site Location Map (Default Template)',
        confidence: 1.0,
        reasoning: 'Default site location map template',
        needsReview: false,
        classifiedBy: 'system',
        pageCount: 0,
      };
      if (!filesBySection['appendix_a_maps']) filesBySection['appendix_a_maps'] = [];
      // Prepend so it appears before plot plans
      filesBySection['appendix_a_maps'].unshift(templateRecord);
      sendProgress({ phase: 'assembling', step: 'default_template', message: 'Using default site location map template (no custom map uploaded)' });
    }
  }

  const mainPdf = await PDFDocument.create();
  let pageCount = 0;
  let dividerPages = 0;
  let narrativePages = 0;
  const sectionManifest: AssemblyManifest['sections'] = [];
  const sectionPageStarts: Array<{ section: string; startPage: number }> = [];
  const filesSkipped: AssemblyManifest['filesSkipped'] = [];
  const filesErrored: AssemblyManifest['filesErrored'] = [];
  let filesAdded = 0;

  for (const section of SECTION_ORDER) {
    const sectionFiles = filesBySection[section] || [];
    const sectionStart = pageCount + 1;
    let sectionHasContent = false;

    // Insert AI narrative if available
    if (NARRATIVE_MAP[section] && fs.existsSync(path.join(narrativeDir, `${NARRATIVE_MAP[section]}.pdf`))) {
      sectionHasContent = true;
      sendProgress({ phase: 'assembling', step: 'narrative', section, message: `Adding AI-written ${section.replace(/_/g, ' ')}` });
      try {
        const nBytes = await fs.readFile(path.join(narrativeDir, `${NARRATIVE_MAP[section]}.pdf`));
        const nPdf = await PDFDocument.load(nBytes);
        const indices = nPdf.getPageIndices();
        const copied = await mainPdf.copyPages(nPdf, indices);
        for (const pg of copied) { mainPdf.addPage(pg); pageCount++; }
        narrativePages += indices.length;
      } catch (err) {
        const msg = `Failed to load narrative for ${section}: ${(err as Error).message}`;
        logger.warn(msg);
        sendProgress({ phase: 'assembling', step: 'warning', message: msg });
        filesErrored.push({ filename: `_narratives/${NARRATIVE_MAP[section]}.pdf`, error: (err as Error).message });
      }
    }

    if (sectionFiles.length === 0) {
      if (sectionHasContent) sectionPageStarts.push({ section, startPage: sectionStart });
      continue;
    }
    sectionHasContent = true;

    // Appendix divider — only use uploaded dividers, never auto-generate
    // (Rose uploads her own dividers; auto-generated ones duplicated content)

    // Add document files
    const secDocs: AssemblyManifest['sections'][0]['documents'] = [];
    for (const file of sectionFiles) {
      if ((file as any).conversionFailed) {
        const reason = `Conversion to PDF failed — original format: ${path.extname(file.filename)}`;
        filesSkipped.push({ filename: file.filename, reason });
        sendProgress({ phase: 'assembling', step: 'warning', file: file.filename, error: reason });
        continue;
      }
      if (!file.filename.toLowerCase().endsWith('.pdf')) {
        const reason = 'Non-PDF file skipped (conversion unavailable)';
        filesSkipped.push({ filename: file.filename, reason });
        sendProgress({ phase: 'assembling', step: 'warning', file: file.filename, error: reason });
        continue;
      }

      const filePath = path.join(dir, file.filename);
      if (!fs.existsSync(filePath)) {
        const error = `File not found: ${file.filename} — this indicates a pipeline error`;
        filesErrored.push({ filename: file.filename, error });
        logger.error({ file: file.filename, section }, 'Assembly: file not found');
        sendProgress({ phase: 'assembling', step: 'error', file: file.filename, error });
        continue;
      }

      sendProgress({ phase: 'assembling', step: 'document', file: file.filename });
      try {
        const pdfBytes = await fs.readFile(filePath);
        const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        const pdfPageCount = pdf.getPageCount();
        if (pdfPageCount === 0) {
          filesSkipped.push({ filename: file.filename, reason: 'PDF has 0 pages' });
          sendProgress({ phase: 'assembling', step: 'warning', file: file.filename, error: 'PDF has 0 pages — skipped' });
          continue;
        }
        const start = pageCount + 1;
        const indices = Array.from({ length: pdfPageCount }, (_, i) => i);
        const copied = await mainPdf.copyPages(pdf, indices);
        for (const pg of copied) { mainPdf.addPage(pg); pageCount++; }
        secDocs.push({ filename: file.filename, pageStart: start, pageEnd: pageCount, pages: pdfPageCount, label: file.label });
        filesAdded++;

        // Update file's pageCount metadata
        file.pageCount = pdfPageCount;
      } catch (err) {
        const error = (err as Error).message;
        filesErrored.push({ filename: file.filename, error });
        logger.warn({ file: file.filename, error }, 'Assembly: failed to embed PDF');
        sendProgress({ phase: 'assembling', step: 'warning', file: file.filename, error: `Skipped: ${error}` });
      }
    }
    if (secDocs.length) sectionManifest.push({ section, documents: secDocs });
    if (sectionHasContent) sectionPageStarts.push({ section, startPage: sectionStart });
  }

  // Insert Table of Contents
  if (sectionPageStarts.length > 0 && pageCount > 0) {
    sendProgress({ phase: 'assembling', step: 'toc', message: 'Generating Table of Contents' });
    const { tocPageCount } = await insertTableOfContents(mainPdf, sectionPageStarts, {
      propertyAddress: propertyAddress || '',
      reportDate: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    });
    if (tocPageCount > 0) {
      pageCount += tocPageCount;
      sendProgress({ phase: 'assembling', step: 'toc_done', message: `Table of Contents added (${tocPageCount} page${tocPageCount > 1 ? 's' : ''})` });
    }
  }

  // Assembly manifest — log every file's fate
  const manifest: AssemblyManifest = {
    assembledAt: new Date().toISOString(),
    totalPages: pageCount,
    sections: sectionManifest,
    dividerPages,
    generatedNarrativePages: narrativePages,
    filesAdded,
    filesSkipped,
    filesErrored,
  };

  // Log manifest summary
  logger.info({
    totalPages: pageCount, filesAdded,
    filesSkipped: filesSkipped.length, filesErrored: filesErrored.length,
    dividerPages, narrativePages,
  }, 'Assembly manifest');

  if (filesErrored.length > 0) {
    sendProgress({ phase: 'assembly_manifest', level: 'warning',
      message: `Assembly complete with ${filesErrored.length} error(s)`,
      filesAdded, filesSkipped: filesSkipped.length, filesErrored: filesErrored.length,
      errors: filesErrored,
    });
  } else {
    sendProgress({ phase: 'assembly_manifest', level: 'info',
      message: `Assembly complete: ${filesAdded} files, ${pageCount} pages`,
      filesAdded, filesSkipped: filesSkipped.length, filesErrored: 0,
    });
  }

  const pdfBytes = await mainPdf.save();
  return { pdfBytes: new Uint8Array(pdfBytes), manifest, sectionPageStarts };
}

// ── TOC Section Labels ────────────────────────────────────────────────────────
// Maps section IDs to human-readable TOC entry titles

const TOC_SECTION_LABELS: Record<string, { title: string; indent?: number }> = {
  front_cover: { title: 'Cover Page' },
  front_reliance: { title: 'Reliance Letter' },
  front_insurance: { title: 'Insurance Certificate' },
  body_executive_summary: { title: 'Executive Summary' },
  body_introduction: { title: '1.0 Introduction' },
  body_property_description: { title: '2.0 Property Description' },
  body_property_reconnaissance: { title: '3.0 Property Reconnaissance' },
  body_property_history: { title: '4.0 Property and Vicinity History' },
  body_records_research: { title: '5.0 Standard Environmental Records Research' },
  body_user_information: { title: '6.0 User Provided Information' },
  body_references: { title: '7.0 References' },
  body_findings_recommendations: { title: '8.0 Findings and Recommendations' },
  appendix_a_maps: { title: 'Appendix A — Site Location Map and Plot Plan', indent: 1 },
  appendix_b_photographs: { title: 'Appendix B — Site Photographs', indent: 1 },
  appendix_c_database_report: { title: 'Appendix C — Radius Map Report', indent: 1 },
  appendix_d_historical: { title: 'Appendix D — Historical Records', indent: 1 },
  appendix_e_agency_records: { title: 'Appendix E — Agency Records', indent: 1 },
  appendix_f_qualifications: { title: 'Appendix F — EP Qualifications', indent: 1 },
  appendix_i_additional: { title: 'Appendix G — Additional Documents', indent: 1 },
};

/**
 * Generate and insert a Table of Contents into an assembled PDF.
 * Inserts after front matter (cover, transmittal, etc.) and before the report body.
 * Adjusts all page references to account for the inserted TOC pages.
 */
async function insertTableOfContents(
  mainPdf: PDFDocument,
  sectionPageStarts: Array<{ section: string; startPage: number }>,
  projectInfo: { propertyAddress?: string; reportDate?: string },
): Promise<{ tocPageCount: number }> {
  // Find insert position — after last front matter section, before body
  const frontSections = new Set(['front_reliance', 'front_insurance', 'front_cover']);
  let insertAfterPage = 0;
  for (const entry of sectionPageStarts) {
    if (frontSections.has(entry.section)) {
      insertAfterPage = entry.startPage;
    }
  }
  // We want to insert after the front matter pages — find max page from front sections
  // by scanning forward through section starts
  let insertIndex = 0;
  for (const entry of sectionPageStarts) {
    if (frontSections.has(entry.section)) {
      // The next section's start page tells us where front matter ends
      const idx = sectionPageStarts.indexOf(entry);
      if (idx < sectionPageStarts.length - 1) {
        insertIndex = sectionPageStarts[idx + 1].startPage - 1;
      } else {
        insertIndex = mainPdf.getPageCount();
      }
    }
  }
  // If no front matter, insert at the beginning
  if (insertIndex <= 0) insertIndex = 0;

  // Build TOC entries — only include sections that actually have content
  const tocEntries: Array<{ title: string; pageNumber: number; indent?: number }> = [];
  for (const entry of sectionPageStarts) {
    const label = TOC_SECTION_LABELS[entry.section];
    if (!label) continue;
    // Skip front matter from TOC (cover page etc. aren't listed in a professional TOC)
    if (frontSections.has(entry.section)) continue;
    tocEntries.push({
      title: label.title,
      pageNumber: entry.startPage, // Will be adjusted after TOC insertion
      indent: label.indent,
    });
  }

  if (tocEntries.length === 0) return { tocPageCount: 0 };

  // Generate the TOC PDF
  const tocBuffer = await createTableOfContents(tocEntries, {
    propertyAddress: projectInfo.propertyAddress,
    reportDate: projectInfo.reportDate,
  });
  const tocPdf = await PDFDocument.load(tocBuffer);
  const tocPageCount = tocPdf.getPageCount();

  // Adjust page numbers in TOC entries to account for TOC pages being inserted
  // (pages after the insert point shift forward by tocPageCount)
  const adjustedEntries = tocEntries.map(e => ({
    ...e,
    pageNumber: e.pageNumber + tocPageCount,
  }));

  // Regenerate TOC with adjusted page numbers
  const adjustedTocBuffer = await createTableOfContents(adjustedEntries, {
    propertyAddress: projectInfo.propertyAddress,
    reportDate: projectInfo.reportDate,
  });
  const adjustedTocPdf = await PDFDocument.load(adjustedTocBuffer);

  // Insert TOC pages into the main PDF at the insert position
  const tocPages = await mainPdf.copyPages(adjustedTocPdf, adjustedTocPdf.getPageIndices());
  for (let i = 0; i < tocPages.length; i++) {
    mainPdf.insertPage(insertIndex + i, tocPages[i]);
  }

  return { tocPageCount };
}

const DOC_TYPE_LABELS: Record<string, string> = {
  cover_page: 'Cover Page',
  reliance_letter: 'Reliance Letter (SBA)', insurance_certificate: 'Insurance Certificate',
  report_body: 'Report Body',
  executive_summary: 'Executive Summary', location_map: 'Location Map',
  plot_plan: 'Plot Plan', site_photograph: 'Site Photographs',
  edr_report: 'EDR Radius Map Report', sanborn_map: 'Sanborn Maps',
  aerial_photograph: 'Aerial Photographs', topographic_map: 'Topographic Maps',
  city_directory: 'City Directory', agency_records: 'Agency Records',
  ep_qualifications: 'EP Qualifications', building_permit: 'Building Permits',
  other_unknown: 'Other/Unknown',
};

function heuristicClassify(filename: string): FileRecord {
  const fn = filename.toLowerCase();
  // Rules: [test, docType, section, label, confidence]
  // Higher confidence for strong/specific matches, lower for ambiguous
  // All heuristic matches get 0.95+ confidence — if the filename matches a known
  // pattern, we ARE confident. The AI classifier is only needed for ambiguous files.
  const rules: Array<[((f: string) => boolean), string, string, string, number]> = [
    // ── TIER 1: Front matter (very specific patterns) ──
    [f => /cover\s*(page)?/i.test(f) && !f.includes('appendix'), 'cover_page', 'front_cover', 'Cover Page', 0.95],
    [f => f.includes('reliance'), 'reliance_letter', 'front_reliance', 'Reliance Letter', 0.95],
    [f => f.includes('e&o') || f.includes('insurance') || f.includes('acord'), 'insurance_certificate', 'front_insurance', 'Insurance Certificate', 0.95],
    [f => f.includes('declaration'), 'ep_qualifications', 'appendix_f_qualifications', 'EP Declaration → Qualifications', 0.95],

    // ── TIER 2: Appendix-labeled documents (most specific — check before generic keywords) ──
    [f => /appendix\s*[a-f]\s*(cover|page|divider|-\s)/i.test(f), 'appendix_divider', 'appendix_i_additional', 'Appendix Divider', 0.95],
    [f => /appendix\s*c\b/i.test(f) && (f.includes('radius') || f.includes('database') || f.includes('edr')), 'edr_report', 'appendix_c_database_report', 'EDR Report', 0.95],
    [f => /appendix\s*d\b/i.test(f) && (f.includes('histor') || f.includes('record')), 'historical_records', 'appendix_d_historical', 'Historical Records', 0.95],
    // Photo appendix — matches "Appendix B" specifically OR any appendix containing photo/pic keywords
    [f => (/appendix\s*b\b/i.test(f) && (f.includes('photo') || f.includes('pic'))) ||
          (f.includes('appendix') && (f.includes('photo') || f.includes('pic'))), 'site_photograph', 'appendix_b_photographs', 'Site Photographs', 0.95],

    // ── TIER 3: Report body (high priority — "reviewed" write-ups are the main narrative) ──
    // Exclude files that contain photo/appendix keywords — those are photo appendices, not report bodies
    [f => (f.includes('reviewed') || f.includes('write up') || f.includes('writeup') || f.includes('write-up')) && !f.includes('photo') && !f.includes('pic'), 'report_body', 'body_introduction', 'Report Body (Reviewed)', 0.98],

    // ── TIER 4: Specific document type keywords ──
    [f => f.includes('qualification') || f.includes('resume') || f.includes('cv ') || f.includes('credentials'), 'ep_qualifications', 'appendix_f_qualifications', 'EP Qualifications', 0.95],
    [f => f.includes('edr') || f.includes('radius map') || f.includes('radius_map') || f.includes('envirostor') || f.includes('geotracker'), 'edr_report', 'appendix_c_database_report', 'EDR Report', 0.95],
    [f => f.includes('aerial') || f.includes('air photo') || f.includes('airphoto'), 'aerial_photograph', 'appendix_d_historical', 'Aerial Photographs', 0.95],
    [f => f.includes('sanborn') || (f.includes('fire') && f.includes('insurance') && f.includes('map')), 'sanborn_map', 'appendix_d_historical', 'Sanborn Maps', 0.95],
    [f => f.includes('topo') || f.includes('usgs') || f.includes('topograph'), 'topographic_map', 'appendix_d_historical', 'Topographic Maps', 0.95],
    [f => f.includes('city dir') || f.includes('city_dir') || f.includes('directory') || f.includes('polk') || f.includes('haines'), 'city_directory', 'appendix_d_historical', 'City Directory', 0.95],
    [f => /fire\s*(ins|map)/i.test(f) || f.includes('fire insurance') || f.includes('fire_insurance'), 'fire_insurance_map', 'appendix_d_historical', 'Fire Insurance Maps', 0.95],
    [f => f.includes('title') && (f.includes('record') || f.includes('search') || f.includes('report')), 'title_record', 'appendix_e_agency_records', 'Title Records', 0.95],
    [f => f.includes('lab result') || f.includes('analytical') || f.includes('sample') || f.includes('laboratory'), 'lab_results', 'appendix_e_agency_records', 'Lab Results', 0.95],
    [f => f.includes('plot plan') || f.includes('site plan') || f.includes('plot_plan') || f.includes('site_plan') || f.includes('floor plan'), 'plot_plan', 'appendix_a_maps', 'Plot Plan', 0.95],
    [f => f.includes('permit') || f.includes('building permit') || f.includes('building_permit'), 'building_permit', 'appendix_e_agency_records', 'Building Permits', 0.95],
    // Historical records catch-all
    [f => f.includes('histor') && (f.includes('map') || f.includes('aerial') || f.includes('record')), 'historical_records', 'appendix_d_historical', 'Historical Records', 0.90],

    // Prior/previous environmental reports — must come before generic 'report' catch-all in Tier 7
    [f => /phase\s?[12ii]|prior.*report|previous.*esa|remediation.*report/i.test(f), 'prior_environmental_report', 'appendix_i_additional', 'Prior Environmental Report', 0.93],
    [f => /boring\s?log|well\s?log|borehole|soil\s?boring/i.test(f), 'boring_log', 'appendix_h_boring_logs', 'Boring/Well Log', 0.93],
    [f => /executive\s?summ/i.test(f), 'executive_summary', 'body_executive_summary', 'Executive Summary', 0.95],
    [f => /transmittal/i.test(f), 'transmittal_letter', 'front_transmittal', 'Transmittal Letter', 0.95],

    // ── TIER 5: Broader keywords with exclusions (to avoid misclassification) ──
    // "photo" but NOT when combined with "record", "directory", "agency" (those are other doc types)
    [f => (f.includes('photo') || f.includes('pics') || f.includes('images')) && !f.includes('record') && !f.includes('directory') && !f.includes('agency'), 'site_photograph', 'appendix_b_photographs', 'Site Photographs', 0.95],
    [f => f.includes('location') || f.includes('loc map') || f.includes('site location'), 'location_map', 'appendix_a_maps', 'Location Map', 0.95],
    [f => f.includes('agency') || f.includes('dtsc') || f.includes('rwqcb'), 'agency_records', 'appendix_e_agency_records', 'Agency Records', 0.95],
    [f => f.includes('regulatory') || f.includes('correspondence') || f.includes('envirostor') || f.includes('geotracker'), 'regulatory_correspondence', 'appendix_e_agency_records', 'Regulatory Correspondence', 0.95],

    // Agency/health department records (SDCEH, AQMD, DEH, etc.)
    [f => f.includes('sdceh') || f.includes('aqmd') || f.includes('deh ') || f.includes('health'), 'agency_records', 'appendix_e_agency_records', 'Agency Records', 0.95],

    // "record" by itself — only if nothing more specific matched above
    [f => f.includes('record') && !f.includes('photo') && !f.includes('title'), 'agency_records', 'appendix_e_agency_records', 'Agency Records', 0.90],

    // Property detail / tax records
    [f => f.includes('property detail') || f.includes('tax') || f.includes('assessor'), 'title_record', 'appendix_e_agency_records', 'Property Records', 0.95],

    // ── TIER 6: File extension fallbacks ──
    // Visio files — typically site plans or plot plans
    [f => f.endsWith('.vsd') || f.endsWith('.vsdx'), 'plot_plan', 'appendix_a_maps', 'Site Plan (Visio)', 0.95],

    // Image files — if no keyword matched, images default to site photographs
    [f => f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png') || f.endsWith('.tif') || f.endsWith('.tiff'), 'site_photograph', 'appendix_b_photographs', 'Site Photograph', 0.90],

    // ── TIER 7: Catch-all report body (broadest match, last) ──
    [f => f.includes('report') || f.includes('esai') || f.includes('esa '), 'report_body', 'body_introduction', 'Report Body', 0.95],
  ];
  for (const [test, type, section, label, conf] of rules) {
    if (test(fn)) {
      return {
        filename, uploadedAt: new Date().toISOString(), documentType: type,
        section, label, confidence: conf, reasoning: `Filename pattern match: "${filename}"`,
        needsReview: conf < 0.90, classifiedBy: 'heuristic', pageCount: 0,
      };
    }
  }
  return {
    filename, uploadedAt: new Date().toISOString(), documentType: 'other_unknown',
    section: 'appendix_i_additional', label: 'Other/Unknown', confidence: 0.3,
    reasoning: 'No pattern matched', needsReview: true, classifiedBy: 'heuristic', pageCount: 0,
  };
}

async function createAppendixDivider(letter: string, title: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const { width, height } = page.getSize();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const green = rgb(15 / 255, 74 / 255, 46 / 255);
  page.drawRectangle({ x: 0, y: 0, width, height, color: green });
  const h = `APPENDIX ${letter}`;
  page.drawText(h, { x: (width - bold.widthOfTextAtSize(h, 48)) / 2, y: height / 2 + 40, size: 48, font: bold, color: rgb(1, 1, 1) });
  page.drawText(title, { x: (width - regular.widthOfTextAtSize(title, 22)) / 2, y: height / 2 - 30, size: 22, font: regular, color: rgb(0.85, 0.85, 0.85) });
  page.drawLine({ start: { x: width * 0.15, y: height / 2 + 100 }, end: { x: width * 0.85, y: height / 2 + 100 }, thickness: 1.5, color: rgb(1, 1, 1) });
  page.drawLine({ start: { x: width * 0.15, y: height / 2 - 70 }, end: { x: width * 0.85, y: height / 2 - 70 }, thickness: 1.5, color: rgb(1, 1, 1) });
  const footer = 'ODIC Environmental';
  page.drawText(footer, { x: (width - regular.widthOfTextAtSize(footer, 10)) / 2, y: 40, size: 10, font: regular, color: rgb(0.6, 0.6, 0.6) });
  return doc;
}

// ── Smart File Selection (Rose's Rules) ──────────────────────────────────────
// 1. When multiple revisions exist, pick the latest (e.g., "Reviewed (NK Revision 1)" > "Reviewed")
// 2. When a reviewer has merged files, use the merged version (e.g., "Aerials-mam" > individual aerials)
// 3. Skip duplicate/superseded files and move them to _superseded/

interface FileSelectionResult {
  selected: string[];      // Files to process
  superseded: string[];    // Files skipped (older revisions / unmerged originals)
  reasons: Record<string, string>; // Why each superseded file was skipped
}

function smartFileSelection(dir: string, filenames: string[]): FileSelectionResult {
  const selected: string[] = [];
  const superseded: string[] = [];
  const reasons: Record<string, string> = {};

  // Group files by their base document type (strip revision markers, suffixes)
  const groups: Map<string, string[]> = new Map();

  for (const fn of filenames) {
    const base = getFileGroupKey(fn);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base)!.push(fn);
  }

  for (const [groupKey, files] of groups) {
    if (files.length === 1) {
      selected.push(files[0]);
      continue;
    }

    // Multiple files in same group — apply selection rules
    const ranked = files.map(fn => ({ fn, score: fileSelectionScore(fn), mtime: getFileMtime(dir, fn) }))
      .sort((a, b) => b.score - a.score || b.mtime - a.mtime);

    // Check for merged files — a file with initials suffix (e.g., "Aerials-mam") is a merged version
    const merged = ranked.find(f => isMergedFile(f.fn));
    if (merged) {
      selected.push(merged.fn);
      for (const f of ranked) {
        if (f.fn !== merged.fn) {
          superseded.push(f.fn);
          reasons[f.fn] = `Superseded by merged file: ${merged.fn}`;
        }
      }
      continue;
    }

    // Check for revision files — pick highest revision
    const revised = ranked.find(f => hasRevisionMarker(f.fn));
    if (revised) {
      selected.push(revised.fn);
      for (const f of ranked) {
        if (f.fn !== revised.fn) {
          superseded.push(f.fn);
          reasons[f.fn] = `Superseded by revision: ${revised.fn}`;
        }
      }
      continue;
    }

    // No clear winner — pick the most recently modified
    selected.push(ranked[0].fn);
    for (let i = 1; i < ranked.length; i++) {
      superseded.push(ranked[i].fn);
      reasons[ranked[i].fn] = `Duplicate; using newer file: ${ranked[0].fn}`;
    }
  }

  return { selected, superseded, reasons };
}

/** Normalize filename to a group key for deduplication */
function getFileGroupKey(filename: string): string {
  let key = filename.toLowerCase();
  // Remove file extension
  key = key.replace(/\.(pdf|jpg|jpeg|png|tif|tiff|vsd|vsdx|doc|docx|xls|xlsx|ppt|pptx)$/i, '');
  // Remove compound reviewer suffix first: "-rev-mam", "-rev-nk" etc (reviewed-and-merged by initials)
  key = key.replace(/[-_]rev[-_][a-z]{2,4}$/i, '');
  // Remove revision markers: "(revised 1)", "(NK Revision 1)", "Revision 2", "Rev1", "rev 2", "_v2"
  key = key.replace(/\s*\(?\s*(nk\s+)?(revision|revised)\s*\d*\s*\)?/gi, '');
  key = key.replace(/\s*rev\s*\d+/gi, '');
  key = key.replace(/[_-]v\d+/gi, '');
  // Remove reviewer/author initials suffix (e.g., "-mam", "-nk", "-jdm" — 2-4 lowercase letters after dash)
  key = key.replace(/[-_][a-z]{2,4}$/i, '');
  // Remove "Reviewed" prefix/suffix variations
  key = key.replace(/\s*reviewed\s*/gi, '');
  // Normalize whitespace and separators
  key = key.replace(/[\s_-]+/g, ' ').trim();
  return key;
}

/** Score a file for selection priority (higher = prefer) */
function fileSelectionScore(filename: string): number {
  let score = 0;
  const fn = filename.toLowerCase();

  // Revision markers boost score — higher revision = higher score
  const revMatch = fn.match(/revision\s*(\d+)/i);
  if (revMatch) score += 100 + parseInt(revMatch[1], 10);

  // "Reviewed" is better than base
  if (fn.includes('reviewed')) score += 50;

  // Merged files (initials suffix like -mam, -nk) get highest priority
  if (isMergedFile(filename)) score += 200;

  // "Final" or "clean" versions are preferred over drafts
  if (fn.includes('final') || fn.includes('clean') || fn.includes('accepted')) score += 30;

  // Draft / markup / redline versions are penalized so finals always win
  if (fn.includes('draft') || fn.includes('markup') || fn.includes('redline') || fn.includes('tracked')) score -= 20;

  // Prefer PDF over convertible formats (dbf, doc, docx, vsd, etc.)
  if (fn.endsWith('.pdf')) score += 25;

  return score;
}

/** Check if a file looks like a reviewer-merged version (e.g., "Aerials-rev-mam.pdf", "Aerials-mam.pdf") */
function isMergedFile(filename: string): boolean {
  const fn = filename.replace(/\.(pdf|docx?|vsdx?)$/i, '');
  // Ends with -rev-initials compound (highest confidence: reviewed and merged by someone)
  if (/[-_]rev[-_][a-z]{2,4}$/i.test(fn)) return true;
  // Ends with dash/underscore + 2-4 lowercase initials
  return /[-_][a-z]{2,4}$/i.test(fn);
}

/** Check if a file has a revision marker */
function hasRevisionMarker(filename: string): boolean {
  return /revision\s*\d+/i.test(filename) || /rev\s*\d+/i.test(filename) || /[_-]v\d+/i.test(filename);
}

/** Get file modification time, or 0 if unavailable */
function getFileMtime(dir: string, filename: string): number {
  try { return fs.statSync(path.join(dir, filename)).mtimeMs; } catch { return 0; }
}

// ── Completeness Check ──────────────────────────────────────────────────────

interface CompletenessResult {
  complete: boolean;
  present: string[];
  missing: string[];
  warnings: string[];
}

// Document types to check for completeness — ALL are informational only.
// The pipeline always proceeds regardless of what's present or missing.
// Documents may be combined in a single file, embedded in the write-up,
// or named differently than expected — so nothing is flagged as "CRITICAL."
// Each entry can match by documentType, section assignment, or filename keywords.
// Items marked autoGenerated are created by the pipeline itself and should never
// appear as "missing" — they're excluded from the completeness check entirely.
const REQUIRED_DOCUMENT_TYPES: Array<{
  type: string; label: string; critical: boolean;
  sections?: string[];       // also counts as present if files exist in these sections
  filenameHints?: string[];  // also counts if any uploaded filename contains these (lowercase)
  autoGenerated?: boolean;   // pipeline creates these — never show as missing
}> = [
  { type: 'cover_page', label: 'Cover Page', critical: false, sections: ['front_cover'], filenameHints: ['cover'], autoGenerated: true },
  { type: 'reliance_letter', label: 'Reliance Letter', critical: false, sections: ['front_reliance'], filenameHints: ['reliance'], autoGenerated: true },
  { type: 'insurance_certificate', label: 'Insurance Certificate', critical: false, sections: ['front_insurance'], filenameHints: ['insurance', 'certificate'] },
  { type: 'report_body', label: 'Report Body / Write-up', critical: false, filenameHints: ['write-up', 'writeup', 'report_body', 'report body', 'write up'], autoGenerated: true },
  { type: 'location_map', label: 'Site Location Map', critical: false, sections: ['appendix_a_maps'], filenameHints: ['location', 'site map', 'site_map', 'vicinity'], autoGenerated: true },
  { type: 'plot_plan', label: 'Plot Plan', critical: false, sections: ['appendix_a_maps'], filenameHints: ['plot plan', 'plot_plan', 'floor plan', 'floor_plan'] },
  { type: 'site_photograph', label: 'Site Photographs', critical: false, sections: ['appendix_b_photographs'], filenameHints: ['photo', 'pics', 'images', 'site_photo', 'site photo'], autoGenerated: true },
  { type: 'edr_report', label: 'EDR Radius Map Report', critical: false, sections: ['appendix_c_database_report'], filenameHints: ['edr', 'radius map', 'radius_map', 'database report'] },
  { type: 'aerial_photograph', label: 'Aerial Photographs', critical: false, sections: ['appendix_d_historical'], filenameHints: ['aerial', 'air photo'] },
  { type: 'topographic_map', label: 'Topographic Maps', critical: false, sections: ['appendix_d_historical'], filenameHints: ['topo', 'usgs'] },
  { type: 'sanborn_map', label: 'Sanborn Maps', critical: false, sections: ['appendix_d_historical'], filenameHints: ['sanborn', 'fire insurance'] },
  { type: 'city_directory', label: 'City Directories', critical: false, sections: ['appendix_d_historical'], filenameHints: ['city dir', 'city_dir', 'polk', 'haines'] },
  { type: 'ep_qualifications', label: 'EP Qualifications', critical: false, sections: ['appendix_f_qualifications'], filenameHints: ['qualification', 'resume', 'credentials'], autoGenerated: true },
];

function checkCompleteness(files: FileRecord[]): CompletenessResult {
  const typeSet = new Set(files.map(f => f.documentType));
  const sectionSet = new Set(files.map(f => f.section));
  const filenames = files.map(f => f.filename.toLowerCase());
  const present: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const req of REQUIRED_DOCUMENT_TYPES) {
    // Skip items the pipeline auto-generates — never show as missing
    if (req.autoGenerated) {
      present.push(req.label);
      continue;
    }

    // Check 1: exact documentType match
    let found = typeSet.has(req.type);

    // Check 2: files assigned to the relevant section(s)
    if (!found && req.sections) {
      found = req.sections.some(s => sectionSet.has(s));
    }

    // Check 3: filename contains a keyword hint (catches .doc, .vsd, .xlsx etc.)
    if (!found && req.filenameHints) {
      found = filenames.some(fn => req.filenameHints!.some(hint => fn.includes(hint)));
    }

    if (found) {
      present.push(req.label);
    } else {
      missing.push(`${req.label}${req.critical ? ' (CRITICAL)' : ''}`);
      if (req.critical) warnings.push(`Missing critical document: ${req.label}`);
    }
  }

  return { complete: warnings.length === 0, present, missing, warnings };
}

const APPENDIX_INFO: Record<string, { letter: string; title: string }> = {
  appendix_a_maps: { letter: 'A', title: 'Site Location Map and Plot Plan' },
  appendix_b_photographs: { letter: 'B', title: 'Site Photographs' },
  appendix_c_database_report: { letter: 'C', title: 'Radius Map Report' },
  appendix_d_historical: { letter: 'D', title: 'Historical Records' },
  appendix_e_agency_records: { letter: 'E', title: 'Agency Records' },
  appendix_f_qualifications: { letter: 'F', title: 'EP Qualifications' },
  appendix_i_additional: { letter: 'G', title: 'Additional Documents' },
};

// Rose's exact assembly order depends on whether a reliance letter is present:
//
// WITH Reliance Letter (SBA loans):
// 1. Reliance → 2. E&O Insurance → 3. Cover → 4. Write-Up (body) → Appendix A–E → Additional → Appendix F
//
// WITHOUT Reliance Letter:
// 1. E&O Insurance → 2. Cover → 3. Write-Up (body) → Appendix A–E → Additional → Appendix F

function getSectionOrder(hasReliance: boolean): string[] {
  const bodyAndAppendices = [
    // Report body (write-up) comes right after front matter
    'body_introduction',
    'body_executive_summary',
    'body_findings_recommendations',
    'body_property_description',
    'body_property_reconnaissance',
    'body_property_history',
    'body_records_research',
    'body_user_information',
    'body_references',
    // Appendices A–E
    'appendix_a_maps',            // Appendix A — Property Location Map & Plot Plan
    'appendix_b_photographs',     // Appendix B — Property & Vicinity Photographs
    'appendix_c_database_report', // Appendix C — Database Report
    'appendix_d_historical',      // Appendix D — Historical Records Research
    'appendix_e_agency_records',  // Appendix E — Public Agency Records / Other Documents
    // Reports/Additional go after E, before F
    'appendix_i_additional',      // Additional reports & documents
    'appendix_f_qualifications',  // Appendix F — Qualifications of EP
  ];

  if (hasReliance) {
    return [
      'front_reliance',           // 1. Reliance Letter
      'front_insurance',          // 2. E&O Insurance
      'front_cover',              // 3. Cover Page
      ...bodyAndAppendices,
    ];
  }

  return [
    'front_insurance',            // 1. E&O Insurance
    'front_cover',                // 2. Cover Page
    ...bodyAndAppendices,
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', pipelineReady, aiEnabled: !!llm,
    ftp: ftpReceiver ? ftpReceiver.getStatus() : { running: false },
    timestamp: new Date().toISOString(),
  });
});

// List projects
app.get('/api/projects', async (req, res) => {
  try {
    if (!fs.existsSync('uploads')) return res.json({ projects: [] });
    const dirs = fs.readdirSync('uploads').filter(d => fs.statSync(path.join('uploads', d)).isDirectory());
    const projects = dirs.map(d => loadProject(d)).filter(Boolean).sort((a, b) =>
      new Date(b!.createdAt).getTime() - new Date(a!.createdAt).getTime()
    );
    res.json({ projects });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Create project
app.post('/api/projects', async (req, res) => {
  try {
    const id = uuidv4();
    fs.ensureDirSync(path.join('uploads', id));
    const project: ProjectState = {
      id, name: req.body.name || `Project ${id.slice(0, 8)}`,
      clientName: req.body.clientName || '', propertyAddress: req.body.propertyAddress || '',
      reportType: req.body.reportType || 'ESAI', isSbaLoan: req.body.isSbaLoan || false,
      reportDate: req.body.reportDate || new Date().toISOString().split('T')[0],
      epName: req.body.epName || 'Michael Miller',
      createdAt: new Date().toISOString(), status: 'new', files: [],
    };
    saveProject(id, project);
    if (pipelineReady) {
      state.createProject({ id, name: project.name, clientName: project.clientName,
        propertyAddress: project.propertyAddress, ftpPath: '', localPath: path.join('uploads', id) });
    }
    res.json({ projectId: id, project });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Get project
app.get('/api/projects/:id', async (req, res) => {
  try {
    const p = loadProject(req.params.id as string);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Upload files
app.post('/api/projects/:id/upload', upload.array('files', 50), async (req, res) => {
  try {
    const p = loadProject(req.params.id as string);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (!req.files || !(req.files as any[]).length) return res.status(400).json({ error: 'No files' });

    for (const file of req.files as Express.Multer.File[]) {
      let pc = 0;
      try { pc = await getPageCount(path.join('uploads', req.params.id as string, file.originalname)); } catch {}
      const rec: FileRecord = {
        filename: file.originalname, uploadedAt: new Date().toISOString(),
        documentType: 'other_unknown', section: 'appendix_i_additional',
        label: 'Pending Classification', confidence: 0, reasoning: 'Not yet classified',
        needsReview: true, classifiedBy: 'heuristic', pageCount: pc,
      };
      const idx = p.files.findIndex(f => f.filename === rec.filename);
      if (idx >= 0) p.files[idx] = rec; else p.files.push(rec);
    }
    p.status = 'uploaded';
    saveProject(req.params.id as string, p);
    res.json({ message: 'Uploaded', fileCount: (req.files as any[]).length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── AI Classification (SSE) ────────────────────────────────────────────────

app.post('/api/projects/:id/classify', async (req, res) => {
  try {
    const { id } = req.params;
    const p = loadProject(id);
    if (!p) return res.status(404).json({ error: 'Not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const dir = path.join('uploads', id);
    const CLASSIFY_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.vsd', '.vsdx']);
    const allFiles = fs.readdirSync(dir).filter(f => {
      if (f === 'assembled.pdf' || f.startsWith('.') || f.startsWith('_')) return false;
      return CLASSIFY_EXTENSIONS.has(path.extname(f).toLowerCase());
    });

    sendSSE(res, { status: 'starting', totalFiles: allFiles.length, aiEnabled: !!llm });
    p.status = 'classifying';
    saveProject(id, p);

    let usage: AIUsage = { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, classificationCalls: 0, writingCalls: 0 };
    let processed = 0;
    const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);

    for (const filename of allFiles) {
      const filePath = path.join(dir, filename);
      const fileExt = path.extname(filename).toLowerCase();
      const isImage = IMG_EXTS.has(fileExt);
      let record: FileRecord;

      // FAST PATH: heuristic first, AI only for unknowns
      record = heuristicClassify(filename);

      if (record.documentType === 'other_unknown' && llm && classifier && !isImage) {
        // Only attempt AI classification on PDFs (images can't be read by pdfReader)
        try {
          sendSSE(res, { status: 'reading', currentFile: filename, message: `Reading ${filename}...` });
          const readResult = await pdfReader.process({ filePath });
          if (!readResult.success) throw new Error(readResult.error);

          sendSSE(res, { status: 'classifying', currentFile: filename, message: `Filename not recognized — AI classifying ${filename}...` });
          const classResult = await classifier.process({
            readerOutput: readResult.data, docTypes,
            projectContext: {
              projectId: id, projectName: p.name, clientName: p.clientName,
              propertyAddress: p.propertyAddress, reportType: p.reportType, isSbaLoan: p.isSbaLoan,
            },
            filename,
          });
          if (!classResult.success) throw new Error(classResult.error);

          const ai = classResult.data;
          const cls = ai.classification;
          usage.totalInputTokens += ai.totalInputTokens;
          usage.totalOutputTokens += ai.totalOutputTokens;
          usage.totalCostUsd += ai.totalCostUsd;
          if (!ai.models.includes('heuristic')) usage.classificationCalls++;

          // Cross-property / embedded report detection
          const isEmbedded = cls.metadata?.is_embedded_report === 'true';
          const wrongProject = cls.projectIdDetected && cls.projectIdDetected !== id;
          if (isEmbedded || wrongProject) {
            record = {
              filename, uploadedAt: new Date().toISOString(),
              documentType: 'prior_environmental_report', section: 'appendix_i_additional',
              label: `Prior Report${cls.metadata?.embedded_report_property ? ` (${cls.metadata.embedded_report_property})` : ''}`,
              confidence: cls.confidence,
              reasoning: `⚠️ Different property/project detected: ${cls.reasoning}`,
              needsReview: true,
              classifiedBy: ai.usedEscalation ? 'sonnet' : 'haiku',
              pageCount: cls.pageCount,
            };
          } else {
            record = {
              filename, uploadedAt: new Date().toISOString(),
              documentType: cls.documentType, section: cls.suggestedSection,
              label: DOC_TYPE_LABELS[cls.documentType] || cls.documentType,
              confidence: cls.confidence, reasoning: cls.reasoning,
              needsReview: cls.needsManualReview,
              classifiedBy: ai.models.includes('heuristic') ? 'heuristic' : ai.usedEscalation ? 'sonnet' : 'haiku',
              pageCount: cls.pageCount,
            };
          }
        } catch (err) {
          logger.error({ filename, error: (err as Error).message }, 'AI classification failed — keeping heuristic result');
        }
      }

      const idx = p.files.findIndex(f => f.filename === filename);
      if (idx >= 0) p.files[idx] = record; else p.files.push(record);
      processed++;

      sendSSE(res, {
        status: 'classified', processedCount: processed, totalFiles: allFiles.length,
        currentFile: filename,
        classification: { documentType: record.documentType, section: record.section,
          label: record.label, confidence: record.confidence, classifiedBy: record.classifiedBy },
        progress: Math.round((processed / allFiles.length) * 100),
      });
    }

    p.scorecard = buildScorecard(p.files);
    p.aiUsage = usage;
    p.status = 'classified';
    saveProject(id, p);

    // Cross-property spot check
    try {
      const crossCheck = await crossPropertySpotCheck({
        files: p.files, projectId: id, project: p, dir,
        sendProgress: (event: any) => sendSSE(res, event),
      });
      if (crossCheck.flagged.length > 0) {
        p.scorecard = buildScorecard(p.files);
        saveProject(id, p);
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Cross-property spot check failed — continuing');
    }

    sendSSE(res, { status: 'completed', totalFiles: allFiles.length, scorecard: p.scorecard, aiUsage: usage });
    res.end();
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Manual Override ─────────────────────────────────────────────────────────

app.post('/api/projects/:id/classify-override', async (req, res) => {
  try {
    const p = loadProject(req.params.id as string);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const { filename, documentType, section } = req.body;
    const idx = p.files.findIndex(f => f.filename === filename);
    if (idx < 0) return res.status(404).json({ error: 'File not found' });

    p.files[idx].documentType = documentType;
    p.files[idx].section = section;
    p.files[idx].label = DOC_TYPE_LABELS[documentType] || documentType;
    p.files[idx].classifiedBy = 'manual';
    p.files[idx].confidence = 1.0;
    p.files[idx].needsReview = false;
    p.files[idx].reasoning = 'Manually overridden';
    p.scorecard = buildScorecard(p.files);
    saveProject(req.params.id as string, p);
    res.json({ message: 'Override applied', file: p.files[idx] });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Review Classifications & Continue Pipeline (SSE) ─────────────────────

app.post('/api/projects/:id/review-classifications', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const id = req.params.id as string;
    const project = loadProject(id);
    if (!project) { sendSSE(res, { phase: 'error', error: 'Project not found' }); res.end(); return; }

    const dir = path.join('uploads', id);
    const { files: updatedFiles } = req.body as { files: Array<{ filename: string; documentType: string; section: string }> };

    // Apply classification overrides from the review UI
    if (updatedFiles && updatedFiles.length > 0) {
      for (const update of updatedFiles) {
        const idx = project.files.findIndex(f => f.filename === update.filename);
        if (idx >= 0) {
          project.files[idx].documentType = update.documentType;
          project.files[idx].section = update.section;
          project.files[idx].label = DOC_TYPE_LABELS[update.documentType] || update.documentType;
          project.files[idx].classifiedBy = 'manual';
          project.files[idx].confidence = 1.0;
          project.files[idx].needsReview = false;
          project.files[idx].reasoning = 'Manually reviewed';
        }
      }
      project.scorecard = buildScorecard(project.files);
      saveProject(id, project);
    }

    sendSSE(res, { phase: 'review_accepted', message: 'Classifications approved — continuing pipeline...' });

    // ── Cross-Property Spot Check ──
    try {
      const crossCheck = await crossPropertySpotCheck({
        files: project.files, projectId: id, project, dir,
        sendProgress: (event: any) => sendSSE(res, event),
      });
      if (crossCheck.flagged.length > 0) {
        project.scorecard = buildScorecard(project.files);
        saveProject(id, project);
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Cross-property spot check failed — continuing');
    }

    // ── Convert non-PDF files ──
    const reviewNonPdfFiles = project.files.filter(file => path.extname(file.filename).toLowerCase() !== '.pdf' && fs.existsSync(path.join(dir, file.filename)));
    if (reviewNonPdfFiles.length > 0) {
      const pLimitReviewConvert = (await import('p-limit')).default;
      const reviewConvertLimit = pLimitReviewConvert(3);
      await Promise.allSettled(
        reviewNonPdfFiles.map(file => reviewConvertLimit(async () => {
          const filePath = path.join(dir, file.filename);
          sendSSE(res, { phase: 'processing', message: `Converting ${file.filename} to PDF...` });
          const pdfPath = await convertToPdf(filePath, dir);
          if (pdfPath) {
            file.filename = path.basename(pdfPath);
            try { file.pageCount = await getPageCount(pdfPath); } catch {}
          } else {
            (file as any).conversionFailed = true;
            sendSSE(res, { phase: 'warning', message: `Cannot convert ${file.filename} — will be excluded from assembly` });
          }
        }))
      );
    }
    saveProject(id, project);

    // ── Assemble Final PDF ──
    sendSSE(res, { phase: 'assembling', message: 'Assembling final report PDF...' });

    const assemblyResult = await assembleReport({
      dir, files: project.files, propertyAddress: project.propertyAddress,
      sendProgress: (event) => sendSSE(res, event),
    });

    if (assemblyResult.manifest.totalPages === 0) {
      sendSSE(res, { phase: 'error', error: 'Assembly produced 0 pages — no documents available.' });
      res.end();
      return;
    }

    const assembledPath = path.join(dir, 'assembled.pdf');
    await fs.writeFile(assembledPath, assemblyResult.pdfBytes);

    project.manifest = assemblyResult.manifest;
    project.status = 'assembled';
    saveProject(id, project);

    // ── Post-assembly: Compress → Split → QC ──
    const { compressedSizeMB, splitParts, qcResult, aiQcResult } = await postAssembly({
      assembledPath, project, projectId: id, dir, res,
    });

    sendSSE(res, {
      phase: 'done', projectId: id,
      totalPages: assemblyResult.manifest.totalPages,
      narrativePages: assemblyResult.manifest.generatedNarrativePages,
      dividerPages: assemblyResult.manifest.dividerPages,
      scorecard: project.scorecard, aiUsage: project.aiUsage, manifest: project.manifest,
      compressedSizeMB: +compressedSizeMB.toFixed(1),
      splitParts: splitParts.length > 0 ? splitParts : undefined,
      qcResult: qcResult ? { passed: qcResult.passed, score: qcResult.score, summary: qcResult.summary, checks: qcResult.checks } : undefined,
      aiQcResult: aiQcResult || undefined,
      downloadUrl: `/api/projects/${id}/download`,
    });
    res.end();
  } catch (e: any) {
    logger.error({ error: (e as Error).message }, 'Review-classifications pipeline failed');
    sendSSE(res, { phase: 'error', error: (e as Error).message });
    res.end();
  }
});

// ── Pre-Assembly Checklist ────────────────────────────────────────────────

app.post('/api/projects/:id/pre-check', async (req, res) => {
  try {
    const p = loadProject(req.params.id as string);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const dir = path.join('uploads', req.params.id as string);

    const { QCCheckerSkill } = await import('./skills/qc-checker.js');
    const qc = new QCCheckerSkill(config);
    const qcOutput = await qc.process({
      projectDir: dir,
      files: p.files.map(f => ({
        filename: f.filename, documentType: f.documentType,
        label: f.label, section: f.section, confidence: f.confidence,
      })),
      projectInfo: {
        propertyAddress: p.propertyAddress || '',
        clientName: p.clientName || '',
        reportType: p.reportType,
        epName: p.epName,
      },
    });

    if (!qcOutput.success) return res.status(500).json({ error: qcOutput.error || 'QC check failed' });
    const result = qcOutput.data;
    res.json({
      passed: result.passed, score: result.score,
      summary: result.summary, checks: result.checks,
      recordsAnalysis: result.recordsAnalysis,
      recordsTriage: result.recordsTriage,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── File Management: Replace ─────────────────────────────────────────────

app.post('/api/projects/:id/files/:filename/replace', upload.single('file'), async (req, res) => {
  try {
    const p = loadProject(req.params.id as string);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const filename = req.params.filename as string;
    const idx = p.files.findIndex(f => f.filename === filename);
    if (idx < 0) return res.status(404).json({ error: 'File not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const dir = path.join('uploads', req.params.id as string);
    const destPath = path.join(dir, filename);
    await fs.move(req.file.path, destPath, { overwrite: true });

    p.files[idx].uploadedAt = new Date().toISOString();
    try { p.files[idx].pageCount = await getPageCount(destPath); } catch { /* keep old pageCount */ }

    saveProject(req.params.id as string, p);
    res.json({ message: 'File replaced', file: p.files[idx] });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── File Management: Remove (toggle exclusion) ──────────────────────────

app.post('/api/projects/:id/files/:filename/remove', async (req, res) => {
  try {
    const p = loadProject(req.params.id as string);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const filename = req.params.filename as string;
    const idx = p.files.findIndex(f => f.filename === filename);
    if (idx < 0) return res.status(404).json({ error: 'File not found' });

    const body = req.body || {};
    const current = (p.files[idx] as any).excluded === true;
    const newVal = body.excluded !== undefined ? Boolean(body.excluded) : !current;
    (p.files[idx] as any).excluded = newVal;

    saveProject(req.params.id as string, p);
    res.json({ message: current ? 'File re-included' : 'File excluded', file: p.files[idx] });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── File Management: Move (reassign section) ────────────────────────────

app.post('/api/projects/:id/files/:filename/move', async (req, res) => {
  try {
    const p = loadProject(req.params.id as string);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const filename = req.params.filename as string;
    const { section } = req.body;
    if (!section) return res.status(400).json({ error: 'section is required' });
    const idx = p.files.findIndex(f => f.filename === filename);
    if (idx < 0) return res.status(404).json({ error: 'File not found' });

    p.files[idx].section = section;
    p.files[idx].classifiedBy = 'manual';
    p.scorecard = buildScorecard(p.files);
    saveProject(req.params.id as string, p);
    res.json({ message: 'File moved', file: p.files[idx] });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── AI Report Writing (SSE) ────────────────────────────────────────────────

app.post('/api/projects/:id/write-narrative', async (req, res) => {
  try {
    const { id } = req.params;
    const p = loadProject(id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (!llm) return res.status(503).json({ error: 'AI not available' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    p.status = 'writing';
    saveProject(id, p);
    sendSSE(res, { status: 'starting', message: 'Starting AI report writing...' });

    const dir = path.join('uploads', id);
    const narrativeDir = path.join(dir, '_narratives');
    await ensureDir(narrativeDir);

    // Extract key data from important documents
    const extractedData: Record<string, string> = {};
    for (const file of p.files) {
      if (['edr_report', 'agency_records', 'report_body', 'regulatory_correspondence'].includes(file.documentType)) {
        try {
          const r = await pdfReader.process({ filePath: path.join(dir, file.filename), maxTextPages: 20 });
          if (r.success) extractedData[file.filename] = r.data.combinedText.substring(0, 15000);
        } catch {}
      }
    }

    sendSSE(res, { status: 'extracted', message: `Extracted data from ${Object.keys(extractedData).length} documents` });

    const sections = [
      { id: 'executive_summary', title: 'Executive Summary & Findings' },
      { id: 'introduction', title: '1.0 Introduction' },
      { id: 'property_description', title: '2.0 Property Description' },
      { id: 'property_reconnaissance', title: '3.0 Property Reconnaissance' },
      { id: 'property_history', title: '4.0 Property and Vicinity History' },
      { id: 'records_research', title: '5.0 Standard Environmental Records Research' },
      { id: 'user_information', title: '6.0 User Provided Information' },
      { id: 'references', title: '7.0 References' },
    ];

    let writingCost = 0;

    // Build doc inventory once (shared across all sections — read-only)
    const docTypeCounts2: Record<string, number> = {};
    for (const f of p.files) {
      const lbl = f.label || f.documentType;
      docTypeCounts2[lbl] = (docTypeCounts2[lbl] || 0) + 1;
    }
    const docInventory2 = Object.entries(docTypeCounts2).map(([t, c]) => `${t}: ${c}`).join(', ');
    const docList2 = p.files.map(f => `- ${f.filename}: ${f.label} [${f.documentType}]`).join('\n');
    const extractedText2 = Object.entries(extractedData).map(([fn, t]) => `--- ${fn} ---\n${t.substring(0, 3000)}`).join('\n\n');

    const pLimitWriteNarrative = (await import('p-limit')).default;
    const writeNarrativeLimit = pLimitWriteNarrative(3); // 3 concurrent claude spawns

    await Promise.allSettled(
      sections.map(sec => writeNarrativeLimit(async () => {
      sendSSE(res, { status: 'writing', section: sec.id, message: `Writing ${sec.title}...` });

      try {
        const system = `You are writing a Phase I Environmental Site Assessment report for ODIC Environmental following ASTM E1527-21. Write in professional, technical ESA style.

IMPORTANT: Write in plain text only. Do NOT use any markdown formatting — no #, ##, **, *, -, bullet points, or other markup. Use natural language paragraphs and numbered subsections (e.g. "1.1 Purpose"). For lists, write them as prose or use simple indented lines. This text will be rendered directly into a PDF as-is.

Company: ODIC Environmental, 407 West Imperial Suite H #303, Brea, CA 92821
Property: ${p.propertyAddress}
Client: ${p.clientName}
Report Type: ${p.reportType}
Date: ${p.reportDate}
EP: ${p.epName}

Write ONLY the "${sec.title}" section. Be thorough and reference document findings.`;

        const user = `Write "${sec.title}" for this ESA report. Remember: plain text only, no markdown.

Project: ${p.name}
Property: ${p.propertyAddress}

Document Inventory: ${docInventory2}

Documents:
${docList2}

Key document data:
${extractedText2}`;

        const result = await llm.generateText(system, user);
        writingCost += result.costUsd;

        // Save text only — no auto-generated narrative PDFs (Rose uploads her own report body)
        await fs.writeFile(path.join(narrativeDir, `${sec.id}.txt`), result.data);

        sendSSE(res, { status: 'section_complete', section: sec.id, title: sec.title,
          wordCount: result.data.split(/\s+/).length, costUsd: result.costUsd.toFixed(4) });
      } catch (err) {
        logger.error({ section: sec.id, error: (err as Error).message }, 'Write failed');
        sendSSE(res, { status: 'section_error', section: sec.id, error: (err as Error).message });
      }
      }))
    );

    if (p.aiUsage) {
      p.aiUsage.writingCalls = sections.length;
      p.aiUsage.totalCostUsd += writingCost;
    }
    p.status = 'classified';
    saveProject(id, p);

    sendSSE(res, { status: 'completed', message: 'Narrative writing complete', totalCostUsd: writingCost.toFixed(4) });
    res.end();
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Assembly (SSE) ─────────────────────────────────────────────────────────

app.post('/api/projects/:id/assemble', async (req, res) => {
  try {
    const { id } = req.params;
    const p = loadProject(id);
    if (!p) return res.status(404).json({ error: 'Not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    sendSSE(res, { status: 'starting', message: 'Beginning assembly' });
    p.status = 'assembling';
    saveProject(id, p);

    const dir = path.join('uploads', id);

    // Convert non-PDF files to PDF before assembly
    for (const file of p.files) {
      const ext = path.extname(file.filename).toLowerCase();
      if (ext !== '.pdf') {
        const filePath = path.join(dir, file.filename);
        if (fs.existsSync(filePath)) {
          sendSSE(res, { status: 'processing', message: `Converting ${file.filename} to PDF...` });
          const pdfPath = await convertToPdf(filePath, dir);
          if (pdfPath) {
            file.filename = path.basename(pdfPath);
            try { file.pageCount = await getPageCount(pdfPath); } catch {}
          } else {
            (file as any).conversionFailed = true;
            sendSSE(res, { status: 'warning', message: `Cannot convert ${file.filename} — will be excluded from assembly` });
          }
        }
      }
    }
    saveProject(id, p);

    // Auto-generated front matter removed — Rose uploads her own covers,
    // insurance certificates, reliance letters, and photos. No placeholders needed.

    sendSSE(res, { status: 'processing', message: 'Assembling final report PDF...' });

    const assemblyResult = await assembleReport({
      dir, files: p.files, propertyAddress: p.propertyAddress,
      sendProgress: (event) => sendSSE(res, event),
    });

    if (assemblyResult.manifest.totalPages === 0) {
      sendSSE(res, { status: 'error', error: 'Assembly produced 0 pages — no documents or narratives available. Upload files and classify before assembling.' });
      res.end();
      return;
    }

    const assembledPath = path.join(dir, 'assembled.pdf');
    await fs.writeFile(assembledPath, assemblyResult.pdfBytes);

    p.manifest = assemblyResult.manifest;
    p.status = 'assembled';
    saveProject(id, p);

    // ── Post-assembly: Compress → Split → QC ──
    const { compressedSizeMB, splitParts, qcResult, aiQcResult } = await postAssembly({
      assembledPath, project: p, projectId: id, dir, res,
    });

    sendSSE(res, { status: 'completed', message: 'Assembly complete',
      downloadUrl: `/api/projects/${id}/download`, manifest: p.manifest, scorecard: p.scorecard,
      compressedSizeMB: +compressedSizeMB.toFixed(1),
      splitParts: splitParts.length > 0 ? splitParts : undefined,
      qcResult: qcResult ? { passed: qcResult.passed, score: qcResult.score, summary: qcResult.summary, checks: qcResult.checks } : undefined,
      aiQcResult: aiQcResult || undefined,
    });
    res.end();
  } catch (e: any) {
    sendSSE(res, { status: 'error', error: e.message });
    res.end();
  }
});

// Download
app.get('/api/projects/:id/download', async (req, res) => {
  try {
    const partFile = req.query.part as string | undefined;
    const projectDir = path.join('uploads', req.params.id as string);
    const p = loadProject(req.params.id as string);
    const baseName = p?.name ? p.name.replace(/\s+/g, '_') : 'report';

    if (partFile) {
      // Download a specific split part
      const safePart = path.basename(partFile); // prevent path traversal
      const fp = path.join(projectDir, safePart);
      if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Part not found' });
      res.download(fp, `${baseName}_${safePart}`);
    } else {
      const fp = path.join(projectDir, 'assembled.pdf');
      if (!fs.existsSync(fp)) return res.status(404).json({ error: 'No assembled PDF' });
      res.download(fp, `${baseName}_report.pdf`);
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Autonomous Pipeline (SSE) — Upload → Classify → Write → Assemble ────

const autoUploadStorage = multer({
  dest: path.join('uploads', '_tmp'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 100 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.pdf', '.zip', '.vsd', '.vsdx', '.doc', '.docx', '.xls', '.xlsx', '.dbf', '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic'];
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not supported`));
    }
  },
});

/** Supported file extensions for extraction from ZIPs and classification */
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic', '.vsd', '.vsdx', '.doc', '.docx', '.xls', '.xlsx', '.dbf']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic']);

/**
 * Subfolder name patterns that indicate raw regulatory database dump folders.
 * Files inside these directories are not standalone ESA documents — they are bulk
 * database record exports that should not be individually assembled into the report.
 */
const REGULATORY_DUMP_FOLDER_PATTERNS = [
  /^EC_Attachments/i,
  /^Geotracker[_ ]Records/i,
  /^Geotracker$/i,
  /^BLA-/i,
  /^SMEH__/i,
  /^HZMT$/i,
  /^HZMT_/i,
  /^LUST/i,
  /^UST[_-]/i,
  /^Cortese/i,
];

/** Returns true if the entry path passes through a regulatory dump subfolder. */
function isInRegulatoryDumpFolder(entryName: string): boolean {
  const parts = entryName.split('/');
  // Check all path components except the last (filename)
  for (let i = 0; i < parts.length - 1; i++) {
    if (REGULATORY_DUMP_FOLDER_PATTERNS.some(re => re.test(parts[i]))) return true;
  }
  return false;
}

interface ZipExtractionResult {
  filenames: string[];
  skippedRegulatory: Array<{ folder: string; count: number }>;
  skippedPreassembled: string[];
}

/** Extract supported files (PDFs + images + Visio) from a ZIP into the target directory. */
function extractFilesFromZip(zipPath: string, targetDir: string): ZipExtractionResult {
  const MAX_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024; // 2GB total limit
  const MAX_ENTRIES = 1000;

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const extracted: string[] = [];
  let totalExtracted = 0;
  const regulatoryFolderCounts: Record<string, number> = {};
  const skippedPreassembled: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (extracted.length >= MAX_ENTRIES) {
      logger.warn({ zip: zipPath, limit: MAX_ENTRIES }, 'ZIP entry limit reached — remaining files skipped');
      break;
    }
    const entrySize = entry.header.size || 0;
    if (totalExtracted + entrySize > MAX_EXTRACT_BYTES) {
      logger.warn({ zip: zipPath, limitMB: MAX_EXTRACT_BYTES / (1024 * 1024) }, 'ZIP extraction size limit reached');
      break;
    }

    // Get basename — flattens nested folders (e.g. "Reports/Aerials/photo.pdf" → "photo.pdf")
    const name = path.basename(entry.entryName);
    if (!name || name.length === 0) continue;
    const ext = path.extname(name).toLowerCase();
    // Skip hidden files, __MACOSX junk, unsupported formats
    if (name.startsWith('.') || name.startsWith('__') || entry.entryName.includes('__MACOSX') || !SUPPORTED_EXTENSIONS.has(ext)) continue;

    // Skip pre-assembled report PDFs (e.g. "6384674-ESAI-REPORT_compressed.pdf")
    if (ext === '.pdf' && /REPORT_compressed|_REPORT\./i.test(name)) {
      skippedPreassembled.push(name);
      logger.info({ file: name }, 'ZIP: skipping pre-assembled report file');
      continue;
    }

    // Skip files inside regulatory database dump subfolders
    if (isInRegulatoryDumpFolder(entry.entryName)) {
      const parts = entry.entryName.split('/');
      const folderName = parts.slice(0, -1).find(p => REGULATORY_DUMP_FOLDER_PATTERNS.some(re => re.test(p))) || 'unknown';
      regulatoryFolderCounts[folderName] = (regulatoryFolderCounts[folderName] || 0) + 1;
      continue;
    }

    // Use folder path as prefix hint to preserve context (e.g. "Permits/building_permit.pdf" → "Permits_building_permit.pdf")
    const dirParts = path.dirname(entry.entryName).split('/').filter(p => p && p !== '.' && !p.startsWith('__'));
    const prefixedName = dirParts.length > 0 ? `${dirParts.join('_')}_${name}` : name;

    const dest = path.join(targetDir, prefixedName);
    // Avoid overwriting — append number if collision
    let finalDest = dest;
    let counter = 1;
    while (fs.existsSync(finalDest)) {
      const parsed = path.parse(prefixedName);
      finalDest = path.join(targetDir, `${parsed.name}_${counter}${parsed.ext}`);
      counter++;
    }

    fs.writeFileSync(finalDest, entry.getData());
    extracted.push(path.basename(finalDest));
    totalExtracted += entrySize;
  }

  const skippedRegulatory = Object.entries(regulatoryFolderCounts).map(([folder, count]) => ({ folder, count }));
  if (skippedRegulatory.length > 0) {
    logger.info({ skippedRegulatory }, 'ZIP: skipped regulatory dump subfolder files');
  }

  return { filenames: extracted, skippedRegulatory, skippedPreassembled };
}

// Ensure temp upload dir exists before multer writes to it
app.use('/api/auto-pipeline', (req, res, next) => { fs.ensureDirSync(path.join('uploads', '_tmp')); next(); });

app.post('/api/auto-pipeline', autoUploadStorage.array('files', 50), async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    if (!req.files || !(req.files as any[]).length) {
      sendSSE(res, { phase: 'error', error: 'No files uploaded' });
      res.end();
      return;
    }

    const uploadedFiles = req.files as Express.Multer.File[];

    // ── Phase 1: Create project automatically ──
    const id = uuidv4();
    const dir = path.join('uploads', id);
    fs.ensureDirSync(dir);

    // Move uploaded files into project directory and extract ZIPs
    const allFilenames: string[] = [];
    const allSkippedRegulatory: Array<{ folder: string; count: number }> = [];
    const allSkippedPreassembled: string[] = [];

    for (const file of uploadedFiles) {
      const ext = path.extname(file.originalname).toLowerCase();

      if (ext === '.zip') {
        // Extract all supported files from ZIP (PDFs, images, Visio)
        logger.info({ zip: file.originalname }, 'Extracting files from ZIP');
        const extracted = extractFilesFromZip(file.path, dir);
        allFilenames.push(...extracted.filenames);
        allSkippedRegulatory.push(...extracted.skippedRegulatory);
        allSkippedPreassembled.push(...extracted.skippedPreassembled);
        // Remove the temp ZIP
        try { fs.removeSync(file.path); } catch {}
      } else {
        // PDF, VSD, images, Office docs — move to project dir
        const dest = path.join(dir, file.originalname);
        if (file.path !== dest) {
          fs.moveSync(file.path, dest, { overwrite: true });
        }
        allFilenames.push(file.originalname);
      }
    }

    // Clean up stale temp files (but keep the _tmp directory for future uploads)
    const undefinedDir = path.join('uploads', 'undefined');
    if (fs.existsSync(undefinedDir)) { try { fs.removeSync(undefinedDir); } catch {} }
    const tmpDir = path.join('uploads', '_tmp');
    if (fs.existsSync(tmpDir)) {
      try {
        const tmpFiles = fs.readdirSync(tmpDir);
        for (const f of tmpFiles) { try { fs.removeSync(path.join(tmpDir, f)); } catch {} }
      } catch {}
    }

    const fileCount = allFilenames.length;
    if (fileCount === 0) {
      sendSSE(res, { phase: 'error', error: 'No supported files found in upload' });
      res.end();
      return;
    }

    const totalSkippedRegulatory = allSkippedRegulatory.reduce((s, r) => s + r.count, 0);
    const extractMsg = totalSkippedRegulatory > 0
      ? `Found ${fileCount} documents (excluded ${totalSkippedRegulatory} raw regulatory dump files from ${allSkippedRegulatory.map(r => r.folder).join(', ')})`
      : `Found ${fileCount} documents`;
    sendSSE(res, { phase: 'extracting', message: extractMsg, fileCount });

    if (allSkippedPreassembled.length > 0) {
      sendSSE(res, { phase: 'warning', message: `Excluded pre-assembled report from ZIP: ${allSkippedPreassembled.join(', ')}` });
    }
    if (allSkippedRegulatory.length > 0) {
      sendSSE(res, {
        phase: 'zip_exclusions',
        message: `Excluded ${totalSkippedRegulatory} raw regulatory database files from assembly`,
        excluded: allSkippedRegulatory,
      });
    }

    // ── Smart File Selection (Rose's Rules) ──
    const selection = smartFileSelection(dir, allFilenames);

    if (selection.superseded.length > 0) {
      // Move superseded files to _superseded/
      const supersededDir = path.join(dir, '_superseded');
      fs.ensureDirSync(supersededDir);
      for (const fn of selection.superseded) {
        try { fs.moveSync(path.join(dir, fn), path.join(supersededDir, fn), { overwrite: true }); } catch {}
      }
      sendSSE(res, {
        phase: 'file_selection', message: `Smart selection: using ${selection.selected.length} files, skipped ${selection.superseded.length} superseded`,
        selected: selection.selected.length, superseded: selection.superseded.length,
        skippedFiles: selection.superseded.map(fn => ({ filename: fn, reason: selection.reasons[fn] })),
      });
    }

    const activeFiles = selection.selected;

    const project: ProjectState = {
      id, name: `Auto-${id.slice(0, 8)}`,
      clientName: '', propertyAddress: '',
      reportType: 'ESAI', isSbaLoan: false,
      reportDate: new Date().toISOString().split('T')[0],
      epName: 'Michael Miller',
      createdAt: new Date().toISOString(), status: 'new', files: [],
    };

    // Get page counts for selected files (PDFs get page count, images count as 1 page)
    for (const filename of activeFiles) {
      let pc = 0;
      const ext = path.extname(filename).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        pc = 1; // Each image file is effectively 1 page
      } else {
        try { pc = await getPageCount(path.join(dir, filename)); } catch {}
      }
      project.files.push({
        filename, uploadedAt: new Date().toISOString(),
        documentType: 'other_unknown', section: 'appendix_i_additional',
        label: 'Pending', confidence: 0, reasoning: '',
        needsReview: true, classifiedBy: 'pending', pageCount: pc,
      });
    }

    saveProject(id, project);
    if (pipelineReady && state) {
      state.createProject({ id, name: project.name, clientName: '', propertyAddress: '', ftpPath: '', localPath: dir });
    }

    sendSSE(res, { phase: 'created', projectId: id, fileCount: activeFiles.length, message: `Project created with ${activeFiles.length} documents` });

    // ── Phase 1.5: Unlock Locked PDFs ──
    let unlockedCount = 0;
    try {
      const { isLocked, unlockPDF } = await import('./core/pdf-postprocess.js');
      for (const filename of activeFiles) {
        const fp = path.join(dir, filename);
        if (await isLocked(fp)) {
          sendSSE(res, { phase: 'unlocking', file: filename, message: `Unlocking ${filename}...` });
          const unlocked = await unlockPDF(fp, fp + '.unlocked');
          if (unlocked) {
            await fs.move(fp + '.unlocked', fp, { overwrite: true });
            unlockedCount++;
          } else {
            sendSSE(res, { phase: 'unlock_failed', file: filename, message: `WARNING: Could not unlock ${filename} — it may be excluded from assembly or have missing content` });
            logger.warn({ file: filename }, 'PDF unlock failed — file may be inaccessible during assembly');
          }
        }
      }
      if (unlockedCount > 0) {
        sendSSE(res, { phase: 'unlocked', count: unlockedCount, message: `Unlocked ${unlockedCount} protected PDF(s)` });
      }
    } catch (err) {
      logger.debug({ error: (err as Error).message }, 'PDF unlock module not available — continuing');
    }

    // ── Phase 2: AI Classification ──
    sendSSE(res, { phase: 'classifying', message: `Classifying ${activeFiles.length} documents...` });

    const filesToClassify = activeFiles;
    let usage: AIUsage = { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, classificationCalls: 0, writingCalls: 0 };
    let classified = 0;

    // Parallel classification with p-limit
    const pLimitMod = await import('p-limit');
    const limit = pLimitMod.default(config.pipeline.classification_concurrency ?? 8);

    const classifyOne = async (filename: string) => {
      const filePath = path.join(dir, filename);
      const fileExt = path.extname(filename).toLowerCase();
      const isImage = IMAGE_EXTENSIONS.has(fileExt);
      let record: FileRecord;

      // FAST PATH: heuristic first — most files match by filename instantly.
      // Only escalate to AI for unknowns (avoids slow claude -p calls for every file).
      record = heuristicClassify(filename);

      if (record.documentType === 'other_unknown' && llm && classifier && !isImage) {
        // Heuristic couldn't classify — check cache first, then use AI
        try {
          // Check SHA-256 classification cache before any PDF work
          const fileBuffer = await fs.readFile(filePath);
          const sha256 = createHash('sha256').update(fileBuffer).digest('hex');
          const cached = state.getCachedClassification(sha256);

          if (cached) {
            // Cache hit — reuse stored classification (zero AI cost)
            record = {
              filename, uploadedAt: new Date().toISOString(),
              documentType: cached.documentType, section: cached.suggestedSection,
              label: DOC_TYPE_LABELS[cached.documentType] || cached.documentType,
              confidence: cached.confidence, reasoning: cached.reasoning,
              needsReview: cached.needsManualReview,
              classifiedBy: 'cache', pageCount: record.pageCount,
            };
          } else {
            // Cache miss — use AI for this one PDF file
            sendSSE(res, { phase: 'classifying', step: 'reading', file: filename, progress: Math.round((classified / filesToClassify.length) * 100) });
            const readResult = await pdfReader.process({ filePath });
            if (!readResult.success) throw new Error(readResult.error);

            sendSSE(res, { phase: 'classifying', step: 'ai', file: filename, message: 'Filename not recognized — using AI...' });
            const classResult = await classifier.process({
              readerOutput: readResult.data, docTypes,
              projectContext: { projectId: id, projectName: project.name, clientName: '', propertyAddress: '', reportType: project.reportType, isSbaLoan: false },
              filename,
            });
            if (!classResult.success) throw new Error(classResult.error);

            const ai = classResult.data;
            const cls = ai.classification;
            usage.totalInputTokens += ai.totalInputTokens;
            usage.totalOutputTokens += ai.totalOutputTokens;
            usage.totalCostUsd += ai.totalCostUsd;
            if (!ai.models.includes('heuristic')) usage.classificationCalls++;

            // Cache result for future reuse (repeat uploads cost $0)
            const classifiedByVal = ai.models.includes('heuristic') ? 'heuristic' : ai.usedEscalation ? 'sonnet' : 'haiku';
            state.setCachedClassification(sha256, cls, classifiedByVal);

            // Cross-property / embedded report detection
            const isEmbedded = cls.metadata?.is_embedded_report === 'true';
            const wrongProject = cls.projectIdDetected && cls.projectIdDetected !== id;
            if (isEmbedded || wrongProject) {
              record = {
                filename, uploadedAt: new Date().toISOString(),
                documentType: 'prior_environmental_report', section: 'appendix_i_additional',
                label: `Prior Report${cls.metadata?.embedded_report_property ? ` (${cls.metadata.embedded_report_property})` : ''}`,
                confidence: cls.confidence,
                reasoning: `⚠️ Different property/project detected: ${cls.reasoning}`,
                needsReview: true,
                classifiedBy: classifiedByVal,
                pageCount: cls.pageCount,
              };
            } else {
              record = {
                filename, uploadedAt: new Date().toISOString(),
                documentType: cls.documentType, section: cls.suggestedSection,
                label: DOC_TYPE_LABELS[cls.documentType] || cls.documentType,
                confidence: cls.confidence, reasoning: cls.reasoning,
                needsReview: cls.needsManualReview,
                classifiedBy: classifiedByVal,
                pageCount: cls.pageCount,
              };
            }
          }
        } catch (err) {
          logger.error({ filename, error: (err as Error).message }, 'AI classification failed — keeping heuristic result');
          // record stays as the heuristic 'other_unknown' result
        }
      }

      const idx = project.files.findIndex(f => f.filename === filename);
      if (idx >= 0) project.files[idx] = record; else project.files.push(record);
      classified++;

      sendSSE(res, {
        phase: 'classifying', step: 'done', file: filename,
        label: record.label, confidence: record.confidence, method: record.classifiedBy,
        progress: Math.round((classified / filesToClassify.length) * 100),
      });
    };

    await Promise.allSettled(filesToClassify.map(fn => limit(() => classifyOne(fn))));

    project.scorecard = buildScorecard(project.files);
    project.aiUsage = usage;
    project.status = 'classified';

    // ── Auto-extract project metadata from classified documents (local, no API) ──
    // Try to pull address and EP name from the report body text using simple patterns
    const bodyFile = project.files.find(f => f.documentType === 'report_body');
    const coverFile2 = project.files.find(f => f.documentType === 'cover_page');
    if (bodyFile || coverFile2) {
      try {
        const metaFile = coverFile2 || bodyFile;
        const metaPath = path.join(dir, metaFile!.filename);
        const metaReader = await pdfReader.process({ filePath: metaPath, maxTextPages: 5 });
        if (metaReader.success && metaReader.data.combinedText.trim()) {
          const text = metaReader.data.combinedText.substring(0, 5000);
          // Simple address extraction: look for common street patterns
          const addrMatch = text.match(/(\d+\s+(?:[NSEW]\.\s*)?[\w\s]+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Circle|Cir|Place|Pl)\.?(?:\s*#?\s*\d+)?[\s,]+[\w\s]+,\s*[A-Z]{2}\s*\d{5})/i);
          if (addrMatch && !project.propertyAddress) project.propertyAddress = addrMatch[1].trim();
          sendSSE(res, { phase: 'metadata_extracted',
            propertyAddress: project.propertyAddress || null,
            clientName: project.clientName || null,
            epName: project.epName || null,
          });
        }
      } catch (err) {
        logger.debug({ error: (err as Error).message }, 'Metadata extraction failed — continuing');
      }
    }

    saveProject(id, project);

    // ── Completeness Check ──
    const completeness = checkCompleteness(project.files);

    sendSSE(res, { phase: 'classified', scorecard: project.scorecard, aiUsage: usage,
      files: project.files.map(f => ({
        filename: f.filename, label: f.label, confidence: f.confidence, method: f.classifiedBy,
        section: f.section, documentType: f.documentType, needsReview: f.needsReview, pageCount: f.pageCount,
      })),
      completeness,
    });

    if (completeness.missing.length > 0) {
      sendSSE(res, { phase: 'completeness_warning',
        missing: completeness.missing, warnings: completeness.warnings,
        message: `Missing ${completeness.missing.length} document types: ${completeness.missing.join(', ')}`,
      });
    }

    // ── PAUSE: Wait for user review before continuing ──
    // Emit needs_review and stop. The review-classifications endpoint continues the pipeline.
    const needsReviewCount = project.files.filter(f => f.needsReview || f.confidence < 0.8).length;
    sendSSE(res, {
      phase: 'needs_review', projectId: id,
      totalFiles: project.files.length, needsReviewCount,
      message: `Classification complete — ${needsReviewCount} file(s) need review. Approve classifications to continue to assembly.`,
    });
    res.end();
    return;

    // NOTE: Everything below this point now runs via POST /api/projects/:id/review-classifications

    // ── Phase 2.4: Cross-Property Spot Check ──
    try {
      const crossCheck = await crossPropertySpotCheck({
        files: project.files, projectId: id, project, dir,
        sendProgress: (event: any) => sendSSE(res, event),
      });
      if (crossCheck.flagged.length > 0) {
        project.scorecard = buildScorecard(project.files);
        saveProject(id, project);
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Cross-property spot check failed — continuing');
    }

    // ── Phase 2.5: Auto-Generate Site Location Map ──
    const hasLocationMap = project.files.some(f => f.documentType === 'location_map');
    const aerialFile = project.files.find(f => f.documentType === 'aerial_photograph');
    if (!hasLocationMap && aerialFile) {
      try {
        const { SiteMapGeneratorSkill } = await import('./skills/site-map-generator.js');
        sendSSE(res, { phase: 'site_map', message: 'Generating site location map from aerials...' });

        const mapGen = new SiteMapGeneratorSkill(config);
        const mapResult = await mapGen.process({
          projectDir: dir,
          aerialFile: aerialFile.filename,
          propertyAddress: project.propertyAddress || 'Property Location',
        });

        if (mapResult.success) {
          const mapFilename = 'Site_Location_Map_AI.pdf';
          await fs.writeFile(path.join(dir, mapFilename), mapResult.data.pdfBuffer);
          project.files.push({
            filename: mapFilename, uploadedAt: new Date().toISOString(),
            documentType: 'location_map', section: 'appendix_a_maps',
            label: 'Site Location Map (AI Generated)', confidence: 0.95,
            reasoning: `Auto-generated from ${aerialFile.filename} page ${mapResult.data.sourceAerialPage}`,
            needsReview: true, classifiedBy: 'ai-generated', pageCount: mapResult.data.pageCount,
          });
          project.scorecard = buildScorecard(project.files);
          saveProject(id, project);
          sendSSE(res, { phase: 'site_map_done', filename: mapFilename, pages: mapResult.data.pageCount, method: mapResult.data.method });
        }
      } catch (err) {
        logger.warn({ error: (err as Error).message }, 'Site map generation unavailable — skipping');
        sendSSE(res, { phase: 'site_map_done', skipped: true, reason: (err as Error).message });
      }
    }

    // ── Phase 2.6: Vision AI — Analyze aerial/site photographs (before conversion so raw images are available) ──
    const visionResults: Record<string, string> = {};
    if (llm) {
      try {
        const { VisionAnalyzerSkill } = await import('./skills/vision-analyzer.js');
        const { selectPagesToAnalyze } = await import('./core/image-sampler.js');
        const { extractPageImages } = await import('./core/pdf-utils.js');

        const visualDocTypes = ['aerial_photograph', 'site_photograph'];
        const visualDocs = project.files.filter(f => visualDocTypes.includes(f.documentType));

        const pLimitVision = (await import('p-limit')).default;
        const visionLimit = pLimitVision(2); // 2 docs concurrently (each spawns 4 image analyses internally)
        await Promise.allSettled(
          visualDocs.map(vdoc => visionLimit(async () => {
          sendSSE(res, { phase: 'vision_analyzing', file: vdoc.filename, message: `Analyzing images in ${vdoc.filename}...` });
          try {
            const filePath = path.join(dir, vdoc.filename);
            const fileExt = path.extname(vdoc.filename).toLowerCase();
            const isImageFile = IMAGE_EXTENSIONS.has(fileExt);
            let images: Buffer[] = [];
            let pageLabels: string[] = [];

            if (isImageFile) {
              // Raw image file — read it directly
              const imgBuf = fs.readFileSync(filePath);
              images = [imgBuf];
              pageLabels = [vdoc.filename];
            } else {
              // PDF — extract page images
              const totalPages = vdoc.pageCount || await getPageCount(filePath);
              const pagesToAnalyze = selectPagesToAnalyze(totalPages, vdoc.documentType, config.research?.max_vision_images_per_doc || 4);
              images = await extractPageImages(filePath, pagesToAnalyze, 150);
              pageLabels = pagesToAnalyze.map((p: number) => `${vdoc.filename} page ${p}`);
            }

            // Determine media type for image files
            const mediaType = isImageFile
              ? (fileExt === '.png' ? 'image/png' : fileExt === '.tif' || fileExt === '.tiff' ? 'image/tiff' : 'image/jpeg') as 'image/png' | 'image/jpeg'
              : 'image/png' as const;

            if (images.length > 0) {
              const visionSkill = new VisionAnalyzerSkill(config, llm);
              const visionResult = await visionSkill.process({
                images: images.map((buf: Buffer, i: number) => ({
                  buffer: buf,
                  mediaType,
                  label: pageLabels[i] || vdoc.filename,
                  documentType: vdoc.documentType,
                })),
                analysisType: vdoc.documentType === 'aerial_photograph' ? 'aerial_historical' : 'site_reconnaissance',
                projectContext: { propertyAddress: project.propertyAddress || '', reportType: project.reportType },
              });

              if (visionResult.success) {
                visionResults[vdoc.filename] = visionResult.data.synthesizedNarrative;
                usage.totalCostUsd += visionResult.data.totalCostUsd;
                sendSSE(res, { phase: 'vision_complete', file: vdoc.filename,
                  pagesAnalyzed: images.length, costUsd: visionResult.data.totalCostUsd.toFixed(4) });
              }
            }
          } catch (err) {
            logger.warn({ file: vdoc.filename, error: (err as Error).message }, 'Vision analysis failed');
            sendSSE(res, { phase: 'vision_skipped', file: vdoc.filename, reason: (err as Error).message });
            // Store a data-gap note so narrative sections know vision failed and can disclose it
            const docLabel = vdoc.documentType === 'aerial_photograph' ? 'Historical aerial photograph' : 'Site photograph';
            visionResults[vdoc.filename] = `[DATA GAP: ${docLabel} analysis of "${vdoc.filename}" could not be completed due to a processing error. The environmental professional should review this document manually and incorporate observations into the final report.]`;
          }
          }))
        );

        if (Object.keys(visionResults).length > 0) {
          project.visionAnalyses = visionResults;
          saveProject(id, project);
          sendSSE(res, { phase: 'vision_done', filesAnalyzed: Object.keys(visionResults).length });
        }
      } catch (err) {
        logger.debug({ error: (err as Error).message }, 'Vision analyzer not available — skipping');
      }
    }

    // ── Phase 2.7: Convert non-PDF files to PDF for assembly ──
    let convertedCount = 0;
    const nonPdfFiles = project.files.filter(file => path.extname(file.filename).toLowerCase() !== '.pdf');
    const pLimitConvert = (await import('p-limit')).default;
    const convertLimit = pLimitConvert(3);
    await Promise.allSettled(
      nonPdfFiles.map(file => convertLimit(async () => {
        const filePath = path.join(dir, file.filename);
        sendSSE(res, { phase: 'converting', file: file.filename, message: `Converting ${file.filename} to PDF...` });
        const pdfPath = await convertToPdf(filePath, dir);
        if (pdfPath) {
          const newFilename = path.basename(pdfPath);
          file.filename = newFilename;
          try { file.pageCount = await getPageCount(pdfPath); } catch {}
          convertedCount++;
          sendSSE(res, { phase: 'converted', file: newFilename, message: `Converted to ${newFilename}` });
        } else {
          (file as any).conversionFailed = true;
          sendSSE(res, { phase: 'convert_skip', file: file.filename, message: `Could not convert ${file.filename} — will be excluded from assembly` });
        }
      }))
    );
    if (convertedCount > 0) {
      saveProject(id, project);
      sendSSE(res, { phase: 'conversion_done', converted: convertedCount, message: `Converted ${convertedCount} non-PDF file(s)` });
    }

    // ── Phase 2.8: REC Auto-Detection ──
    let recAnalysis: any = null;
    if (llm) {
      try {
        const { RECDetectorSkill } = await import('./skills/rec-detector.js');
        sendSSE(res, { phase: 'rec_detection', message: 'Analyzing documents for environmental conditions (RECs)...' });

        // Extract text from key docs for REC analysis
        const recTexts: Record<string, string> = {};
        for (const file of project.files) {
          if (['edr_report', 'agency_records', 'regulatory_correspondence', 'report_body'].includes(file.documentType)) {
            try {
              const r = await pdfReader.process({ filePath: path.join(dir, file.filename), maxTextPages: 30 });
              if (r.success) recTexts[file.filename] = r.data.combinedText.substring(0, 20000);
            } catch {}
          }
        }

        if (Object.keys(recTexts).length > 0) {
          const recDetector = new RECDetectorSkill(config, llm);
          const recResult = await recDetector.process({
            projectDir: dir,
            files: project.files.map(f => ({
              filename: f.filename, documentType: f.documentType,
              label: f.label, section: f.section,
            })),
            projectContext: {
              propertyAddress: project.propertyAddress || '',
              clientName: project.clientName || '',
              reportType: project.reportType,
            },
            extractedTexts: recTexts,
            visionObservations: Object.values(visionResults).join('\n\n') || undefined,
          });

          if (recResult.success) {
            recAnalysis = recResult.data;
            project.recAnalysis = recAnalysis;
            usage.totalCostUsd += recAnalysis.totalCostUsd || 0;
            saveProject(id, project);
            sendSSE(res, {
              phase: 'rec_detection_complete',
              recs: recAnalysis.recs,
              summary: recAnalysis.summary,
            });
          }
        } else {
          sendSSE(res, { phase: 'rec_detection_complete', skipped: true, reason: 'No source documents for REC analysis' });
        }
      } catch (err) {
        logger.warn({ error: (err as Error).message }, 'REC detection failed');
        sendSSE(res, { phase: 'rec_detection_complete', skipped: true, reason: (err as Error).message });
      }
    }

    // ── Phase 3: Write Narratives ──
    // IMPORTANT: If a reviewed write-up / report body already exists (uploaded by the user),
    // we do NOT generate AI narratives. Rose explicitly wants to be the final reviewer
    // and the write-up is already reviewed by the EP. We only generate narratives
    // when there's NO existing report body to work with.
    const hasReportBody = project.files.some(f => f.documentType === 'report_body');

    if (llm && !hasReportBody) {
      sendSSE(res, { phase: 'writing', message: 'No reviewed write-up found — generating narratives with AI...' });

      const narrativeDir2 = path.join(dir, '_narratives');
      await ensureDir(narrativeDir2);

      // Extract text from key documents
      const extractedData: Record<string, string> = {};
      for (const file of project.files) {
        if (['edr_report', 'agency_records', 'regulatory_correspondence'].includes(file.documentType)) {
          try {
            const r = await pdfReader.process({ filePath: path.join(dir, file.filename), maxTextPages: 20 });
            if (r.success) extractedData[file.filename] = r.data.combinedText.substring(0, 15000);
          } catch {}
        }
      }

      // Only attempt narrative writing if we have some source data to work with
      if (Object.keys(extractedData).length > 0) {
        const sections = [
          { id: 'executive_summary', title: 'Executive Summary & Findings' },
          { id: 'introduction', title: '1.0 Introduction' },
          { id: 'property_description', title: '2.0 Property Description' },
          { id: 'property_reconnaissance', title: '3.0 Property Reconnaissance' },
          { id: 'property_history', title: '4.0 Property and Vicinity History' },
          { id: 'records_research', title: '5.0 Standard Environmental Records Research' },
          { id: 'user_information', title: '6.0 User Provided Information' },
          { id: 'references', title: '7.0 References' },
        ];

        let writingCost = 0;
        let sectionsDone = 0;

        const pLimitNarrative = (await import('p-limit')).default;
        const narrativeLimit = pLimitNarrative(3); // 3 concurrent claude spawns
        await Promise.allSettled(
          sections.map(sec => narrativeLimit(async () => {
          sendSSE(res, { phase: 'writing', section: sec.id, title: sec.title, progress: Math.round((sectionsDone / sections.length) * 100) });

          try {
            const system = `You are writing a Phase I Environmental Site Assessment report for ODIC Environmental following ASTM E1527-21. Write in professional, technical ESA style.

IMPORTANT: Write in plain text only. Do NOT use any markdown formatting — no #, ##, **, *, -, bullet points, or other markup. Use natural language paragraphs and numbered subsections (e.g. "1.1 Purpose"). For lists, write them as prose or use simple indented lines. This text will be rendered directly into a PDF as-is.

Company: ODIC Environmental, 407 West Imperial Suite H #303, Brea, CA 92821
Property: ${project.propertyAddress || 'Address pending'}
Client: ${project.clientName || 'Client pending'}
Report Type: ${project.reportType}
Date: ${project.reportDate}
EP: ${project.epName}

Write ONLY the "${sec.title}" section. Be thorough and reference document findings.`;

            // Build vision analysis context — inject into all sections that benefit from visual observations
            let visionContext = '';
            if (Object.keys(visionResults).length > 0) {
              const aerialNarratives = Object.entries(visionResults)
                .filter(([fn]) => project.files.find(f => f.filename === fn)?.documentType === 'aerial_photograph')
                .map(([fn, narrative]) => `--- Vision analysis: ${fn} ---\n${narrative}`);
              const siteNarratives = Object.entries(visionResults)
                .filter(([fn]) => project.files.find(f => f.filename === fn)?.documentType === 'site_photograph')
                .map(([fn, narrative]) => `--- Vision analysis: ${fn} ---\n${narrative}`);

              // Site photos → reconnaissance, property description, executive summary, introduction
              if (['property_reconnaissance', 'property_description', 'introduction', 'executive_summary'].includes(sec.id) && siteNarratives.length > 0) {
                visionContext += `\n\nSite photograph AI observations (incorporate relevant findings into your narrative):\n${siteNarratives.join('\n\n')}`;
              }
              // Aerial photos → property history, records research, executive summary, introduction
              if (['property_history', 'records_research', 'introduction', 'executive_summary'].includes(sec.id) && aerialNarratives.length > 0) {
                visionContext += `\n\nHistorical aerial photograph AI observations (incorporate relevant findings into your narrative):\n${aerialNarratives.join('\n\n')}`;
              }
            }

            // Build REC context — inject into executive summary, records research, references, and user information
            let recContext = '';
            if (recAnalysis && recAnalysis.recs && recAnalysis.recs.length > 0) {
              if (['executive_summary', 'references', 'records_research', 'user_information'].includes(sec.id)) {
                recContext = `\n\n== REC Analysis Results (ASTM E1527-21) ==
Summary: ${recAnalysis.summary.totalRECs} REC(s), ${recAnalysis.summary.totalCRECs} CREC(s), ${recAnalysis.summary.totalHRECs} HREC(s), ${recAnalysis.summary.totalDeMinimis} de minimis
Overall Risk: ${recAnalysis.summary.overallRiskLevel}
${recAnalysis.recs.map((r: any) => `\n${r.id} [${r.classification}] ${r.title}: ${r.description} (Location: ${r.location}, Severity: ${r.severity})\nRecommendation: ${r.recommendation}`).join('\n')}`;
              }
              if (sec.id === 'executive_summary' && recAnalysis.executiveSummaryText) {
                recContext += `\n\nPre-drafted executive summary findings (incorporate or improve):\n${recAnalysis.executiveSummaryText}`;
              }
              if (sec.id === 'references' && recAnalysis.findingsText) {
                recContext += `\n\nPre-drafted findings and opinions text (incorporate or improve):\n${recAnalysis.findingsText}`;
              }
            }

            // Build document inventory summary by type
            const docTypeCounts: Record<string, number> = {};
            for (const f of project.files) {
              const lbl = f.label || f.documentType;
              docTypeCounts[lbl] = (docTypeCounts[lbl] || 0) + 1;
            }
            const docInventory = Object.entries(docTypeCounts).map(([t, c]) => `${t}: ${c}`).join(', ');

            let user = `Write "${sec.title}" for this ESA report.

Project: ${project.name}
Property: ${project.propertyAddress || 'See documents'}

Document Inventory: ${docInventory}

Documents:
${project.files.map(f => `- ${f.filename}: ${f.label} [${f.documentType}]`).join('\n')}

Key document data:
${Object.entries(extractedData).map(([fn, t]) => `--- ${fn} ---\n${t.substring(0, 3000)}`).join('\n\n')}${visionContext}${recContext}`;

            // Inject site visit observations for property reconnaissance
            if (project.siteVisitObservations?.length && sec.id === 'property_reconnaissance') {
              user += '\n\nSite Visit Field Observations:\n';
              for (const obs of project.siteVisitObservations) {
                user += `- [${obs.category}${obs.potentialConcern ? ' ⚠' : ''}] ${obs.text}\n`;
              }
            }
            // Inject REC findings for key narrative sections
            if (recAnalysis?.recs?.length > 0 && ['executive_summary', 'references', 'records_research', 'user_information'].includes(sec.id)) {
              user += '\n\nREC Analysis Results:\n';
              for (const rec of recAnalysis.recs) {
                user += `- ${rec.id} (${rec.classification}): ${rec.title} — ${rec.description}\n`;
              }
              if (sec.id === 'executive_summary' && recAnalysis.executiveSummaryText) {
                user += `\nDraft findings:\n${recAnalysis.executiveSummaryText}`;
              }
              if (sec.id === 'references' && recAnalysis.findingsText) {
                user += `\nDraft findings and opinions:\n${recAnalysis.findingsText}`;
              }
            }
            // Inject address research data
            if (project.researchData?.geocode) {
              const rd = project.researchData as AddressResearchOutput;
              let researchCtx = `\n\n== Public Records Research Data ==`;
              researchCtx += `\nCoordinates: ${rd.geocode.lat}, ${rd.geocode.lng}`;
              researchCtx += `\nCounty: ${rd.geocode.county || 'N/A'} | State: ${rd.geocode.state} | ZIP: ${rd.geocode.zip}`;

              if (rd.floodZone) {
                researchCtx += `\nFEMA Flood Zone: ${rd.floodZone.zone} (Panel: ${rd.floodZone.panelNumber})`;
                researchCtx += rd.floodZone.inFloodplain
                  ? ' — SITE IS IN A FLOODPLAIN'
                  : ' — Site is not in a floodplain';
              } else {
                researchCtx += `\n[DATA GAP: FEMA flood zone data was not available for this property.]`;
              }

              if (rd.soilData) {
                researchCtx += `\nSoil Types: ${rd.soilData.soilTypes.join('; ')}`;
                researchCtx += `\nDrainage Class: ${rd.soilData.drainageClass} | Hydrologic Group: ${rd.soilData.hydrologicGroup}`;
              } else {
                researchCtx += `\n[DATA GAP: USDA soil data was not available for this property.]`;
              }

              if (rd.regulatoryFindings?.epa?.length > 0 &&
                  ['records_research', 'executive_summary', 'property_description'].includes(sec.id)) {
                researchCtx += `\n\nEPA Facilities within search radius (${rd.regulatoryFindings.epa.length} found):`;
                for (const f of rd.regulatoryFindings.epa.slice(0, 15)) {
                  researchCtx += `\n- ${f.facilityName} (${f.database}) at ${f.address} — ${f.status}, ${f.distance}`;
                }
              } else if (['records_research', 'executive_summary'].includes(sec.id)) {
                const epaStatus = (rd as any).regulatoryFindings?.epaStatus;
                if (epaStatus === 'partial' || !rd.regulatoryFindings?.epa) {
                  researchCtx += `\n\n[DATA GAP: EPA FRS/Envirofacts database query returned incomplete results. The environmental professional should verify EPA regulatory listings independently.]`;
                }
              }

              if (rd.regulatoryFindings?.state?.length > 0 &&
                  ['records_research', 'executive_summary'].includes(sec.id)) {
                researchCtx += `\n\nState Database Findings (${rd.regulatoryFindings.state.length} found):`;
                for (const f of rd.regulatoryFindings.state.slice(0, 10)) {
                  researchCtx += `\n- ${f.siteName} (${f.database}) — ${f.status}, Case: ${f.caseNumber}`;
                }
              } else if (['records_research', 'executive_summary'].includes(sec.id)) {
                const stateStatus = (rd as any).regulatoryFindings?.stateStatus;
                if (stateStatus === 'partial' || !rd.regulatoryFindings?.state) {
                  researchCtx += `\n\n[DATA GAP: State environmental database query (EnviroStor/GeoTracker) returned incomplete results. The environmental professional should verify state regulatory listings independently.]`;
                }
              }

              user += researchCtx + '\n';
            }

            const result = await llm.generateText(system, user);
            writingCost += result.costUsd;
            usage.totalCostUsd += result.costUsd;

            const wordCount = result.data.split(/\s+/).length;
            // Minimum word counts by section importance — flag thin sections
            const minWords: Record<string, number> = {
              executive_summary: 150, introduction: 100, property_description: 100,
              property_reconnaissance: 120, property_history: 100, records_research: 120,
              user_information: 80, references: 50,
            };
            const minRequired = minWords[sec.id] || 50;
            let thinWarning: string | undefined;
            if (wordCount < minRequired) {
              thinWarning = `Section "${sec.title}" is only ${wordCount} words (minimum recommended: ${minRequired}). May need manual expansion.`;
              logger.warn({ section: sec.id, wordCount, minRequired }, 'Narrative section below minimum word count');
            }

            // Save text only — no auto-generated narrative PDFs (Rose uploads her own report body)
            await fs.writeFile(path.join(narrativeDir2, `${sec.id}.txt`), result.data);

            sectionsDone++;
            sendSSE(res, { phase: 'writing', step: 'done', section: sec.id, title: sec.title,
              wordCount, costUsd: result.costUsd.toFixed(4), thinWarning,
              progress: Math.round((sectionsDone / sections.length) * 100) });
          } catch (err) {
            sectionsDone++;
            sendSSE(res, { phase: 'writing', step: 'error', section: sec.id, error: (err as Error).message });
          }
          }))
        );

        usage.writingCalls = sections.length;
        project.aiUsage = usage;
        saveProject(id, project);

        sendSSE(res, { phase: 'written', writingCost: writingCost.toFixed(4) });
      } else {
        sendSSE(res, { phase: 'written', skipped: true, message: 'No source documents available for narrative generation.' });
      }
    } else if (hasReportBody) {
      sendSSE(res, { phase: 'written', skipped: true, message: 'Reviewed write-up found — using existing report body (no AI rewrite).' });
    }

    // Auto-generated front matter removed — Rose uploads her own covers,
    // insurance certificates, reliance letters, and photos. No placeholders needed.
    saveProject(id, project);

    // ── Phase 4: Assemble Final PDF ──
    sendSSE(res, { phase: 'assembling', message: 'Assembling final report PDF...' });

    const assemblyResult = await assembleReport({
      dir, files: project.files, propertyAddress: project.propertyAddress,
      sendProgress: (event) => sendSSE(res, event),
    });

    if (assemblyResult.manifest.totalPages === 0) {
      sendSSE(res, { phase: 'error', error: 'Assembly produced 0 pages — no documents or narratives were available. Check that files uploaded and classified correctly.' });
      res.end();
      return;
    }

    const assembledPath = path.join(dir, 'assembled.pdf');
    await fs.writeFile(assembledPath, assemblyResult.pdfBytes);

    project.manifest = assemblyResult.manifest;
    project.status = 'assembled';
    saveProject(id, project);

    // ── Phase 5–7: Compress → Split → QC ──
    const { compressedSizeMB, splitParts, qcResult, aiQcResult } = await postAssembly({
      assembledPath, project, projectId: id, dir, res,
    });

    // ── Phase 8: Auto-Delivery (if configured) ──
    let deliveryResult: any = null;
    if (emailService && config.email_delivery.auto_deliver && config.email_delivery.enabled) {
      const autoRecipients = config.email_delivery.cc_list.length > 0 ? config.email_delivery.cc_list : [];
      if (autoRecipients.length > 0) {
        sendSSE(res, { phase: 'delivering', message: `Auto-delivering report to ${autoRecipients.join(', ')}...` });
        try {
          const autoAttachments: DeliveryRequest['attachments'] = [];
          if (splitParts.length > 0) {
            for (const sp of splitParts) {
              const partFile = sp.downloadUrl.split('part=')[1] || '';
              autoAttachments.push({ filename: partFile, path: path.join(dir, partFile), label: sp.label, sizeMB: sp.sizeMB });
            }
          } else {
            autoAttachments.push({ filename: `${project.name.replace(/\s+/g, '_')}_report.pdf`, path: assembledPath, label: 'Full Report', sizeMB: compressedSizeMB });
          }
          const delivResult = await emailService.deliver({
            to: autoRecipients,
            subject: `Phase I ESA Report — ${project.propertyAddress || project.name}`,
            projectName: project.name, clientName: project.clientName || 'Client',
            propertyAddress: project.propertyAddress || 'See report',
            reportType: project.reportType,
            qcScore: qcResult?.score ? qcResult.score / 100 : undefined,
            attachments: autoAttachments,
          });
          deliveryResult = delivResult;
          if (delivResult.success) {
            sendSSE(res, { phase: 'delivered', messageId: delivResult.messageId, recipients: delivResult.recipients, attachmentCount: delivResult.attachmentCount });
          } else {
            sendSSE(res, { phase: 'delivery_error', error: delivResult.error });
          }
        } catch (err) {
          sendSSE(res, { phase: 'delivery_error', error: (err as Error).message });
        }
      }
    }

    sendSSE(res, {
      phase: 'done', projectId: id,
      totalPages: assemblyResult.manifest.totalPages,
      narrativePages: assemblyResult.manifest.generatedNarrativePages,
      dividerPages: assemblyResult.manifest.dividerPages,
      scorecard: project.scorecard, aiUsage: project.aiUsage, manifest: project.manifest,
      compressedSizeMB: +compressedSizeMB.toFixed(1),
      splitParts: splitParts.length > 0 ? splitParts : undefined,
      qcResult: qcResult ? { passed: qcResult.passed, score: qcResult.score, summary: qcResult.summary, checks: qcResult.checks } : undefined,
      aiQcResult: aiQcResult || undefined,
      recAnalysis: recAnalysis ? { recs: recAnalysis.recs, summary: recAnalysis.summary } : undefined,
      deliveryResult: deliveryResult || undefined,
      emailEnabled: !!(emailService && config.email_delivery.enabled),
      downloadUrl: `/api/projects/${id}/download`,
    });
    res.end();
  } catch (e: any) {
    logger.error({ error: (e as Error).message }, 'Auto-pipeline failed');
    sendSSE(res, { phase: 'error', error: (e as Error).message });
    res.end();
  }
});

// Scorecard
app.get('/api/projects/:id/scorecard', async (req, res) => {
  try {
    const p = loadProject(req.params.id as string);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json({ scorecard: p.scorecard || buildScorecard(p.files), aiUsage: p.aiUsage });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Manifest
app.get('/api/projects/:id/manifest', async (req, res) => {
  try {
    const p = loadProject(req.params.id as string);
    if (!p?.manifest) return res.status(404).json({ error: 'No manifest' });
    res.json(p.manifest);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Email Delivery ──────────────────────────────────────────────────────────

// GET /api/email/test — verify email configuration without sending
app.get('/api/email/test', async (req, res) => {
  try {
    if (!config.email_delivery.enabled) {
      return res.json({ ok: false, error: 'Email delivery is disabled in config' });
    }
    const svc = new EmailDeliveryService(config.email_delivery);
    await svc.init();
    res.json({ ok: true, provider: config.email_delivery.provider, from: config.email_delivery.from_email });
  } catch (err) {
    res.json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/projects/:id/deliver — send report to recipients (SSE)
app.post('/api/projects/:id/deliver', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const id = req.params.id as string;
    const p = loadProject(id);
    if (!p) { sendSSE(res, { phase: 'error', error: 'Project not found' }); res.end(); return; }

    const { to, cc } = req.body as { to?: string[]; cc?: string[] };
    if (!to || to.length === 0) { sendSSE(res, { phase: 'error', error: 'No recipients specified' }); res.end(); return; }

    if (!config.email_delivery.enabled) { sendSSE(res, { phase: 'error', error: 'Email delivery is disabled in config' }); res.end(); return; }

    // Initialise service on demand if not already running
    let svc = emailService;
    if (!svc) {
      svc = new EmailDeliveryService(config.email_delivery);
      await svc.init();
    }

    sendSSE(res, { phase: 'delivering', message: 'Sending report to ' + to.join(', ') + '...' });

    const dir = path.join('uploads', id);
    const assembledPath = path.join(dir, 'assembled.pdf');
    if (!fs.existsSync(assembledPath)) { sendSSE(res, { phase: 'error', error: 'No assembled PDF found — run the pipeline first' }); res.end(); return; }

    // Build attachment list — use split parts if they exist
    const attachments: DeliveryRequest['attachments'] = [];
    const splitFiles = fs.readdirSync(dir).filter(f => f.startsWith('part_') && f.endsWith('.pdf'));
    if (splitFiles.length > 0) {
      for (const sf of splitFiles) {
        const fp = path.join(dir, sf);
        const sizeMB = (await fs.stat(fp)).size / (1024 * 1024);
        attachments.push({ filename: sf, path: fp, label: sf.replace(/_/g, ' ').replace('.pdf', ''), sizeMB });
      }
    } else {
      const sizeMB = (await fs.stat(assembledPath)).size / (1024 * 1024);
      const baseName = p.name ? p.name.replace(/\s+/g, '_') : 'report';
      attachments.push({ filename: baseName + '_report.pdf', path: assembledPath, label: 'Full Report', sizeMB });
    }

    const result = await svc.deliver({
      to,
      cc,
      subject: 'Phase I ESA Report — ' + (p.propertyAddress || p.name),
      projectName: p.name,
      clientName: p.clientName || 'Client',
      propertyAddress: p.propertyAddress || 'See report',
      reportType: p.reportType,
      qcScore: p.qcResult?.score ? p.qcResult.score / 100 : undefined,
      attachments,
    });

    if (result.success) {
      sendSSE(res, { phase: 'delivered', messageId: result.messageId, recipients: result.recipients, attachmentCount: result.attachmentCount, totalSizeMB: result.totalSizeMB, sentAt: result.sentAt });
    } else {
      sendSSE(res, { phase: 'delivery_error', error: result.error });
    }
    res.end();
  } catch (e: any) {
    sendSSE(res, { phase: 'error', error: e.message });
    res.end();
  }
});

// ── Address Research (SSE) ──────────────────────────────────────────────────

app.post('/api/address-research', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { address, reportType, projectId } = req.body || {};
    if (!address || typeof address !== 'string' || address.trim().length < 5) {
      sendSSE(res, { phase: 'error', error: 'A valid property address is required' });
      res.end();
      return;
    }

    sendSSE(res, { phase: 'research_starting', address, message: `Researching ${address}...` });

    // Create or reuse project
    const id = projectId || uuidv4();
    const dir = path.join('uploads', id);
    fs.ensureDirSync(dir);

    let project: ProjectState;
    const existing = loadProject(id);
    if (existing) {
      project = existing;
      project.propertyAddress = address.trim();
    } else {
      project = {
        id, name: `Research-${id.slice(0, 8)}`,
        clientName: '', propertyAddress: address.trim(),
        reportType: (reportType as ReportType) || 'ESAI', isSbaLoan: false,
        reportDate: new Date().toISOString().split('T')[0],
        epName: 'Michael Miller',
        createdAt: new Date().toISOString(), status: 'researching', files: [],
      };
    }

    // Run address research skill
    const researcher = new AddressResearchSkill(config);
    const result = await researcher.process({ address: address.trim(), reportType });

    if (!result.success) {
      sendSSE(res, { phase: 'error', error: result.error || 'Address research failed' });
      res.end();
      return;
    }

    const research = result.data;

    sendSSE(res, {
      phase: 'research_geocoded',
      geocode: research.geocode,
      message: `Geocoded to ${research.geocode.formattedAddress}`,
    });

    // Report each data source result
    for (const ds of research.dataSources) {
      sendSSE(res, {
        phase: 'research_source_done',
        source: ds.name,
        status: ds.status,
        error: ds.error,
      });
    }

    // Save satellite image as a file in the project directory
    if (research.satelliteImageBase64) {
      try {
        const satPath = path.join(dir, 'satellite_aerial.png');
        await fs.writeFile(satPath, Buffer.from(research.satelliteImageBase64, 'base64'));
        const satRecord: FileRecord = {
          filename: 'satellite_aerial.png',
          uploadedAt: new Date().toISOString(),
          documentType: 'aerial_photograph',
          section: 'appendix_b_aerials',
          label: 'Satellite Aerial (Google Maps)',
          confidence: 1.0,
          reasoning: 'Auto-fetched satellite imagery from Google Maps Static API',
          needsReview: false,
          classifiedBy: 'system',
          pageCount: 1,
        };
        const idx = project.files.findIndex(f => f.filename === 'satellite_aerial.png');
        if (idx >= 0) project.files[idx] = satRecord; else project.files.push(satRecord);
      } catch (err) {
        logger.warn({ error: (err as Error).message }, 'Failed to save satellite image');
      }
    }

    // Save research data in project
    project.researchData = research;
    project.status = 'researched';
    saveProject(id, project);

    if (pipelineReady && state) {
      try {
        state.createProject({
          id, name: project.name, clientName: project.clientName,
          propertyAddress: project.propertyAddress, ftpPath: '', localPath: dir,
        });
      } catch {} // may already exist
    }

    sendSSE(res, {
      phase: 'research_complete',
      projectId: id,
      geocode: research.geocode,
      hasSatellite: !!research.satelliteImageBase64,
      regulatoryFindings: {
        epaCount: research.regulatoryFindings.epa.length,
        stateCount: research.regulatoryFindings.state.length,
        epa: research.regulatoryFindings.epa,
        state: research.regulatoryFindings.state,
      },
      floodZone: research.floodZone,
      soilData: research.soilData,
      dataSources: research.dataSources,
      message: 'Address research complete',
    });

    res.end();
  } catch (e: any) {
    logger.error({ error: (e as Error).message }, 'Address research endpoint failed');
    sendSSE(res, { phase: 'error', error: (e as Error).message });
    res.end();
  }
});

// ── Address-Only Full Report (SSE) ──────────────────────────────────────────
// Type an address → get a complete Phase I ESA report. No uploads needed.

app.post('/api/address-report', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { address, clientName, reportType, epName } = req.body || {};
    if (!address || typeof address !== 'string' || address.trim().length < 5) {
      sendSSE(res, { phase: 'error', error: 'A valid property address is required' });
      res.end();
      return;
    }
    if (!llm) {
      sendSSE(res, { phase: 'error', error: 'AI not available — set ANTHROPIC_API_KEY or use Claude Code CLI' });
      res.end();
      return;
    }

    const addr = address.trim();
    const ep = epName || 'Michael Miller';
    const client = clientName || 'Client Pending';
    const rType = (reportType as ReportType) || 'ESAI';
    const reportDate = new Date().toISOString().split('T')[0];

    // ── Phase 1: Address Research ──
    sendSSE(res, { phase: 'research_starting', address: addr, message: `Researching ${addr}...` });

    const researcher = new AddressResearchSkill(config);
    const researchResult = await researcher.process({ address: addr, reportType: rType });

    if (!researchResult.success) {
      sendSSE(res, { phase: 'error', error: researchResult.error || 'Address research failed' });
      res.end();
      return;
    }

    const research = researchResult.data;

    sendSSE(res, {
      phase: 'research_geocoded',
      geocode: research.geocode,
      message: `Geocoded to ${research.geocode.formattedAddress}`,
    });

    for (const ds of research.dataSources) {
      sendSSE(res, { phase: 'research_source_done', source: ds.name, status: ds.status, error: ds.error });
    }

    sendSSE(res, {
      phase: 'research_complete',
      geocode: research.geocode,
      hasSatellite: !!research.satelliteImageBase64,
      regulatoryFindings: {
        epaCount: research.regulatoryFindings.epa.length,
        stateCount: research.regulatoryFindings.state.length,
        epa: research.regulatoryFindings.epa,
        state: research.regulatoryFindings.state,
      },
      floodZone: research.floodZone,
      soilData: research.soilData,
      sanbornMaps: research.sanbornMaps,
      historicalTopos: research.historicalTopos,
      groundwater: research.groundwater,
      ejscreen: research.ejscreen,
      streetViewCount: research.streetViewImages.length,
      hasLocationMap: !!research.locationMapBase64,
      hasVicinityMap: !!research.vicinityMapBase64,
      dataSources: research.dataSources,
      message: 'Address research complete',
    });

    // ── Create Project ──
    const id = `Auto-${uuidv4().slice(0, 8)}`;
    const projId = uuidv4();
    const dir = path.join('uploads', projId);
    fs.ensureDirSync(dir);

    const project: ProjectState = {
      id: projId, name: id,
      clientName: client, propertyAddress: addr,
      reportType: rType, isSbaLoan: false,
      reportDate, epName: ep,
      createdAt: new Date().toISOString(), status: 'researching',
      files: [], researchData: research,
    };

    // Save all research images
    const saveImage = async (base64: string, filename: string, docType: string, section: string, label: string) => {
      try {
        await fs.writeFile(path.join(dir, filename), Buffer.from(base64, 'base64'));
        project.files.push({
          filename, uploadedAt: new Date().toISOString(),
          documentType: docType, section,
          label, confidence: 1.0,
          reasoning: 'Auto-fetched from public data', needsReview: false,
          classifiedBy: 'system', pageCount: 1,
        });
      } catch {}
    };

    if (research.locationMapBase64) {
      await saveImage(research.locationMapBase64, 'location_map.png', 'site_location_map', 'appendix_a_maps', 'Site Location Map (Google Maps)');
    }
    if (research.vicinityMapBase64) {
      await saveImage(research.vicinityMapBase64, 'vicinity_map.png', 'vicinity_map', 'appendix_a_maps', 'Vicinity Map (Google Maps Hybrid)');
    }
    if (research.satelliteImageBase64) {
      await saveImage(research.satelliteImageBase64, 'satellite_aerial.png', 'aerial_photograph', 'appendix_a_maps', 'Satellite Aerial (Google Maps)');
    }

    // Save Street View images
    for (const sv of research.streetViewImages) {
      await saveImage(sv.base64, `streetview_${sv.direction.toLowerCase()}.jpg`, 'site_photograph', 'appendix_b_photographs', `Street View — ${sv.direction}-facing`);
    }

    saveProject(projId, project);
    if (pipelineReady && state) {
      try {
        state.createProject({ id: projId, name: id, clientName: client, propertyAddress: addr, ftpPath: '', localPath: dir });
      } catch {}
    }

    sendSSE(res, { phase: 'created', projectId: projId, message: 'Project created — generating report...' });

    // Auto-generated front matter removed — no auto covers, reliance letters,
    // or insurance placeholders. Only uploaded documents go into the report.

    // Track AI usage across all phases
    let usage: AIUsage = { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, classificationCalls: 0, writingCalls: 0 };

    // ── Phase 3: Write 8 Narrative Sections (enriched with research data) ──
    const narrativeDir = path.join(dir, '_narratives');
    await ensureDir(narrativeDir);

    // Build research context string for prompts
    let researchCtx = '';
    if (research.geocode) {
      researchCtx += `\nProperty Coordinates: ${research.geocode.lat}, ${research.geocode.lng}`;
      researchCtx += `\nFormatted Address: ${research.geocode.formattedAddress}`;
      researchCtx += `\nCounty: ${research.geocode.county || 'N/A'} | State: ${research.geocode.state} | ZIP: ${research.geocode.zip}`;
    }
    if (research.floodZone) {
      researchCtx += `\nFEMA Flood Zone: ${research.floodZone.zone} (Panel: ${research.floodZone.panelNumber})`;
      researchCtx += research.floodZone.inFloodplain
        ? ' — SITE IS IN A FLOODPLAIN'
        : ' — Site is not in a floodplain';
    }
    if (research.soilData) {
      researchCtx += `\nSoil Types: ${research.soilData.soilTypes.join('; ')}`;
      researchCtx += `\nDrainage Class: ${research.soilData.drainageClass} | Hydrologic Group: ${research.soilData.hydrologicGroup}`;
    }
    if (research.regulatoryFindings?.epa?.length > 0) {
      researchCtx += `\n\nEPA Facilities within search radius (${research.regulatoryFindings.epa.length} found):`;
      for (const f of research.regulatoryFindings.epa.slice(0, 20)) {
        researchCtx += `\n- ${f.facilityName} (${f.database}) at ${f.address} — ${f.status}, ${f.distance}`;
      }
    }
    if (research.regulatoryFindings?.state?.length > 0) {
      researchCtx += `\n\nState Database Findings (${research.regulatoryFindings.state.length} found):`;
      for (const f of research.regulatoryFindings.state.slice(0, 15)) {
        researchCtx += `\n- ${f.siteName} (${f.database}) — ${f.status}, Case: ${f.caseNumber}`;
      }
    }
    if (research.sanbornMaps?.length > 0) {
      researchCtx += `\n\nSanborn Fire Insurance Maps (${research.sanbornMaps.length} found via Library of Congress):`;
      for (const m of research.sanbornMaps) {
        researchCtx += `\n- "${m.title}" (${m.date}) — ${m.sheetCount} sheet(s)`;
      }
    }
    if (research.historicalTopos?.length > 0) {
      researchCtx += `\n\nUSGS Historical Topographic Maps (${research.historicalTopos.length} found):`;
      for (const t of research.historicalTopos) {
        researchCtx += `\n- "${t.title}" (${t.date}) — Scale: ${t.scale}`;
      }
    }
    if (research.groundwater) {
      researchCtx += `\n\nUSGS Groundwater Monitoring Wells (${research.groundwater.siteCount} wells found nearby):`;
      for (const w of research.groundwater.sites.slice(0, 10)) {
        researchCtx += `\n- ${w.siteName} (${w.siteNumber}) — Depth: ${w.wellDepth}, Water Level: ${w.waterLevel}`;
      }
    }
    if (research.ejscreen) {
      const ej = research.ejscreen;
      researchCtx += `\n\nEPA EJScreen Environmental Justice Data:`;
      researchCtx += `\n- Total Population (1-mile buffer): ${ej.totalPopulation}`;
      researchCtx += `\n- Percent Minority: ${ej.percentMinority}`;
      researchCtx += `\n- Percent Low Income: ${ej.percentLowIncome}`;
      researchCtx += `\n- Superfund Proximity: ${ej.superfundProximity}`;
      researchCtx += `\n- RMP Facility Proximity: ${ej.rmpProximity}`;
      researchCtx += `\n- Hazardous Waste Proximity: ${ej.hazWasteProximity}`;
      researchCtx += `\n- Water Discharge Proximity: ${ej.waterDischargeProximity}`;
      researchCtx += `\n- Air Toxics Cancer Risk: ${ej.airToxicsCancer}`;
      researchCtx += `\n- Diesel PM: ${ej.dieselPM}`;
      researchCtx += `\n- Lead Paint Indicator: ${ej.leadPaint}`;
    }

    // ── Phase 2c: AI Vision Analysis ──
    let visionCtx = '';
    if (llm && (research.satelliteImageBase64 || research.streetViewImages.length > 0)) {
      sendSSE(res, { phase: 'vision_analysis', message: 'Analyzing imagery with AI vision...' });

      try {
        const visionSkill = new VisionAnalyzerSkill(config, llm);

        // Analyze satellite image
        if (research.satelliteImageBase64) {
          try {
            const satResult = await visionSkill.process({
              images: [{
                buffer: Buffer.from(research.satelliteImageBase64, 'base64'),
                mediaType: 'image/png',
                label: 'Satellite aerial view',
                documentType: 'aerial_photograph',
              }],
              analysisType: 'aerial_historical',
              projectContext: { propertyAddress: addr, reportType: rType },
            });
            if (satResult.success) {
              visionCtx += `\n\nAI SATELLITE IMAGE ANALYSIS:\n${satResult.data.synthesizedNarrative}`;
              usage.totalCostUsd += satResult.data.totalCostUsd;
              sendSSE(res, { phase: 'vision_done', item: 'satellite', message: 'Satellite image analyzed' });
            }
          } catch (err) {
            logger.warn({ error: (err as Error).message }, 'Satellite vision analysis failed');
          }
        }

        // Analyze street view images
        if (research.streetViewImages.length > 0) {
          try {
            const svImages = research.streetViewImages.map(sv => ({
              buffer: Buffer.from(sv.base64, 'base64'),
              mediaType: 'image/jpeg' as const,
              label: `Street View — ${sv.direction}-facing`,
              documentType: 'site_photograph',
            }));

            const svResult = await visionSkill.process({
              images: svImages,
              analysisType: 'site_reconnaissance',
              projectContext: { propertyAddress: addr, reportType: rType },
            });
            if (svResult.success) {
              visionCtx += `\n\nAI STREET VIEW ANALYSIS (Preliminary Site Observations):\n${svResult.data.synthesizedNarrative}`;
              usage.totalCostUsd += svResult.data.totalCostUsd;
              sendSSE(res, { phase: 'vision_done', item: 'streetview', count: research.streetViewImages.length, message: 'Street View images analyzed' });
            }
          } catch (err) {
            logger.warn({ error: (err as Error).message }, 'Street view vision analysis failed');
          }
        }

        if (visionCtx) {
          researchCtx += visionCtx;
          sendSSE(res, { phase: 'vision_complete', message: 'Vision analysis complete — observations will enrich narrative sections' });
        }
      } catch (err) {
        logger.warn({ error: (err as Error).message }, 'Vision analysis unavailable — continuing without it');
        sendSSE(res, { phase: 'vision_complete', skipped: true, reason: (err as Error).message });
      }
    }

    const sections = [
      { id: 'executive_summary', title: 'Executive Summary & Findings' },
      { id: 'introduction', title: '1.0 Introduction' },
      { id: 'property_description', title: '2.0 Property Description' },
      { id: 'property_reconnaissance', title: '3.0 Property Reconnaissance' },
      { id: 'property_history', title: '4.0 Property and Vicinity History' },
      { id: 'records_research', title: '5.0 Standard Environmental Records Research' },
      { id: 'user_information', title: '6.0 User Provided Information' },
      { id: 'references', title: '7.0 References' },
    ];

    let sectionsDone = 0;

    sendSSE(res, { phase: 'writing', message: 'Writing report narrative with AI...' });

    for (const sec of sections) {
      sendSSE(res, { phase: 'writing', section: sec.id, title: sec.title, progress: Math.round((sectionsDone / sections.length) * 100) });

      try {
        const system = `You are writing a Phase I Environmental Site Assessment report for ODIC Environmental following ASTM E1527-21 standards. Write in professional, technical ESA style.

IMPORTANT: Write in plain text only. Do NOT use any markdown formatting — no #, ##, **, *, -, bullet points, or other markup. Use natural language paragraphs and numbered subsections (e.g. "1.1 Purpose"). For lists, write them as prose or use simple indented lines. This text will be rendered directly into a PDF as-is.

This is a PRELIMINARY report generated from public records research only — no physical site visit has been conducted. Mark any sections that would normally require a site visit with "NOTE: Site visit pending — observations will be added upon completion of property reconnaissance."

Company: ODIC Environmental, 407 West Imperial Suite H #303, Brea, CA 92821
Property: ${addr}
Client: ${client}
Report Type: ${rType}
Date: ${reportDate}
EP: ${ep}

Write ONLY the "${sec.title}" section. Be thorough, cite specific data from the research findings, and follow ASTM E1527-21 requirements.`;

        const user = `Write "${sec.title}" for this preliminary Phase I ESA report.

Property: ${addr}
${researchCtx}

This report is generated from public records research only. Use all available data to write a comprehensive section. Where data is not available from public records, note that it will be supplemented with site visit observations.

Remember: plain text only, no markdown formatting.`;

        const result = await llm.generateText(system, user);
        usage.totalCostUsd += result.costUsd;
        usage.writingCalls++;

        // Save text only — no auto-generated narrative PDFs
        await fs.writeFile(path.join(narrativeDir, `${sec.id}.txt`), result.data);

        sectionsDone++;
        sendSSE(res, {
          phase: 'writing', step: 'done', section: sec.id, title: sec.title,
          wordCount: result.data.split(/\s+/).length, costUsd: result.costUsd.toFixed(4),
          progress: Math.round((sectionsDone / sections.length) * 100),
        });
      } catch (err) {
        sectionsDone++;
        logger.error({ section: sec.id, error: (err as Error).message }, 'Section write failed');
        sendSSE(res, { phase: 'writing', step: 'error', section: sec.id, error: (err as Error).message });
      }
    }

    project.aiUsage = usage;
    saveProject(projId, project);
    sendSSE(res, { phase: 'written', writingCost: usage.totalCostUsd.toFixed(4) });

    // ── Phase 3b: Generate Appendices (A-F) ──
    sendSSE(res, { phase: 'generating_appendices', message: 'Generating appendices...' });

    // Appendix B — Site Photographs (Street View if available, otherwise placeholder)
    try {
      if (research.streetViewImages.length > 0) {
        // Create a cover page for Appendix B with disclaimer
        const appBCoverPdf = await createMultiPageText(
          'Appendix B — Site Photographs',
          `APPENDIX B — SITE PHOTOGRAPHS\n\n` +
          `PRELIMINARY IMAGERY FROM GOOGLE STREET VIEW\n\n` +
          `The following photographs were obtained from Google Street View and provide preliminary ` +
          `exterior views of the subject property and surrounding area. These images are included ` +
          `for reference purposes only and do not constitute a site visit.\n\n` +
          `Professional site photographs will be obtained during the property reconnaissance visit ` +
          `as required by ASTM E1527-21. The site visit will document current conditions including ` +
          `evidence of hazardous materials, storage tanks, staining, stressed vegetation, and other ` +
          `indicators of potential environmental concern.\n\n` +
          `Property: ${addr}\n` +
          `Report Date: ${reportDate}\n` +
          `EP: ${ep}\n\n` +
          `Images:\n` +
          research.streetViewImages.map(sv => `  Google Street View — ${sv.direction}-facing view`).join('\n')
        );
        await fs.writeFile(path.join(dir, 'Appendix_B_Cover.pdf'), appBCoverPdf);
        project.files.push({
          filename: 'Appendix_B_Cover.pdf', uploadedAt: new Date().toISOString(),
          documentType: 'site_photograph', section: 'appendix_b_photographs',
          label: 'Site Photos Cover Page', confidence: 1.0,
          reasoning: 'Cover page for Street View imagery', needsReview: false,
          classifiedBy: 'system', pageCount: 1,
        });
        // Street view images were already saved and classified into appendix_b_photographs above
        sendSSE(res, { phase: 'appendix_done', appendix: 'B', title: `Site Photographs (${research.streetViewImages.length} Street View images)` });
      } else {
        // No Street View available — placeholder
        const appBPdf = await createMultiPageText(
          'Appendix B — Site Photographs',
          `APPENDIX B — SITE PHOTOGRAPHS\n\n` +
          `PENDING SITE VISIT\n\n` +
          `Site photographs will be included in this appendix upon completion of the property reconnaissance.\n\n` +
          `Google Street View imagery was not available for this location.\n\n` +
          `Per ASTM E1527-21, the Environmental Professional is required to conduct a site visit to observe ` +
          `current conditions, identify potential recognized environmental conditions (RECs), and document ` +
          `observations photographically.\n\n` +
          `Property: ${addr}\n` +
          `Report Date: ${reportDate}\n` +
          `EP: ${ep}`
        );
        await fs.writeFile(path.join(dir, 'Appendix_B_Photos.pdf'), appBPdf);
        project.files.push({
          filename: 'Appendix_B_Photos.pdf', uploadedAt: new Date().toISOString(),
          documentType: 'site_photograph', section: 'appendix_b_photographs',
          label: 'Site Photographs (Pending Site Visit)', confidence: 1.0,
          reasoning: 'Placeholder for site visit photographs', needsReview: true,
          classifiedBy: 'system', pageCount: 1,
        });
        sendSSE(res, { phase: 'appendix_done', appendix: 'B', title: 'Site Photographs (Placeholder)' });
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Appendix B generation failed');
    }

    // Appendix C — Regulatory Database Summary (compiled from research data)
    try {
      let appCContent = `APPENDIX C — RADIUS MAP REPORT / REGULATORY DATABASE SUMMARY\n\n`;
      appCContent += `Property: ${addr}\n`;
      appCContent += `Search Date: ${reportDate}\n`;
      appCContent += `Search Radius: ${config.research?.epa_search_radius_miles ?? 1} mile(s)\n\n`;

      if (research.regulatoryFindings.epa.length > 0) {
        appCContent += `FEDERAL DATABASE FINDINGS (${research.regulatoryFindings.epa.length} facilities found):\n\n`;
        for (const f of research.regulatoryFindings.epa) {
          appCContent += `  Facility: ${f.facilityName}\n`;
          appCContent += `  Address: ${f.address}\n`;
          appCContent += `  Database(s): ${f.database}\n`;
          appCContent += `  Status: ${f.status}\n`;
          appCContent += `  Distance: ${f.distance}\n`;
          appCContent += `  Registry ID: ${f.registryId}\n\n`;
        }
      } else {
        appCContent += `FEDERAL DATABASE FINDINGS: No facilities identified within the search radius.\n\n`;
      }

      if (research.regulatoryFindings.state.length > 0) {
        appCContent += `STATE DATABASE FINDINGS (${research.regulatoryFindings.state.length} sites found):\n\n`;
        for (const f of research.regulatoryFindings.state) {
          appCContent += `  Site: ${f.siteName}\n`;
          appCContent += `  Address: ${f.address}\n`;
          appCContent += `  Database: ${f.database}\n`;
          appCContent += `  Status: ${f.status}\n`;
          appCContent += `  Case Number: ${f.caseNumber}\n\n`;
        }
      } else {
        appCContent += `STATE DATABASE FINDINGS: No sites identified within the search radius.\n\n`;
      }

      appCContent += `\nDATA SOURCES QUERIED:\n`;
      for (const ds of research.dataSources) {
        appCContent += `  • ${ds.name}: ${ds.status}${ds.error ? ' — ' + ds.error : ''}\n`;
      }

      const appCPdf = await createMultiPageText('Appendix C — Radius Map Report', appCContent);
      await fs.writeFile(path.join(dir, 'Appendix_C_Database.pdf'), appCPdf);
      project.files.push({
        filename: 'Appendix_C_Database.pdf', uploadedAt: new Date().toISOString(),
        documentType: 'edr_report', section: 'appendix_c_database_report',
        label: 'Regulatory Database Summary (Auto-Compiled)', confidence: 1.0,
        reasoning: 'Auto-compiled from EPA/state database queries', needsReview: false,
        classifiedBy: 'system', pageCount: 1,
      });
      sendSSE(res, { phase: 'appendix_done', appendix: 'C', title: 'Regulatory Database Summary' });
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Appendix C generation failed');
    }

    // Appendix D — Historical Records (Sanborn maps + USGS topos metadata)
    try {
      let appDContent = `APPENDIX D — HISTORICAL RECORDS\n\n`;
      appDContent += `Property: ${addr}\n`;
      appDContent += `Research Date: ${reportDate}\n\n`;

      appDContent += `SANBORN FIRE INSURANCE MAPS\n`;
      appDContent += `Source: Library of Congress Digital Collections\n\n`;
      if (research.sanbornMaps?.length > 0) {
        for (const m of research.sanbornMaps) {
          appDContent += `  Title: ${m.title}\n`;
          appDContent += `  Date: ${m.date}\n`;
          appDContent += `  Sheets: ${m.sheetCount}\n`;
          appDContent += `  URL: ${m.locUrl}\n\n`;
        }
      } else {
        appDContent += `  No Sanborn maps found for this location in the Library of Congress digital collection.\n`;
        appDContent += `  Note: Not all Sanborn maps have been digitized. Physical collections may contain\n`;
        appDContent += `  additional maps at local libraries or the Library of Congress Reading Room.\n\n`;
      }

      appDContent += `\nUSGS HISTORICAL TOPOGRAPHIC MAPS\n`;
      appDContent += `Source: USGS National Map (TNM Access)\n\n`;
      if (research.historicalTopos?.length > 0) {
        for (const t of research.historicalTopos) {
          appDContent += `  Title: ${t.title}\n`;
          appDContent += `  Date: ${t.date}\n`;
          appDContent += `  Scale: ${t.scale}\n`;
          appDContent += `  Download: ${t.downloadUrl}\n\n`;
        }
      } else {
        appDContent += `  No historical topographic maps found for this location.\n\n`;
      }

      appDContent += `\nHISTORICAL AERIAL PHOTOGRAPHS\n`;
      appDContent += `  Historical aerial photographs are typically obtained from EDR or NETR Online.\n`;
      appDContent += `  A comprehensive aerial photograph review should be conducted as part of the\n`;
      appDContent += `  final Phase I ESA report.\n`;

      const appDPdf = await createMultiPageText('Appendix D — Historical Records', appDContent);
      await fs.writeFile(path.join(dir, 'Appendix_D_Historical.pdf'), appDPdf);
      project.files.push({
        filename: 'Appendix_D_Historical.pdf', uploadedAt: new Date().toISOString(),
        documentType: 'historical_records', section: 'appendix_d_historical',
        label: 'Historical Records Index', confidence: 1.0,
        reasoning: 'Auto-compiled from Library of Congress and USGS data', needsReview: false,
        classifiedBy: 'system', pageCount: 1,
      });

      // Save actual Sanborn map images
      let sanbornSaved = 0;
      for (let si = 0; si < research.sanbornMaps.length; si++) {
        const m = research.sanbornMaps[si];
        if (m.imageBase64) {
          const fn = `sanborn_${si + 1}.jpg`;
          try {
            await fs.writeFile(path.join(dir, fn), Buffer.from(m.imageBase64, 'base64'));
            project.files.push({
              filename: fn, uploadedAt: new Date().toISOString(),
              documentType: 'historical_records', section: 'appendix_d_historical',
              label: `Sanborn Map: ${m.title} (${m.date})`, confidence: 1.0,
              reasoning: 'Downloaded from Library of Congress', needsReview: false,
              classifiedBy: 'system', pageCount: 1,
            });
            sanbornSaved++;
          } catch {}
        }
      }

      // Save actual topo map thumbnails
      let topoSaved = 0;
      for (let ti = 0; ti < research.historicalTopos.length; ti++) {
        const t = research.historicalTopos[ti];
        if (t.thumbnailBase64) {
          const fn = `topo_${ti + 1}.jpg`;
          try {
            await fs.writeFile(path.join(dir, fn), Buffer.from(t.thumbnailBase64, 'base64'));
            project.files.push({
              filename: fn, uploadedAt: new Date().toISOString(),
              documentType: 'historical_records', section: 'appendix_d_historical',
              label: `USGS Topo: ${t.title} (${t.date})`, confidence: 1.0,
              reasoning: 'Downloaded from USGS National Map', needsReview: false,
              classifiedBy: 'system', pageCount: 1,
            });
            topoSaved++;
          } catch {}
        }
      }

      sendSSE(res, { phase: 'appendix_done', appendix: 'D', title: `Historical Records (${sanbornSaved} Sanborn images, ${topoSaved} topo images)` });
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Appendix D generation failed');
    }

    // Appendix E — Agency Records (groundwater data + data sources audit trail)
    try {
      let appEContent = `APPENDIX E — AGENCY RECORDS\n\n`;
      appEContent += `Property: ${addr}\n`;
      appEContent += `Research Date: ${reportDate}\n\n`;

      appEContent += `USGS GROUNDWATER MONITORING DATA\n`;
      appEContent += `Source: USGS National Water Information System (NWIS)\n\n`;
      if (research.groundwater && research.groundwater.sites.length > 0) {
        appEContent += `  ${research.groundwater.siteCount} monitoring well(s) identified within the search area:\n\n`;
        for (const w of research.groundwater.sites) {
          appEContent += `  Well: ${w.siteName}\n`;
          appEContent += `  Site Number: ${w.siteNumber}\n`;
          appEContent += `  Well Depth: ${w.wellDepth}\n`;
          appEContent += `  Most Recent Water Level: ${w.waterLevel}\n\n`;
        }
      } else {
        appEContent += `  No USGS groundwater monitoring wells were identified within the search area.\n\n`;
      }

      if (research.floodZone) {
        appEContent += `\nFEMA FLOOD ZONE DATA\n`;
        appEContent += `  Flood Zone: ${research.floodZone.zone}\n`;
        appEContent += `  FIRM Panel: ${research.floodZone.panelNumber}\n`;
        appEContent += `  In Floodplain: ${research.floodZone.inFloodplain ? 'YES' : 'No'}\n\n`;
      }

      if (research.soilData) {
        appEContent += `\nNRCS SOIL SURVEY DATA\n`;
        appEContent += `  Soil Types: ${research.soilData.soilTypes.join('; ')}\n`;
        appEContent += `  Drainage Class: ${research.soilData.drainageClass}\n`;
        appEContent += `  Hydrologic Group: ${research.soilData.hydrologicGroup}\n\n`;
      }

      if (research.ejscreen) {
        const ej = research.ejscreen;
        appEContent += `\nEPA EJSCREEN — ENVIRONMENTAL JUSTICE DATA\n`;
        appEContent += `Source: EPA Environmental Justice Screening Tool\n`;
        appEContent += `  Total Population (1-mile buffer): ${ej.totalPopulation}\n`;
        appEContent += `  Percent Minority: ${ej.percentMinority}\n`;
        appEContent += `  Percent Low Income: ${ej.percentLowIncome}\n`;
        appEContent += `  Superfund Proximity Percentile: ${ej.superfundProximity}\n`;
        appEContent += `  RMP Facility Proximity Percentile: ${ej.rmpProximity}\n`;
        appEContent += `  Hazardous Waste Proximity Percentile: ${ej.hazWasteProximity}\n`;
        appEContent += `  Water Discharge Proximity Percentile: ${ej.waterDischargeProximity}\n`;
        appEContent += `  Air Toxics Cancer Risk Percentile: ${ej.airToxicsCancer}\n`;
        appEContent += `  Diesel PM Percentile: ${ej.dieselPM}\n`;
        appEContent += `  Lead Paint Indicator: ${ej.leadPaint}\n\n`;
      }

      appEContent += `\nDATA SOURCES AUDIT TRAIL\n`;
      appEContent += `The following public databases and APIs were queried during this research:\n\n`;
      for (const ds of research.dataSources) {
        appEContent += `  Source: ${ds.name}\n`;
        appEContent += `  Status: ${ds.status}\n`;
        if (ds.error) appEContent += `  Note: ${ds.error}\n`;
        appEContent += `\n`;
      }

      const appEPdf = await createMultiPageText('Appendix E — Agency Records', appEContent);
      await fs.writeFile(path.join(dir, 'Appendix_E_Agency.pdf'), appEPdf);
      project.files.push({
        filename: 'Appendix_E_Agency.pdf', uploadedAt: new Date().toISOString(),
        documentType: 'agency_records', section: 'appendix_e_agency_records',
        label: 'Agency Records & Data Sources', confidence: 1.0,
        reasoning: 'Auto-compiled from USGS, FEMA, and NRCS data', needsReview: false,
        classifiedBy: 'system', pageCount: 1,
      });
      sendSSE(res, { phase: 'appendix_done', appendix: 'E', title: 'Agency Records' });
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Appendix E generation failed');
    }

    // Appendix F — EP Qualifications placeholder
    try {
      const appFPdf = await createMultiPageText(
        'Appendix F — EP Qualifications',
        `APPENDIX F — ENVIRONMENTAL PROFESSIONAL QUALIFICATIONS\n\n` +
        `Environmental Professional: ${ep}\n` +
        `Company: ODIC Environmental\n` +
        `Address: 407 W. Imperial Hwy Suite H #303, Brea, CA 92821\n\n` +
        `QUALIFICATIONS\n\n` +
        `The Environmental Professional (EP) responsible for this Phase I Environmental Site Assessment ` +
        `meets the qualifications set forth in ASTM E1527-21, Section 11, and 40 CFR Part 312.\n\n` +
        `The EP possesses sufficient education, training, and experience necessary to exercise professional ` +
        `judgment to develop opinions and conclusions regarding conditions indicative of releases or ` +
        `threatened releases on, at, in, or to a property.\n\n` +
        `[EP resume/CV and professional certifications to be attached]\n\n` +
        `This placeholder will be replaced with the EP's full qualifications document prior to ` +
        `final report delivery.`
      );
      await fs.writeFile(path.join(dir, 'Appendix_F_Qualifications.pdf'), appFPdf);
      project.files.push({
        filename: 'Appendix_F_Qualifications.pdf', uploadedAt: new Date().toISOString(),
        documentType: 'ep_qualifications', section: 'appendix_f_qualifications',
        label: 'EP Qualifications (Placeholder)', confidence: 1.0,
        reasoning: 'Placeholder for EP qualifications/resume', needsReview: true,
        classifiedBy: 'system', pageCount: 1,
      });
      sendSSE(res, { phase: 'appendix_done', appendix: 'F', title: 'EP Qualifications (Placeholder)' });
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Appendix F generation failed');
    }

    saveProject(projId, project);
    sendSSE(res, { phase: 'appendices_done', message: 'All appendices generated' });

    // ── Re-check completeness after all files generated ──
    const updatedCompleteness = checkCompleteness(project.files);
    sendSSE(res, { phase: 'completeness_update', completeness: updatedCompleteness,
      present: updatedCompleteness.present, missing: updatedCompleteness.missing });

    // ── Phase 4: Assemble Final PDF ──
    sendSSE(res, { phase: 'assembling', message: 'Assembling final report PDF...' });

    // Convert any remaining non-PDF files to PDF before assembly
    for (const file of project.files) {
      const fext = path.extname(file.filename).toLowerCase();
      if (fext !== '.pdf') {
        const fp = path.join(dir, file.filename);
        if (fs.existsSync(fp)) {
          const pdfPath = await convertToPdf(fp, dir);
          if (pdfPath) {
            file.filename = path.basename(pdfPath);
            try { file.pageCount = await getPageCount(pdfPath); } catch {}
          } else {
            (file as any).conversionFailed = true;
            sendSSE(res, { phase: 'convert_skip', file: file.filename, message: `Cannot convert ${file.filename} — will be excluded from assembly` });
          }
        }
      }
    }
    saveProject(projId, project);

    sendSSE(res, { phase: 'assembling', message: 'Assembling final report PDF...' });

    const assemblyResult = await assembleReport({
      dir, files: project.files, propertyAddress: project.propertyAddress,
      sendProgress: (event) => sendSSE(res, event),
    });

    if (assemblyResult.manifest.totalPages === 0) {
      sendSSE(res, { phase: 'error', error: 'Assembly produced 0 pages — no documents or narratives were generated. Check address and report configuration.' });
      res.end();
      return;
    }

    const assembledPath = path.join(dir, 'assembled.pdf');
    await fs.writeFile(assembledPath, assemblyResult.pdfBytes);

    project.manifest = assemblyResult.manifest;
    project.status = 'assembled';
    saveProject(projId, project);

    // ── Phase 5–7: Compress → Split → QC ──
    const { compressedSizeMB, splitParts, qcResult, aiQcResult } = await postAssembly({
      assembledPath, project, projectId: projId, dir, res,
    });

    // ── Done ──
    sendSSE(res, {
      phase: 'done', projectId: projId,
      totalPages: assemblyResult.manifest.totalPages,
      narrativePages: assemblyResult.manifest.generatedNarrativePages,
      dividerPages: assemblyResult.manifest.dividerPages,
      scorecard: buildScorecard(project.files), aiUsage: usage, manifest: project.manifest,
      compressedSizeMB: +compressedSizeMB.toFixed(1),
      splitParts: splitParts.length > 0 ? splitParts : undefined,
      qcResult: qcResult ? { passed: qcResult.passed, score: qcResult.score, summary: qcResult.summary, checks: qcResult.checks } : undefined,
      aiQcResult: aiQcResult || undefined,
      emailEnabled: !!(emailService && config.email_delivery.enabled),
      downloadUrl: `/api/projects/${projId}/download`,
    });
    res.end();
  } catch (e: any) {
    logger.error({ error: (e as Error).message }, 'Address report pipeline failed');
    sendSSE(res, { phase: 'error', error: (e as Error).message });
    res.end();
  }
});

// ── Site Visit Mode ─────────────────────────────────────────────────────────

// Site visit photo upload — saves photo + metadata to _site_visit/photos/
const siteVisitPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are accepted'));
  },
});

app.post('/api/projects/:id/site-visit/photo', siteVisitPhotoUpload.single('photo'), async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const p = loadProject(id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    const svDir = path.join('uploads', id, '_site_visit', 'photos');
    fs.ensureDirSync(svDir);

    const existing = fs.readdirSync(svDir).filter(f => f.startsWith('photo_')).length;
    const num = String(existing + 1).padStart(3, '0');
    const ext = path.extname(req.file.originalname) || '.jpg';
    const filename = `photo_${num}${ext}`;

    await fs.writeFile(path.join(svDir, filename), req.file.buffer);

    // Save metadata
    const meta = {
      filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      capturedAt: new Date().toISOString(),
      caption: req.body?.caption || '',
      gpsLat: req.body?.lat ? parseFloat(req.body.lat) : null,
      gpsLng: req.body?.lng ? parseFloat(req.body.lng) : null,
    };
    await fs.writeFile(path.join(svDir, `photo_${num}_meta.json`), JSON.stringify(meta, null, 2));

    res.json({ ok: true, filename, meta });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Site visit voice memo — transcribes audio and extracts observations
app.post('/api/projects/:id/site-visit/voice', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '30mb' }), async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const p = loadProject(id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (!llm) return res.status(503).json({ error: 'AI not available for transcription' });

    const svDir = path.join('uploads', id, '_site_visit', 'voice');
    fs.ensureDirSync(svDir);

    const audioBuffer = req.body as Buffer;
    if (!audioBuffer || audioBuffer.length === 0) return res.status(400).json({ error: 'No audio data' });

    const mimeType = (req.headers['content-type'] as string) || 'audio/webm';
    const existing = fs.readdirSync(svDir).filter(f => f.startsWith('memo_') && !f.endsWith('.json') && !f.endsWith('.txt')).length;
    const num = String(existing + 1).padStart(3, '0');
    const ext = mimeType.includes('mp4') ? '.mp4' : mimeType.includes('wav') ? '.wav' : '.webm';
    const audioFilename = `memo_${num}${ext}`;

    await fs.writeFile(path.join(svDir, audioFilename), audioBuffer);

    // Transcribe using VoiceTranscriberSkill
    const { VoiceTranscriberSkill } = await import('./skills/voice-transcriber.js');
    const transcriber = new VoiceTranscriberSkill(config, llm);
    const result = await transcriber.process({
      audioBase64: audioBuffer.toString('base64'),
      mimeType,
      projectContext: {
        propertyAddress: p.propertyAddress || 'Property',
        projectName: p.name,
      },
    });

    if (result.success) {
      // Save transcript
      await fs.writeFile(path.join(svDir, `memo_${num}.txt`), result.data.transcript);
      await fs.writeFile(path.join(svDir, `memo_${num}.json`), JSON.stringify(result.data, null, 2));

      // Merge observations into project
      if (!p.siteVisitObservations) p.siteVisitObservations = [];
      p.siteVisitObservations.push(...result.data.observations);
      saveProject(id, p);

      res.json({
        ok: true,
        audioFilename,
        transcript: result.data.transcript,
        observations: result.data.observations,
        durationSeconds: result.data.durationSeconds,
        costUsd: result.data.costUsd,
      });
    } else {
      res.json({ ok: false, audioFilename, error: result.error });
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET site visit data — returns photos + voice memos + observations
app.get('/api/projects/:id/site-visit', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const p = loadProject(id);
    if (!p) return res.status(404).json({ error: 'Not found' });

    const svBase = path.join('uploads', id, '_site_visit');
    const photoDir = path.join(svBase, 'photos');
    const voiceDir = path.join(svBase, 'voice');

    const photos: any[] = [];
    if (fs.existsSync(photoDir)) {
      const metaFiles = fs.readdirSync(photoDir).filter(f => f.endsWith('_meta.json'));
      for (const mf of metaFiles) {
        try {
          const meta = JSON.parse(await fs.readFile(path.join(photoDir, mf), 'utf-8'));
          photos.push({ ...meta, url: `/uploads/${id}/_site_visit/photos/${meta.filename}` });
        } catch {}
      }
    }

    const voiceMemos: any[] = [];
    if (fs.existsSync(voiceDir)) {
      const jsonFiles = fs.readdirSync(voiceDir).filter(f => f.endsWith('.json'));
      for (const jf of jsonFiles) {
        try {
          const data = JSON.parse(await fs.readFile(path.join(voiceDir, jf), 'utf-8'));
          voiceMemos.push(data);
        } catch {}
      }
    }

    res.json({
      photos,
      voiceMemos,
      observations: p.siteVisitObservations || [],
      totalPhotos: photos.length,
      totalMemos: voiceMemos.length,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Serve site visit photos as static files
app.use('/uploads', express.static('uploads'));

// ── FTP / SFTP Server ───────────────────────────────────────────────────────

/** Start the SFTP server and wire file-received events to the pipeline */
async function startFTPServer(watchDir?: string): Promise<void> {
  if (ftpReceiver) {
    logger.warn('FTP server already running');
    return;
  }

  const ftpConfig = {
    ...config.ftp,
    watch_directory: watchDir || config.ftp.watch_directory,
    watch_mode: 'sftp' as const,
  };

  ftpReceiver = new FileReceiver(ftpConfig);

  // When a PDF lands via SFTP, copy it into a new auto-pipeline project
  ftpReceiver.on('file-received', async (event) => {
    logger.info(
      { projectId: event.projectId, filename: event.filename },
      `FTP file received: ${event.filename}`
    );

    // Copy the file into an uploads/<uuid> directory and run classification
    try {
      const id = uuidv4();
      const dir = path.join('uploads', id);
      fs.ensureDirSync(dir);
      fs.copySync(event.localPath, path.join(dir, event.filename));

      const project: ProjectState = {
        id, name: `FTP-${event.projectId || id.slice(0, 8)}`,
        clientName: '', propertyAddress: '',
        reportType: 'ESAI', isSbaLoan: false,
        reportDate: new Date().toISOString().split('T')[0],
        epName: 'Michael Miller',
        createdAt: new Date().toISOString(), status: 'classifying', files: [],
      };

      let pc = 0;
      const ftpExt = path.extname(event.filename).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ftpExt)) {
        pc = 1;
      } else {
        try { pc = await getPageCount(path.join(dir, event.filename)); } catch {}
      }

      // Heuristic classify
      const record = heuristicClassify(event.filename);
      record.pageCount = pc;
      project.files.push(record);
      project.status = 'classified';
      saveProject(id, project);

      logger.info(
        { id, filename: event.filename, type: record.documentType, confidence: record.confidence },
        `FTP auto-classified: ${event.filename} → ${record.documentType}`
      );
    } catch (err) {
      logger.error({ error: (err as Error).message, filename: event.filename }, 'FTP auto-process failed');
    }
  });

  ftpReceiver.on('connection', (info) => {
    logger.info({ user: info.username, ip: info.ip }, 'SFTP client connected');
  });

  ftpReceiver.on('error', (err) => {
    logger.error({ error: err.message }, 'FTP server error');
  });

  await ftpReceiver.start();
  logger.info(
    { port: config.ftp.server?.port || 2222, watchDir: ftpConfig.watch_directory },
    'SFTP server started — upload PDFs to trigger pipeline'
  );
}

// GET /api/ftp/status — check FTP server status
app.get('/api/ftp/status', (req, res) => {
  if (!ftpReceiver) {
    return res.json({ running: false, message: 'FTP server not started' });
  }
  res.json(ftpReceiver.getStatus());
});

// POST /api/ftp/start — start FTP server (optionally with custom watch dir)
app.post('/api/ftp/start', async (req, res) => {
  try {
    if (ftpReceiver) {
      return res.json({ message: 'FTP server already running', ...ftpReceiver.getStatus() });
    }
    const watchDir = req.body?.watchDir;
    await startFTPServer(watchDir);
    res.json({ message: 'FTP server started', ...ftpReceiver!.getStatus() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/ftp/stop — stop FTP server
app.post('/api/ftp/stop', async (req, res) => {
  try {
    if (!ftpReceiver) {
      return res.json({ running: false, message: 'FTP server not running' });
    }
    await ftpReceiver.stop();
    ftpReceiver = null;
    res.json({ running: false, message: 'FTP server stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Remote FTP Pull Client (Gap 7) ──────────────────────────────────────────

// GET /api/ftp/remote/status — get remote FTP connection + poll state
app.get('/api/ftp/remote/status', (req, res) => {
  if (!remoteFtpClient) {
    return res.json({ connected: false, polling: false, message: 'Remote FTP client not initialized' });
  }
  res.json(remoteFtpClient.getStatus());
});

// GET /api/ftp/remote/browse — list folders on remote FTP
app.get('/api/ftp/remote/browse', async (req, res) => {
  try {
    if (!remoteFtpClient) {
      const remoteCfg = (config as any).ftp?.remote;
      if (!remoteCfg?.enabled || !remoteCfg?.host) {
        return res.status(400).json({ error: 'Remote FTP not configured. Set ftp.remote in config.yaml.' });
      }
      remoteFtpClient = new FTPPullClient(remoteCfg as RemoteFTPConfig);
      await remoteFtpClient.connect();
    }

    const remotePath = (req.query.path as string) || undefined;
    const folders = await remoteFtpClient.listFolders(remotePath);
    res.json({ path: remotePath || remoteFtpClient.getStatus().watchDirectory, folders });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/ftp/remote/pull — pull a specific folder from remote FTP
app.post('/api/ftp/remote/pull', async (req, res) => {
  try {
    const { remotePath, projectName } = req.body || {};
    if (!remotePath) {
      return res.status(400).json({ error: 'remotePath is required' });
    }

    if (!remoteFtpClient) {
      const remoteCfg = (config as any).ftp?.remote;
      if (!remoteCfg?.enabled || !remoteCfg?.host) {
        return res.status(400).json({ error: 'Remote FTP not configured. Set ftp.remote in config.yaml.' });
      }
      remoteFtpClient = new FTPPullClient(remoteCfg as RemoteFTPConfig);
      await remoteFtpClient.connect();
    }

    const folderName = projectName || path.basename(remotePath);
    const localDir = path.resolve(config.ftp.download_directory || './downloads', folderName);

    logger.info({ remotePath, localDir }, 'Pulling folder from remote FTP');
    const result = await remoteFtpClient.pullFolder(remotePath, localDir);

    res.json({
      message: `Pulled ${result.pulled.length} files, skipped ${result.skipped} already-downloaded`,
      localDir,
      pulled: result.pulled.map((f) => ({ filename: f.filename, size: f.size })),
      skipped: result.skipped,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/ftp/remote/auto-poll — enable/disable automatic polling
app.post('/api/ftp/remote/auto-poll', async (req, res) => {
  try {
    const { enabled, interval } = req.body || {};

    if (enabled) {
      if (!remoteFtpClient) {
        const remoteCfg = (config as any).ftp?.remote;
        if (!remoteCfg?.enabled || !remoteCfg?.host) {
          return res.status(400).json({ error: 'Remote FTP not configured. Set ftp.remote in config.yaml.' });
        }
        const clientConfig = { ...remoteCfg } as RemoteFTPConfig;
        if (interval) clientConfig.poll_interval_seconds = interval;
        remoteFtpClient = new FTPPullClient(clientConfig);
        await remoteFtpClient.connect();
      }

      remoteFtpClient.startPolling((folder) => {
        logger.info({ folder: folder.folderName }, 'Auto-poll detected new folder');
      });

      res.json({ message: 'Auto-polling enabled', ...remoteFtpClient.getStatus() });
    } else {
      if (remoteFtpClient) {
        remoteFtpClient.stopPolling();
      }
      res.json({ message: 'Auto-polling disabled', polling: false });
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Standalone PDF Compressor (Gap 6) ────────────────────────────────────────

const compressUpload = multer({
  dest: path.join('uploads', '_tools', 'compress', '_incoming'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  },
});

/** Simple cleanup: remove compress job dirs older than 1 hour */
async function cleanupOldCompressJobs() {
  const baseDir = path.join('uploads', '_tools', 'compress');
  try {
    if (!fs.existsSync(baseDir)) return;
    const entries = await fs.readdir(baseDir);
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of entries) {
      if (entry === '_incoming') continue;
      const entryPath = path.join(baseDir, entry);
      try {
        const stat = await fs.stat(entryPath);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          await fs.remove(entryPath);
          logger.info({ jobId: entry }, 'Cleaned up old compress job');
        }
      } catch { /* ignore individual cleanup errors */ }
    }
  } catch { /* ignore cleanup errors */ }
}

// POST /api/tools/compress — compress a PDF, optionally split if still too large
app.post('/api/tools/compress', compressUpload.single('file'), async (req: Request, res: Response) => {
  // Fire-and-forget cleanup
  cleanupOldCompressJobs().catch(() => {});

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded. Send as multipart field "file".' });
    }

    const jobId = uuidv4();
    const jobDir = path.join('uploads', '_tools', 'compress', jobId);
    await fs.ensureDir(jobDir);

    // Move uploaded file into job dir
    const inputPath = path.join(jobDir, req.file.originalname);
    await fs.move(req.file.path, inputPath, { overwrite: true });

    const maxSizeMB = parseFloat(req.query.maxSizeMB as string) || 25;
    const qualityParam = (req.query.quality as string) || 'ebook';
    const quality = (['screen', 'ebook', 'printer', 'prepress'].includes(qualityParam)
      ? qualityParam
      : 'ebook') as 'screen' | 'ebook' | 'printer' | 'prepress';

    const { compressPDF } = await import('./core/pdf-postprocess.js');
    const compressedPath = path.join(jobDir, 'compressed.pdf');
    const compressResult = await compressPDF(inputPath, compressedPath, { quality, maxSizeMB });

    // Check if we need to split
    let splitParts: Array<{ filename: string; sizeMB: number; downloadUrl: string }> | null = null;

    if (compressResult.outputSizeMB > maxSizeMB) {
      const { splitReport } = await import('./core/pdf-postprocess.js');
      // splitReport needs projectFiles for smart split points — for standalone use,
      // provide a minimal single-file list so it falls back to page-based splitting
      const splitResult = await splitReport(compressedPath, [
        { filename: req.file.originalname, section: 'body', label: 'Full Document' },
      ], { maxPartSizeMB: maxSizeMB });

      if (splitResult.totalParts > 1) {
        splitParts = [];
        for (const part of splitResult.parts) {
          const partFilename = path.basename(part.path);
          // Move split parts into job dir if they aren't already there
          const partInJob = path.join(jobDir, partFilename);
          if (part.path !== partInJob) {
            await fs.move(part.path, partInJob, { overwrite: true });
          }
          splitParts.push({
            filename: partFilename,
            sizeMB: part.sizeMB,
            downloadUrl: `/api/tools/compress/${jobId}/download?part=${encodeURIComponent(partFilename)}`,
          });
        }
      }
    }

    const result: any = {
      jobId,
      inputSizeMB: compressResult.inputSizeMB,
      outputSizeMB: compressResult.outputSizeMB,
      reductionPercent: compressResult.reductionPercent,
      downloadUrl: `/api/tools/compress/${jobId}/download`,
      splitParts,
    };

    // Write result metadata for the status endpoint
    await fs.writeJson(path.join(jobDir, 'result.json'), result);

    res.json(result);
  } catch (err: any) {
    logger.error({ error: err.message }, 'PDF compress failed');
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tools/compress/:id — get status/results of a compression job
app.get('/api/tools/compress/:id', async (req: Request, res: Response) => {
  try {
    const jobDir = path.join('uploads', '_tools', 'compress', req.params.id as string);
    const resultPath = path.join(jobDir, 'result.json');
    if (!fs.existsSync(resultPath)) {
      return res.status(404).json({ error: 'Compress job not found' });
    }
    const result = await fs.readJson(resultPath);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tools/compress/:id/download — download compressed file or a specific split part
app.get('/api/tools/compress/:id/download', async (req: Request, res: Response) => {
  try {
    const jobDir = path.join('uploads', '_tools', 'compress', req.params.id as string);
    if (!fs.existsSync(jobDir)) {
      return res.status(404).json({ error: 'Compress job not found' });
    }

    const partName = req.query.part as string | undefined;
    let filePath: string;

    if (partName) {
      // Sanitize part name to prevent directory traversal
      const safeName = path.basename(partName);
      filePath = path.join(jobDir, safeName);
    } else {
      filePath = path.join(jobDir, 'compressed.pdf');
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.download(filePath);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Standalone PDF Split (no compression) ────────────────────────────────────

const splitUpload = multer({
  dest: path.join('uploads', '_tools', 'split', '_incoming'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  },
});

app.post('/api/tools/split', splitUpload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded. Send as multipart field "file".' });
    }

    const jobId = uuidv4();
    const jobDir = path.join('uploads', '_tools', 'split', jobId);
    await fs.ensureDir(jobDir);

    const inputPath = path.join(jobDir, req.file.originalname);
    await fs.move(req.file.path, inputPath, { overwrite: true });

    const maxSizeMB = parseFloat(req.query.maxSizeMB as string) || 25;

    const { splitReport } = await import('./core/pdf-postprocess.js');
    const splitResult = await splitReport(inputPath, [
      { filename: req.file.originalname, section: 'body', label: 'Full Document' },
    ], { maxPartSizeMB: maxSizeMB });

    const inputStat = await fs.stat(inputPath);
    const inputSizeMB = Math.round((inputStat.size / (1024 * 1024)) * 100) / 100;

    const parts: Array<{ filename: string; sizeMB: number; downloadUrl: string }> = [];
    for (const part of splitResult.parts) {
      const partFilename = path.basename(part.path);
      const partInJob = path.join(jobDir, partFilename);
      if (part.path !== partInJob) {
        await fs.move(part.path, partInJob, { overwrite: true });
      }
      parts.push({
        filename: partFilename,
        sizeMB: part.sizeMB,
        downloadUrl: `/api/tools/split/${jobId}/download?part=${encodeURIComponent(partFilename)}`,
      });
    }

    const result = {
      jobId,
      inputSizeMB,
      totalParts: splitResult.totalParts,
      parts,
      message: splitResult.totalParts <= 1
        ? `File is already under ${maxSizeMB}MB — no split needed.`
        : `Split into ${splitResult.totalParts} parts.`,
    };

    await fs.writeJson(path.join(jobDir, 'result.json'), result);
    res.json(result);
  } catch (err: any) {
    logger.error({ error: err.message }, 'PDF split failed');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tools/split/:id/download', async (req: Request, res: Response) => {
  try {
    const jobDir = path.join('uploads', '_tools', 'split', req.params.id as string);
    if (!fs.existsSync(jobDir)) {
      return res.status(404).json({ error: 'Split job not found' });
    }
    const partName = req.query.part as string;
    if (!partName) {
      return res.status(400).json({ error: 'part query param is required' });
    }
    const safeName = path.basename(partName);
    const filePath = path.join(jobDir, safeName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Part file not found' });
    }
    res.download(filePath);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PDF to Word Conversion ───────────────────────────────────────────────────

const convertUpload = multer({
  dest: path.join('uploads', '_tools', 'convert', '_incoming'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  },
});

app.post('/api/tools/convert', convertUpload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded. Send as multipart field "file".' });
    }

    const jobId = uuidv4();
    const jobDir = path.join('uploads', '_tools', 'convert', jobId);
    await fs.ensureDir(jobDir);

    const inputPath = path.join(jobDir, req.file.originalname);
    await fs.move(req.file.path, inputPath, { overwrite: true });

    // Find LibreOffice
    const { execSync } = await import('child_process');
    const loCandidates = [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/usr/bin/libreoffice', '/usr/local/bin/libreoffice', '/opt/homebrew/bin/soffice',
    ];
    let soffice: string | null = null;
    for (const c of loCandidates) {
      if (fs.existsSync(c)) { soffice = c; break; }
    }
    if (!soffice) {
      try {
        execSync('which libreoffice', { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
        soffice = 'libreoffice';
      } catch {}
    }
    if (!soffice) {
      return res.status(500).json({ error: 'LibreOffice not found — cannot convert PDF to Word. Install LibreOffice to enable this feature.' });
    }

    // Convert PDF → DOCX via LibreOffice (writer_pdf_import filter required for PDF input)
    const baseName = path.basename(req.file.originalname, '.pdf');
    execSync(`"${soffice}" --headless --infilter="writer_pdf_import" --convert-to docx --outdir "${jobDir}" "${inputPath}"`, {
      encoding: 'utf-8',
      timeout: 120000,
      stdio: 'pipe',
    });

    const outputPath = path.join(jobDir, `${baseName}.docx`);
    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Conversion failed — LibreOffice did not produce output.' });
    }

    const inputStat = await fs.stat(inputPath);
    const outputStat = await fs.stat(outputPath);

    const result = {
      jobId,
      inputSizeMB: Math.round((inputStat.size / (1024 * 1024)) * 100) / 100,
      outputSizeMB: Math.round((outputStat.size / (1024 * 1024)) * 100) / 100,
      outputFilename: `${baseName}.docx`,
      downloadUrl: `/api/tools/convert/${jobId}/download`,
    };

    await fs.writeJson(path.join(jobDir, 'result.json'), result);
    res.json(result);
  } catch (err: any) {
    logger.error({ error: err.message }, 'PDF-to-Word conversion failed');
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tools/convert/:id/download', async (req: Request, res: Response) => {
  try {
    const jobDir = path.join('uploads', '_tools', 'convert', req.params.id as string);
    const resultPath = path.join(jobDir, 'result.json');
    if (!fs.existsSync(resultPath)) {
      return res.status(404).json({ error: 'Convert job not found' });
    }
    const result = await fs.readJson(resultPath);
    const filePath = path.join(jobDir, result.outputFilename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Converted file not found' });
    }
    res.download(filePath, result.outputFilename);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Prepare for Client Delivery ──────────────────────────────────────────────

app.post('/api/projects/:id/prepare-delivery', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const projectDir = path.join('uploads', id);
  const assembledPath = path.join(projectDir, 'assembled.pdf');

  if (!fs.existsSync(assembledPath)) {
    return res.status(404).json({ error: 'No assembled PDF found. Run assembly first.' });
  }

  const { maxPartSizeMB = 20, quality = 'ebook' } = req.body || {};

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (data: any) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const inputSizeMB = (await fs.stat(assembledPath)).size / (1024 * 1024);
    send({ phase: 'compressing', message: `Compressing ${inputSizeMB.toFixed(1)}MB report (quality: ${quality})...` });

    // Compress
    const deliveryDir = path.join(projectDir, '_delivery');
    await fs.ensureDir(deliveryDir);
    const compressedPath = path.join(deliveryDir, 'report-compressed.pdf');

    let finalPath = assembledPath;
    let finalSizeMB = inputSizeMB;

    try {
      const { compressPDF } = await import('./core/pdf-postprocess.js');
      const compressResult = await compressPDF(assembledPath, compressedPath, { quality, maxSizeMB: maxPartSizeMB });
      finalPath = compressedPath;
      finalSizeMB = compressResult.outputSizeMB;
      send({
        phase: 'compressed',
        inputSizeMB: +inputSizeMB.toFixed(1),
        outputSizeMB: +compressResult.outputSizeMB.toFixed(1),
        reductionPercent: +compressResult.reductionPercent.toFixed(0),
      });
    } catch (err) {
      send({ phase: 'compressed', skipped: true, reason: (err as Error).message });
    }

    // Split if needed
    const parts: Array<{ label: string; sizeMB: number; pageCount: number; downloadUrl: string }> = [];

    if (finalSizeMB > maxPartSizeMB) {
      send({ phase: 'splitting', message: `Report is ${finalSizeMB.toFixed(1)}MB — splitting into ${maxPartSizeMB}MB parts...` });

      try {
        const { splitReport } = await import('./core/pdf-postprocess.js');
        const p = loadProject(id);
        const projectFiles = p?.files || [{ filename: 'report.pdf', documentType: 'full_report', section: 'body', label: 'Full Report', confidence: 1 }];
        const splitResult = await splitReport(finalPath, projectFiles, { maxPartSizeMB });

        for (const sp of splitResult.parts) {
          // Copy split parts into delivery dir
          const destName = path.basename(sp.path);
          const destPath = path.join(deliveryDir, destName);
          if (sp.path !== destPath) await fs.copy(sp.path, destPath, { overwrite: true });
          parts.push({
            label: sp.label,
            sizeMB: +sp.sizeMB.toFixed(1),
            pageCount: sp.pageCount,
            downloadUrl: `/api/projects/${id}/delivery/${destName}`,
          });
        }

        send({ phase: 'split', totalParts: parts.length, parts });
      } catch (err) {
        send({ phase: 'split', skipped: true, reason: (err as Error).message });
      }
    }

    // Create ZIP of all delivery files
    const zipPath = path.join(deliveryDir, 'report-delivery.zip');
    try {
      const AdmZipLib = (await import('adm-zip')).default;
      const zip = new AdmZipLib();
      if (parts.length > 0) {
        for (const p of parts) {
          const partFile = path.join(deliveryDir, path.basename(p.downloadUrl));
          if (fs.existsSync(partFile)) zip.addLocalFile(partFile);
        }
      } else {
        zip.addLocalFile(finalPath, '', 'report.pdf');
      }
      zip.writeZip(zipPath);
      send({ phase: 'zipped', zipUrl: `/api/projects/${id}/delivery/report-delivery.zip` });
    } catch (err) {
      send({ phase: 'zipped', skipped: true, reason: (err as Error).message });
    }

    // Done
    const deliveryFiles = parts.length > 0
      ? parts
      : [{ label: 'Full Report', sizeMB: +finalSizeMB.toFixed(1), pageCount: 0, downloadUrl: `/api/projects/${id}/delivery/report-compressed.pdf` }];

    send({
      phase: 'done',
      files: deliveryFiles,
      zipUrl: `/api/projects/${id}/delivery/report-delivery.zip`,
      originalSizeMB: +inputSizeMB.toFixed(1),
      finalSizeMB: +finalSizeMB.toFixed(1),
    });
  } catch (err) {
    send({ phase: 'error', error: (err as Error).message });
  }

  res.end();
});

// ── PDF Review & Edit Endpoints ─────────────────────────────────────────────

// Serve assembled PDF inline for PDF.js
app.get('/api/projects/:id/view', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const fp = path.join('uploads', id, 'assembled.pdf');
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'No assembled PDF' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Accept-Ranges', 'bytes');
  fs.createReadStream(fp).pipe(res);
});

// Upload a PDF for later insertion; returns { tempId, pageCount, filename }
app.post('/api/projects/:id/upload-insert', uploadInsert.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const tempId = path.basename(req.file.filename, '.pdf');
    const pdfBytes = await fs.readFile(req.file.path);
    const doc = await PDFDocument.load(pdfBytes);
    res.json({ tempId, pageCount: doc.getPageCount(), filename: req.file.originalname });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Apply page-level edits to assembled.pdf; backs up original on first call
app.post('/api/projects/:id/apply-edits', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    type PageEntry = { type: 'original'; page: number } | { type: 'insert'; tempId: string; page: number };
    const { pageOrder } = req.body as { pageOrder: PageEntry[] };
    if (!Array.isArray(pageOrder) || pageOrder.length === 0)
      return res.status(400).json({ error: 'pageOrder must be a non-empty array' });
    const assembledPath = path.join('uploads', id, 'assembled.pdf');
    if (!fs.existsSync(assembledPath)) return res.status(404).json({ error: 'No assembled PDF found' });
    const originalPath = path.join('uploads', id, 'assembled-original.pdf');
    if (!fs.existsSync(originalPath)) await fs.copy(assembledPath, originalPath);
    const assembledDoc = await PDFDocument.load(await fs.readFile(assembledPath));
    const insertCache: Record<string, PDFDocument> = {};
    for (const entry of pageOrder) {
      if (entry.type === 'insert' && !insertCache[entry.tempId]) {
        const ip = path.join('uploads', id, '_inserts', `${entry.tempId}.pdf`);
        if (!fs.existsSync(ip)) return res.status(400).json({ error: `Insert file not found: ${entry.tempId}` });
        insertCache[entry.tempId] = await PDFDocument.load(await fs.readFile(ip));
      }
    }
    const newDoc = await PDFDocument.create();
    for (const entry of pageOrder) {
      const src = entry.type === 'original' ? assembledDoc : insertCache[(entry as any).tempId];
      const [pg] = await newDoc.copyPages(src, [entry.page - 1]);
      newDoc.addPage(pg);
    }
    await fs.writeFile(assembledPath, await newDoc.save());
    res.json({ success: true, newPageCount: newDoc.getPageCount() });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Restore the original AI-assembled PDF from backup
app.post('/api/projects/:id/restore-original', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const originalPath = path.join('uploads', id, 'assembled-original.pdf');
    const assembledPath = path.join('uploads', id, 'assembled.pdf');
    if (!fs.existsSync(originalPath)) return res.status(404).json({ error: 'No original backup found' });
    await fs.copy(originalPath, assembledPath);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Serve delivery files
app.get('/api/projects/:id/delivery/:filename', (req: Request, res: Response) => {
  const filePath = path.join('uploads', req.params.id as string, '_delivery', req.params.filename as string);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

// ── Error Handler ───────────────────────────────────────────────────────────

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  logger.error({ error: err.message, path: req.path }, 'Error');
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

// ── Start ───────────────────────────────────────────────────────────────────

async function start() {
  await initPipeline();

  // Auto-start SFTP server with Desktop demo folder
  const demoFtpDir = path.join(process.env.HOME || '/Users/bp', 'Desktop', 'ODIC-FTP-Demo', 'incoming');
  fs.ensureDirSync(demoFtpDir);

  try {
    await startFTPServer(demoFtpDir);
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'SFTP server failed to start — continuing without it');
  }

  app.listen(PORT, () => {
    logger.info('');
    logger.info('  ╔═══════════════════════════════════════════════════════╗');
    logger.info(`  ║  ODIC ESA Pipeline — http://localhost:${PORT}              ║`);
    logger.info(`  ║  AI: ${llm ? 'ENABLED (Haiku + Sonnet)' : 'DISABLED (no key)'}${llm ? '          ' : '             '}║`);
    logger.info('  ║  SFTP: port 2222  (user: odic / pass: odic-dev)      ║');
    logger.info('  ║  Dashboard: /    API: /api/health                     ║');
    logger.info('  ╚═══════════════════════════════════════════════════════╝');
    logger.info('');
    logger.info(`  Drop PDFs into: ~/Desktop/ODIC-FTP-Demo/incoming/<project-name>/`);
    logger.info(`  Or SFTP upload:  sftp -P 2222 odic@localhost`);
    logger.info('');
  });
}

start().catch(err => { logger.fatal(err.message); process.exit(1); });
