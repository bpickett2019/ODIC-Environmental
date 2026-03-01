#!/usr/bin/env node
/**
 * ODIC ESA Pipeline — CLI Runner
 *
 * Usage:
 *   npx tsx src/cli.ts <project-folder> [options]
 *
 * Modes:
 *   --auto        AI classifies everything automatically (needs ANTHROPIC_API_KEY)
 *   --manual      Use filename-based mapping (no AI, no API cost)
 *   --manifest    Use a manifest.json file in the project folder for explicit mapping
 *
 * Options:
 *   --project-id <id>      Override project ID (default: folder name)
 *   --report-type <type>   ESAI | RSRA | DRV | ECA | ESAII | IAQ (default: ESAI)
 *   --sba                  Flag as SBA loan report
 *   --output <path>        Override output PDF path
 *   --skip-dividers        Don't generate appendix divider pages
 *   --memory <mb>          Set max Node heap (for huge PDFs, e.g., --memory 8192)
 *
 * Examples:
 *   npx tsx src/cli.ts ./projects/6384578 --auto
 *   npx tsx src/cli.ts ./projects/6384578 --manual --sba
 *   npx tsx src/cli.ts ./projects/6384578 --manifest
 *
 * Manifest format (manifest.json):
 *   {
 *     "report_type": "ESAI",
 *     "is_sba": false,
 *     "documents": [
 *       { "filename": "cover.pdf", "type": "cover_page", "section": "front_cover" },
 *       { "filename": "EDR.pdf", "type": "edr_report", "section": "appendix_c_database_report" },
 *       ...
 *     ]
 *   }
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import pino from 'pino';
import { loadAppConfig, loadESATemplate, loadDocumentTypes } from './core/config-loader.js';
import { StateManager } from './core/state.js';
import { LLMClient } from './core/llm-client.js';
import {
  getPageCount,
  isValidPDF,
  hashFile,
  ensureDir,
  mergePDFs,
  createTextPage,
  type MergeInput,
} from './core/pdf-utils.js';
import { PDFReaderSkill } from './skills/pdf-reader.js';
import { DocumentClassifierSkill } from './skills/document-classifier.js';
import { ESAI_SECTION_ORDER, DOCUMENT_TYPE_TO_DEFAULT_SECTION } from './types/documents.js';
import type {
  DocumentType,
  ReportSection,
  ReportType,
  ClassificationResult,
} from './types/index.js';
import type { ESATemplate } from './core/config-loader.js';

const logger = pino({
  name: 'CLI',
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss' },
  },
});

// ── Argument Parsing ──────────────────────────────────────────────────────────

interface CLIArgs {
  projectFolder: string;
  mode: 'auto' | 'manual' | 'manifest';
  projectId: string;
  reportType: ReportType;
  isSba: boolean;
  outputPath: string | null;
  skipDividers: boolean;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
ODIC ESA Pipeline — Report Assembly CLI

Usage:
  npx tsx src/cli.ts <project-folder> [options]

Modes:
  --auto        AI classifies docs automatically (needs ANTHROPIC_API_KEY)
  --manual      Filename-based mapping (no AI cost)
  --manifest    Use manifest.json for explicit mapping

Options:
  --project-id <id>      Override project ID
  --report-type <type>   ESAI | RSRA | DRV | ECA | ESAII | IAQ
  --sba                  SBA loan report
  --output <path>        Output PDF path
  --skip-dividers        No appendix divider pages

Examples:
  npx tsx src/cli.ts ./projects/6384578 --manual
  npx tsx src/cli.ts ./projects/6384578 --auto --sba
  npx tsx src/cli.ts ./projects/6384578 --manifest
`);
    process.exit(0);
  }

  const projectFolder = path.resolve(args[0]);

  const mode: CLIArgs['mode'] = args.includes('--manifest')
    ? 'manifest'
    : args.includes('--auto')
    ? 'auto'
    : 'manual';

  const projectIdIdx = args.indexOf('--project-id');
  const projectId = projectIdIdx >= 0
    ? args[projectIdIdx + 1]
    : path.basename(projectFolder);

  const reportTypeIdx = args.indexOf('--report-type');
  const reportType = (reportTypeIdx >= 0 ? args[reportTypeIdx + 1] : 'ESAI') as ReportType;

  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : null;

  return {
    projectFolder,
    mode,
    projectId,
    reportType,
    isSba: args.includes('--sba'),
    outputPath,
    skipDividers: args.includes('--skip-dividers'),
  };
}

// ── Filename-Based Classification (Manual Mode) ───────────────────────────────

/** Simple heuristics mapping filenames to document types */
function classifyByFilename(filename: string, pageCount: number): { type: DocumentType; section: ReportSection } {
  const fn = filename.toLowerCase();

  // EDR reports — filename containing EDR/radius is strong signal regardless of size
  if (fn.includes('edr') || (fn.includes('radius') && fn.includes('report')) || (fn.includes('database') && fn.includes('report') && pageCount > 10)) {
    return { type: 'edr_report', section: 'appendix_c_database_report' };
  }

  // Cover page
  if (fn.includes('cover')) {
    return { type: 'cover_page', section: 'front_cover' };
  }

  // Transmittal
  if (fn.includes('transmittal') || fn.includes('letter') && fn.includes('trans')) {
    return { type: 'transmittal_letter', section: 'front_transmittal' };
  }

  // Reliance letter
  if (fn.includes('reliance') || fn.includes('sba') && fn.includes('letter')) {
    return { type: 'reliance_letter', section: 'front_reliance' };
  }

  // Insurance
  if (fn.includes('insurance') || fn.includes('acord') || fn.includes('e&o') || fn.includes('eo_')) {
    return { type: 'insurance_certificate', section: 'front_insurance' };
  }

  // EP Declaration
  if (fn.includes('declaration') || fn.includes('ep_dec')) {
    return { type: 'ep_declaration', section: 'front_ep_declaration' };
  }

  // Aerial photographs (check BEFORE generic photos — "aerial_photos" should hit this)
  if (fn.includes('aerial')) {
    return { type: 'aerial_photograph', section: 'appendix_d_historical' };
  }

  // Site photos (generic photo match)
  if (fn.includes('photo') || fn.includes('site_photo') || fn.includes('photos')) {
    return { type: 'site_photograph', section: 'appendix_b_photographs' };
  }

  // Location map / Figure 1
  if (fn.includes('location') || fn.includes('figure_1') || fn.includes('fig1') || fn.includes('figure1')) {
    return { type: 'location_map', section: 'appendix_a_maps' };
  }

  // Plot plan / Figure 2
  if (fn.includes('plot') || fn.includes('figure_2') || fn.includes('fig2') || fn.includes('figure2')) {
    return { type: 'plot_plan', section: 'appendix_a_maps' };
  }

  // Sanborn maps
  if (fn.includes('sanborn')) {
    return { type: 'sanborn_map', section: 'appendix_d_historical' };
  }

  // Topographic maps
  if (fn.includes('topo') || fn.includes('topographic')) {
    return { type: 'topographic_map', section: 'appendix_d_historical' };
  }

  // City directories
  if (fn.includes('city_dir') || fn.includes('directory') || fn.includes('polk')) {
    return { type: 'city_directory', section: 'appendix_d_historical' };
  }

  // Fire insurance maps (non-Sanborn)
  if (fn.includes('fire_ins') || fn.includes('fire_map')) {
    return { type: 'fire_insurance_map', section: 'appendix_d_historical' };
  }

  // Agency records
  if (fn.includes('agency') || fn.includes('foia') || fn.includes('public_record')) {
    return { type: 'agency_records', section: 'appendix_e_agency_records' };
  }

  // EP Qualifications
  if (fn.includes('qualification') || fn.includes('resume') || fn.includes('ep_qual') || fn.includes('cv')) {
    return { type: 'ep_qualifications', section: 'appendix_f_qualifications' };
  }

  // Lab results
  if (fn.includes('lab') || fn.includes('analytical') || fn.includes('laboratory')) {
    return { type: 'lab_result', section: 'appendix_g_lab_results' };
  }

  // Boring logs
  if (fn.includes('boring') || fn.includes('well_log') || fn.includes('drill')) {
    return { type: 'boring_log', section: 'appendix_h_boring_logs' };
  }

  // Report body
  if (fn.includes('report') || fn.includes('body') || fn.includes('narrative')) {
    return { type: 'report_body', section: 'body_introduction' };
  }

  // Executive summary
  if (fn.includes('exec') || fn.includes('summary')) {
    return { type: 'executive_summary', section: 'body_executive_summary' };
  }

  // Findings
  if (fn.includes('finding') || fn.includes('recommendation')) {
    return { type: 'findings_recommendations', section: 'body_findings_recommendations' };
  }

  // Title records
  if (fn.includes('title')) {
    return { type: 'title_record', section: 'appendix_e_agency_records' };
  }

  // Default: supporting document
  return { type: 'supporting_document', section: 'appendix_i_additional' };
}

// ── Manifest Loader ───────────────────────────────────────────────────────────

interface ManifestEntry {
  filename: string;
  type: DocumentType;
  section: ReportSection;
}

interface ManifestFile {
  report_type?: string;
  is_sba?: boolean;
  documents: ManifestEntry[];
}

async function loadManifest(projectFolder: string): Promise<ManifestFile> {
  const manifestPath = path.join(projectFolder, 'manifest.json');
  const content = await fs.readFile(manifestPath, 'utf-8');
  return JSON.parse(content) as ManifestFile;
}

// ── Divider Generation ────────────────────────────────────────────────────────

const APPENDIX_DIVIDERS: Record<string, { letter: string; title: string; subtitle: string }> = {
  appendix_a_maps: { letter: 'A', title: 'APPENDIX A', subtitle: 'MAPS AND FIGURES' },
  appendix_b_photographs: { letter: 'B', title: 'APPENDIX B', subtitle: 'SITE PHOTOGRAPHS' },
  appendix_c_database_report: { letter: 'C', title: 'APPENDIX C', subtitle: 'DATABASE REPORT' },
  appendix_d_historical: { letter: 'D', title: 'APPENDIX D', subtitle: 'HISTORICAL RECORDS' },
  appendix_e_agency_records: { letter: 'E', title: 'APPENDIX E', subtitle: 'AGENCY RECORDS' },
  appendix_f_qualifications: { letter: 'F', title: 'APPENDIX F', subtitle: 'ENVIRONMENTAL PROFESSIONAL QUALIFICATIONS' },
  appendix_g_lab_results: { letter: 'G', title: 'APPENDIX G', subtitle: 'LABORATORY RESULTS' },
  appendix_h_boring_logs: { letter: 'H', title: 'APPENDIX H', subtitle: 'BORING LOGS' },
  appendix_i_additional: { letter: 'I', title: 'APPENDIX I', subtitle: 'ADDITIONAL DOCUMENTS' },
};

async function generateDivider(section: string, companyName: string): Promise<Buffer> {
  const divider = APPENDIX_DIVIDERS[section];
  if (!divider) return Buffer.alloc(0);

  type LineSpec = {
    text: string;
    fontSize?: number;
    bold?: boolean;
    align?: 'left' | 'center' | 'right';
    color?: { r: number; g: number; b: number };
  };

  const lines: LineSpec[] = [
    { text: companyName, fontSize: 10, align: 'center', color: { r: 0.3, g: 0.3, b: 0.3 } },
    { text: '', fontSize: 40 },
    { text: '', fontSize: 40 },
    { text: '', fontSize: 40 },
    { text: divider.title, fontSize: 28, bold: true, align: 'center' },
    { text: '', fontSize: 20 },
    { text: divider.subtitle, fontSize: 14, align: 'center', color: { r: 0.3, g: 0.3, b: 0.3 } },
  ];

  return createTextPage(lines);
}

// ── Within-Section Ordering ───────────────────────────────────────────────────

function getSortKey(section: string, docType: string): number {
  const orders: Record<string, Record<string, number>> = {
    appendix_a_maps: { location_map: 1, plot_plan: 2 },
    appendix_d_historical: { sanborn_map: 1, fire_insurance_map: 2, aerial_photograph: 3, topographic_map: 4, city_directory: 5 },
    appendix_e_agency_records: { agency_records: 1, regulatory_correspondence: 2, prior_environmental_report: 3, title_record: 4, tax_record: 5, building_permit: 6 },
  };
  return orders[section]?.[docType] ?? 50;
}

// ── Main Assembly ─────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║          ODIC Environmental — Report Assembly CLI           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Validate project folder
  if (!existsSync(args.projectFolder)) {
    console.error(`❌ Project folder not found: ${args.projectFolder}`);
    process.exit(1);
  }

  console.log(`📁 Project folder: ${args.projectFolder}`);
  console.log(`🆔 Project ID:     ${args.projectId}`);
  console.log(`📋 Report type:    ${args.reportType}`);
  console.log(`🏦 SBA loan:       ${args.isSba ? 'Yes' : 'No'}`);
  console.log(`🔧 Mode:           ${args.mode}`);
  console.log('');

  // Load config
  const config = await loadAppConfig();
  const template = await loadESATemplate();

  // Scan for PDF files
  const entries = await fs.readdir(args.projectFolder);
  const pdfFiles = entries.filter(f =>
    f.toLowerCase().endsWith('.pdf') && f !== 'manifest.json'
  ).sort();

  if (pdfFiles.length === 0) {
    console.error('❌ No PDF files found in project folder');
    process.exit(1);
  }

  console.log(`📄 Found ${pdfFiles.length} PDF files:\n`);

  // Classify each file
  interface DocEntry {
    filename: string;
    filePath: string;
    pageCount: number;
    docType: DocumentType;
    section: ReportSection;
    confidence: number;
  }

  const documents: DocEntry[] = [];
  let totalInputPages = 0;

  // Load classifications based on mode
  if (args.mode === 'manifest') {
    // ── Manifest mode: explicit file-to-section mapping
    const manifest = await loadManifest(args.projectFolder);
    console.log(`📋 Loaded manifest with ${manifest.documents.length} entries\n`);

    for (const entry of manifest.documents) {
      const filePath = path.join(args.projectFolder, entry.filename);
      if (!existsSync(filePath)) {
        console.log(`   ⚠ ${entry.filename} — FILE NOT FOUND, skipping`);
        continue;
      }
      const valid = await isValidPDF(filePath);
      if (!valid) {
        console.log(`   ⚠ ${entry.filename} — not a valid PDF, skipping`);
        continue;
      }
      const pageCount = await getPageCount(filePath);
      totalInputPages += pageCount;

      documents.push({
        filename: entry.filename,
        filePath,
        pageCount,
        docType: entry.type,
        section: entry.section,
        confidence: 1.0,
      });

      console.log(`   ✓ ${entry.filename} (${pageCount} pg) → ${entry.type} → ${entry.section}`);
    }
  } else if (args.mode === 'manual') {
    // ── Manual mode: filename-based heuristics
    for (const filename of pdfFiles) {
      const filePath = path.join(args.projectFolder, filename);
      const valid = await isValidPDF(filePath);
      if (!valid) {
        console.log(`   ⚠ ${filename} — not a valid PDF, skipping`);
        continue;
      }
      const pageCount = await getPageCount(filePath);
      totalInputPages += pageCount;

      const { type, section } = classifyByFilename(filename, pageCount);

      documents.push({
        filename,
        filePath,
        pageCount,
        docType: type,
        section,
        confidence: 0.8,
      });

      console.log(`   ✓ ${filename} (${pageCount} pg) → ${type} → ${section}`);
    }
  } else {
    // ── Auto mode: AI classification
    const apiKey = process.env[config.llm.api_key_env];
    if (!apiKey) {
      console.error(`❌ ${config.llm.api_key_env} not set. Use --manual mode or set the key.`);
      process.exit(1);
    }

    const llm = new LLMClient(config.llm);
    const reader = new PDFReaderSkill(config);
    const classifier = new DocumentClassifierSkill(config, llm);
    const docTypes = await loadDocumentTypes();

    for (const filename of pdfFiles) {
      const filePath = path.join(args.projectFolder, filename);
      const valid = await isValidPDF(filePath);
      if (!valid) {
        console.log(`   ⚠ ${filename} — not a valid PDF, skipping`);
        continue;
      }
      const pageCount = await getPageCount(filePath);
      totalInputPages += pageCount;

      // Read PDF
      const readResult = await reader.process({ filePath });
      if (!readResult.success) {
        console.log(`   ⚠ ${filename} — read failed, using filename heuristic`);
        const { type, section } = classifyByFilename(filename, pageCount);
        documents.push({ filename, filePath, pageCount, docType: type, section, confidence: 0.5 });
        continue;
      }

      // Classify
      const classResult = await classifier.process({
        readerOutput: readResult.data,
        docTypes,
        projectContext: {
          projectId: args.projectId,
          projectName: args.projectId,
          clientName: '',
          propertyAddress: '',
          reportType: args.reportType,
          isSbaLoan: args.isSba,
        },
        filename,
      });

      if (classResult.success) {
        const c = classResult.data.classification;
        documents.push({
          filename,
          filePath,
          pageCount,
          docType: c.documentType,
          section: c.suggestedSection,
          confidence: c.confidence,
        });
        const modelTag = classResult.data.models.includes('heuristic') ? '⚡' : '🤖';
        console.log(`   ${modelTag} ${filename} (${pageCount} pg) → ${c.documentType} (${(c.confidence * 100).toFixed(0)}%) → ${c.suggestedSection}`);
      } else {
        const { type, section } = classifyByFilename(filename, pageCount);
        documents.push({ filename, filePath, pageCount, docType: type, section, confidence: 0.3 });
        console.log(`   ⚠ ${filename} (${pageCount} pg) → fallback: ${type}`);
      }
    }

    console.log(`\n💰 AI cost: $${llm.getUsageStats().totalCostUsd.toFixed(4)}`);
  }

  console.log(`\n📊 Total input pages: ${totalInputPages}`);
  console.log(`📄 Documents to assemble: ${documents.length}\n`);

  if (documents.length === 0) {
    console.error('❌ No valid documents to assemble');
    process.exit(1);
  }

  // ── Organize into sections ───────────────────────────────────────────────

  // Group by section
  const sectionBuckets = new Map<ReportSection, DocEntry[]>();
  for (const doc of documents) {
    if (!sectionBuckets.has(doc.section)) {
      sectionBuckets.set(doc.section, []);
    }
    sectionBuckets.get(doc.section)!.push(doc);
  }

  // Sort within sections
  for (const [section, docs] of sectionBuckets) {
    docs.sort((a, b) => getSortKey(section, a.docType) - getSortKey(section, b.docType));
  }

  // ── Build merge list ─────────────────────────────────────────────────────

  console.log('🔧 Assembly order:\n');

  const mergeInputs: MergeInput[] = [];
  let generatedPages = 0;
  const tempDir = path.join(args.projectFolder, '_assembly_temp');
  await ensureDir(tempDir);

  for (const section of ESAI_SECTION_ORDER) {
    const docs = sectionBuckets.get(section);
    if (!docs || docs.length === 0) continue;

    // Skip SBA sections for non-SBA reports
    if (!args.isSba && (section === 'front_reliance' || section === 'body_sba_requirements')) continue;

    // Generate appendix divider
    if (!args.skipDividers && APPENDIX_DIVIDERS[section]) {
      const dividerPdf = await generateDivider(section, template.company);
      if (dividerPdf.length > 0) {
        const dividerPath = path.join(tempDir, `divider_${APPENDIX_DIVIDERS[section].letter}.pdf`);
        await fs.writeFile(dividerPath, dividerPdf);
        mergeInputs.push({ filePath: dividerPath, label: `📑 ${APPENDIX_DIVIDERS[section].title} Divider` });
        generatedPages++;
        console.log(`   📑 ${APPENDIX_DIVIDERS[section].title} (divider — 1 pg)`);
      }
    }

    // Add documents
    for (const doc of docs) {
      mergeInputs.push({ filePath: doc.filePath, label: doc.filename });
      console.log(`   📄 ${doc.filename} (${doc.pageCount} pg) [${doc.docType}]`);
    }
  }

  // Handle non-standard sections
  for (const [section, docs] of sectionBuckets) {
    if (ESAI_SECTION_ORDER.includes(section)) continue;
    for (const doc of docs) {
      mergeInputs.push({ filePath: doc.filePath, label: doc.filename });
      console.log(`   📄 ${doc.filename} (${doc.pageCount} pg) [${section}]`);
    }
  }

  const expectedTotal = totalInputPages + generatedPages;
  console.log(`\n📊 Expected output: ${totalInputPages} source + ${generatedPages} generated = ${expectedTotal} pages`);

  // ── Merge ────────────────────────────────────────────────────────────────

  console.log('\n⏳ Merging PDFs...');
  const mergeStart = Date.now();

  const mergeResult = await mergePDFs(mergeInputs);

  const mergeDuration = Date.now() - mergeStart;
  console.log(`✅ Merge complete in ${(mergeDuration / 1000).toFixed(1)}s`);

  // Page integrity check
  if (mergeResult.totalPages !== expectedTotal) {
    console.error(`\n❌ PAGE INTEGRITY FAILURE: expected ${expectedTotal} pages, got ${mergeResult.totalPages}`);
    console.error('   This is a critical error. The output may be corrupt.');
  } else {
    console.log(`✅ Page integrity: ${mergeResult.totalPages} pages (PASS)`);
  }

  // ── Write output ─────────────────────────────────────────────────────────

  const outputPath = args.outputPath ?? path.join(
    path.dirname(args.projectFolder),
    `${args.projectId}_assembled_report.pdf`
  );
  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, mergeResult.pdfBuffer);

  const fileSizeMB = mergeResult.pdfBuffer.length / 1024 / 1024;

  // Clean up temp
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Non-critical
  }

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  ✅ Report assembled successfully                           ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  console.log(`   Output:     ${outputPath}`);
  console.log(`   Pages:      ${mergeResult.totalPages}`);
  console.log(`   File size:  ${fileSizeMB.toFixed(1)} MB`);
  console.log(`   Duration:   ${(mergeDuration / 1000).toFixed(1)}s`);
  console.log('');
}

main().catch(err => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  if (process.env.LOG_LEVEL === 'debug') {
    console.error(err.stack);
  }
  process.exit(1);
});
