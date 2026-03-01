/**
 * Document Classifier Skill — AI-powered document type identification.
 *
 * Takes extracted text + page images from the PDF Reader and uses Claude
 * to determine what kind of document this is (cover page, EDR report,
 * site photograph, transmittal letter, etc.).
 *
 * Classification Strategy (3 layers, cheapest first):
 * 1. tryHeuristicFromFilename() — filename + size only, NO PDF reading
 * 2. tryHeuristicFromMetadata() — page count only, after cheap getPageCount()
 * 3. Haiku AI call — for genuinely ambiguous documents only
 *    (No Sonnet escalation — low-confidence docs go to Rose's review queue)
 *
 * The public heuristic methods are called by classify-step.ts BEFORE the PDF
 * reader runs, so well-named files never incur PDF reading or AI costs.
 *
 * Special handling:
 * - Very large documents (500+ pages) are almost certainly EDR reports
 * - SBA-specific documents (reliance letter, SOP 50 10 8 references)
 * - Cross-contamination detection (wrong project number in document)
 */

import type { AppConfig, ClassificationResult, ReportSection } from '../types/index.js';
import { DOCUMENT_TYPE_TO_DEFAULT_SECTION } from '../types/documents.js';
import type { DocumentType } from '../types/documents.js';
import { BaseSkill, type SkillResult } from './base.js';
import { LLMClient, type LLMResponse } from '../core/llm-client.js';
import type { DocumentTypesConfig, DocumentTypeDefinition } from '../core/config-loader.js';
import type { PDFReaderOutput } from './pdf-reader.js';
import type { EvidencePack } from '../core/evidence-extractor.js';

// ── Input / Output types ──────────────────────────────────────────────────────

export interface ClassifierInput {
  /** PDF reader output with text and images */
  readerOutput: PDFReaderOutput;
  /** Document type definitions from config */
  docTypes: DocumentTypesConfig;
  /** Project context for cross-contamination checking */
  projectContext: {
    projectId: string;
    projectName: string;
    clientName: string;
    propertyAddress: string;
    reportType: string;
    isSbaLoan: boolean;
  };
  /** Original filename (often gives strong classification hints) */
  filename: string;
}

export interface ClassifierOutput {
  /** The classification result */
  classification: ClassificationResult;
  /** Whether Sonnet escalation was used (always false — Sonnet escalation removed) */
  usedEscalation: boolean;
  /** Total tokens used */
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Total cost */
  totalCostUsd: number;
  /** Model(s) used */
  models: string[];
}

/** Input for classifyFromEvidencePack — uses cheap evidence instead of full PDFReaderOutput */
export interface ClassifyFromEvidencePackInput {
  evidencePack: EvidencePack;
  docTypes: DocumentTypesConfig;
  projectContext: ClassifierInput['projectContext'];
  filename: string;
}

/** What we ask Claude to return as JSON */
interface AIClassificationResponse {
  document_type: string;
  confidence: number;
  reasoning: string;
  date_detected: string | null;
  project_id_detected: string | null;
  suggested_section: string;
  is_sba_specific: boolean;
  is_embedded_report: boolean;
  embedded_report_property?: string;
  metadata: Record<string, string>;
}

// ── System Prompt Builder ──────────────────────────────────────────────────────

function buildSystemPrompt(
  docTypes: DocumentTypesConfig,
  projectContext: ClassifierInput['projectContext']
): string {
  const typeDescriptions = docTypes.document_types
    .map((dt) => {
      let desc = `- **${dt.id}** ("${dt.label}"): ${dt.description}`;
      if (dt.text_hints && dt.text_hints.length > 0) {
        desc += `\n  Text clues: ${dt.text_hints.slice(0, 6).join(', ')}`;
      }
      if (dt.visual_hints && dt.visual_hints.length > 0) {
        desc += `\n  Visual clues: ${dt.visual_hints.slice(0, 4).join(', ')}`;
      }
      if (dt.default_section) {
        desc += `\n  Default section: ${dt.default_section}`;
      }
      return desc;
    })
    .join('\n\n');

  return `You are a document classifier for ODIC Environmental, an environmental consulting firm.
Your job is to identify the type of each document in a Phase I Environmental Site Assessment (ESA) project.

## Project Context
- Project ID: ${projectContext.projectId}
- Project Name: ${projectContext.projectName}
- Client: ${projectContext.clientName}
- Property: ${projectContext.propertyAddress}
- Report Type: ${projectContext.reportType}
- SBA Loan: ${projectContext.isSbaLoan ? 'Yes' : 'No'}

## Document Types You Can Classify
${typeDescriptions}

## Classification Rules

1. **Choose the BEST matching document type** from the list above. Use the text and visual clues as guidance, but rely on your understanding of the content.

2. **Confidence scoring** — be CONFIDENT. If you can identify the document type, give it 0.95+:
   - 0.95-1.00: You can identify what this document is (USE THIS for most documents)
   - 0.90-0.94: Minor ambiguity but the type is clear
   - 0.80-0.89: Only if genuinely uncertain between 2+ types
   - Below 0.80: Truly unrecognizable content — very rare

3. **EDR Reports** are distinctive: they are typically very large (hundreds to thousands of pages), contain dense tabular data about regulatory sites, have EDR/Lightbox branding, and include terms like "Radius Map Report", "RCRA", "LUST", "CERCLIS", "GeoCheck". If the document has 100+ pages with this kind of content, it's almost certainly an EDR report.

4. **SBA-specific documents**: If you detect references to "SOP 50 10 8", "RELIANCE LETTER", or content specifically required for SBA loans, mark is_sba_specific as true.

5. **Cross-contamination check**: If the document contains a project number or property address that does NOT match the project context above, note it in project_id_detected. This is critical for quality control.

6. **Date detection**: Extract any report date, letter date, or document date you can find.

7. **Filename hints**: The original filename often contains strong classification signals (e.g., "EDR_Report.pdf", "cover_page.pdf", "photos.pdf"). If the filename clearly indicates the document type, give confidence 0.95+.

8. **Embedded Report Detection**: If the document appears to be a COMPLETE environmental report
   (has its own cover page, TOC, executive summary, body sections, appendices) from a DIFFERENT
   property address or project number than the current project, mark is_embedded_report: true.
   This is common — prior Phase I or Phase II reports for the same OR nearby properties are often
   included as reference material. These should be classified as "prior_environmental_report"
   and placed in appendix_i_additional (Reports/Additional section). Do NOT classify their
   internal pages as if they were part of the current report.

   Key signals of an embedded report:
   - Different property address than "${projectContext.propertyAddress}"
   - Different project number than "${projectContext.projectId}"
   - Different consulting firm name (not ODIC Environmental)
   - Has its own cover page, TOC, or section numbering
   - References a different client name

9. **Site Photos vs Supporting Photos**:
   - appendix_b_photographs: ONLY ODIC's own site visit photos (grid layout, 2x3 per page,
     captions like "View of Property facing north", "Interior view", ODIC branding)
   - Photos that document permits, records, historical conditions, or are from other firms
     should go to appendix_e_agency_records as supporting documents

## Response Format

Return a JSON object with this EXACT structure:
\`\`\`json
{
  "document_type": "one of the document type IDs listed above",
  "confidence": 0.95,
  "reasoning": "Brief explanation of why this classification was chosen",
  "date_detected": "2024-01-15 or null if no date found",
  "project_id_detected": "any project ID found in the document or null",
  "suggested_section": "the report section this belongs in (e.g., appendix_c_database_report)",
  "is_sba_specific": false,
  "is_embedded_report": false,
  "embedded_report_property": "property address if embedded report from different property, or null",
  "metadata": {
    "key": "value pairs of any additional useful info extracted"
  }
}
\`\`\`

Return ONLY the JSON object, no other text.`;
}

function buildUserMessage(
  filename: string,
  readerOutput: PDFReaderOutput
): string {
  const parts: string[] = [];

  parts.push(`## Document: ${filename}`);
  parts.push(`Total pages: ${readerOutput.totalPages}`);
  parts.push(`File size: ${(readerOutput.fileSizeBytes / 1024 / 1024).toFixed(2)} MB`);

  if (readerOutput.metadata.title) {
    parts.push(`PDF Title: ${readerOutput.metadata.title}`);
  }
  if (readerOutput.metadata.author) {
    parts.push(`PDF Author: ${readerOutput.metadata.author}`);
  }

  parts.push('');
  parts.push('## Extracted Text (sampled pages):');

  // Truncate combined text to ~8000 chars to stay within token limits
  const maxTextLen = 8000;
  let text = readerOutput.combinedText;
  if (text.length > maxTextLen) {
    text = text.substring(0, maxTextLen) + '\n\n[... truncated — document continues ...]';
  }
  parts.push(text);

  // Note about page images
  if (readerOutput.pageImages.length > 0) {
    parts.push('');
    parts.push(
      `## Page Images\n${readerOutput.pageImages.length} page image(s) attached ` +
      `(pages: ${readerOutput.imagePageNumbers.join(', ')}). Use these for visual classification.`
    );
  }

  return parts.join('\n');
}

/**
 * Build a compact LLM message from an evidence pack.
 *
 * Extracts top keywords and representative snippets instead of dumping raw
 * page text. Target size: ~400–600 tokens vs ~3000 previously.
 */
function buildCompactLLMMessage(filename: string, evidencePack: EvidencePack): string {
  // 1. Extract top keywords (frequency-ranked, stop-words filtered, min 3 chars)
  const stopWords = new Set([
    'the','a','an','is','in','of','to','and','for','with','this','that','by',
    'at','or','on','from','be','it','as','are','was','were','has','have','had',
    'its','their','they','which','not','but','if','no','all','any','may','such',
    'per','date','page','www',
  ]);

  const combinedText = evidencePack.sampleTexts.map(s => s.text).join('\n');
  const wordFreq = new Map<string, number>();
  for (const w of (combinedText.toLowerCase().match(/[a-z]{3,}/g) ?? [])) {
    if (!stopWords.has(w)) wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
  }
  const topKeywords = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([w]) => w);

  // 2. Select up to 8 snippets: lines ≥ 30 chars containing a top-10 keyword
  const keywordSet = new Set(topKeywords.slice(0, 10));
  const snippets: Array<{ page: number; text: string }> = [];
  for (const { pageNumber, text } of evidencePack.sampleTexts) {
    for (const line of text.split('\n')) {
      if (snippets.length >= 8) break;
      const lt = line.trim();
      if (lt.length < 30) continue;
      if ([...keywordSet].some(kw => lt.toLowerCase().includes(kw))) {
        snippets.push({ page: pageNumber, text: lt.substring(0, 200) });
      }
    }
    if (snippets.length >= 8) break;
  }
  // Fallback: if < 3 snippets, include first 3 non-empty lines of page 1
  if (snippets.length < 3 && evidencePack.sampleTexts[0]) {
    for (const line of evidencePack.sampleTexts[0].text.split('\n')) {
      if (snippets.length >= 3) break;
      const lt = line.trim();
      if (lt.length >= 20) snippets.push({ page: 1, text: lt.substring(0, 200) });
    }
  }

  // 3. Build compact message
  const parts: string[] = [
    `## Document: ${filename}`,
    `Pages: ${evidencePack.pageCount} | Size: ${(evidencePack.fileSizeBytes / 1024 / 1024).toFixed(1)} MB`,
  ];
  if (evidencePack.pdfTitle) parts.push(`PDF Title: ${evidencePack.pdfTitle}`);
  if (evidencePack.pdfAuthor) parts.push(`PDF Author: ${evidencePack.pdfAuthor}`);
  parts.push('');
  parts.push(`## Frequent Terms: ${topKeywords.join(', ')}`);
  parts.push('');
  parts.push('## Key Lines:');
  for (const { page, text } of snippets) {
    parts.push(`[p${page}] ${text}`);
  }
  return parts.join('\n');
}

// ── Content-based heuristics (called from execute() after PDF is already read) ──

/**
 * Catch trivially classifiable documents from their extracted content.
 * Only called for docs that DIDN'T match filename or metadata heuristics.
 * Runs inside execute() where readerOutput is already available.
 */
function tryHeuristicFromContent(
  filename: string,
  readerOutput: PDFReaderOutput
): ClassificationResult | null {
  const firstPageText = (readerOutput.sampledPages[0]?.text ?? '').toLowerCase();
  const totalPages = readerOutput.totalPages;

  // Blank/empty pages — single page with no meaningful text
  if (totalPages === 1 && firstPageText.trim().length < 20) {
    return {
      documentType: 'blank_page',
      confidence: 0.95,
      reasoning: 'Single page with virtually no text content.',
      dateDetected: null,
      projectIdDetected: null,
      pageCount: 1,
      pageRange: { start: 1, end: 1 },
      suggestedSection: 'appendix_i_additional',
      needsManualReview: false,
      isSbaSpecific: false,
      metadata: { classifiedBy: 'heuristic_content' },
    };
  }

  // ACORD insurance certificate — very distinctive first-page text
  if (firstPageText.includes('certificate of liability insurance') && firstPageText.includes('acord')) {
    return {
      documentType: 'insurance_certificate',
      confidence: 0.98,
      reasoning: 'ACORD certificate of liability insurance detected from first page text.',
      dateDetected: null,
      projectIdDetected: null,
      pageCount: totalPages,
      pageRange: { start: 1, end: totalPages },
      suggestedSection: 'front_insurance',
      needsManualReview: false,
      isSbaSpecific: false,
      metadata: { classifiedBy: 'heuristic_content' },
    };
  }

  return null; // No content heuristic match — proceed to Haiku AI call
}

// ── Skill Implementation ──────────────────────────────────────────────────────

export class DocumentClassifierSkill extends BaseSkill<ClassifierInput, ClassifierOutput> {
  private llm: LLMClient;

  constructor(config: AppConfig, llm: LLMClient) {
    super(config);
    this.llm = llm;
  }

  get name(): string {
    return 'DocumentClassifier';
  }

  get usesAI(): boolean {
    return true;
  }

  // ── Public heuristic methods — called by classify-step.ts BEFORE reading PDFs ──

  /**
   * Layer 1: Filename + file size only. Call BEFORE pdfReader.process().
   * Returns a ClassificationResult if confident, null if ambiguous.
   * pageCount is 0 when returned here (PDF not yet read).
   */
  public tryHeuristicFromFilename(filename: string, fileSizeBytes: number): ClassificationResult | null {
    const fn = filename.toLowerCase();

    const make = (
      documentType: DocumentType,
      suggestedSection: ReportSection,
      confidence: number,
      reasoning: string,
      extra: Partial<ClassificationResult> = {}
    ): ClassificationResult => ({
      documentType,
      confidence,
      reasoning,
      dateDetected: null,
      projectIdDetected: null,
      pageCount: 0,
      pageRange: { start: 1, end: 0 },
      suggestedSection,
      needsManualReview: false,
      isSbaSpecific: false,
      metadata: { classifiedBy: 'heuristic_filename' },
      ...extra,
    });

    // ── Front matter ──
    if (/^cover[\s_\-.]|^cover\.(pdf|docx?)$/i.test(fn) && !fn.includes('appendix')) {
      return make('cover_page', 'front_cover', 0.98, `Filename "${filename}" — cover page.`);
    }
    if (/reliance.?letter/i.test(fn) || fn.includes('reliance')) {
      return make('reliance_letter', 'front_reliance', 0.98, `Filename "${filename}" — reliance letter.`);
    }
    if (/e&o|errors?.?&?.?omissions/i.test(fn)) {
      return make('insurance_certificate', 'front_insurance', 0.98, `Filename "${filename}" — E&O insurance certificate.`);
    }
    if (/transmittal/i.test(fn)) {
      return make('transmittal_letter', 'appendix_i_additional', 0.97, `Filename "${filename}" — transmittal letter.`);
    }
    if (/ep.?declaration|environmental.?professional.*declar/i.test(fn)) {
      return make('ep_declaration', 'appendix_f_qualifications', 0.97, `Filename "${filename}" — EP declaration.`);
    }

    // ── ODIC project-number prefixed files (e.g., 6384737-ESAI-Sanborn.pdf) ──
    if (/\d{7}.*esai.*sanborn/i.test(fn)) {
      return make('sanborn_map', 'appendix_d_historical', 0.97, `ODIC project filename "${filename}" — Sanborn maps.`);
    }
    if (/\d{7}.*esai.*aerial/i.test(fn) || /^aerials?\.(pdf|zip)$/i.test(fn)) {
      return make('aerial_photograph', 'appendix_d_historical', 0.97, `ODIC project filename "${filename}" — aerial photographs.`);
    }
    if (/\d{7}.*esai.*topo/i.test(fn)) {
      return make('topographic_map', 'appendix_d_historical', 0.97, `ODIC project filename "${filename}" — topographic maps.`);
    }
    if (/\d{7}.*esai.*city.?director/i.test(fn)) {
      return make('city_directory', 'appendix_d_historical', 0.97, `ODIC project filename "${filename}" — city directories.`);
    }
    if (/\d{7}.*esai.*radius.?map/i.test(fn) || /radius.?map/i.test(fn)) {
      return make('edr_report', 'appendix_c_database_report', 0.97, `Filename "${filename}" — EDR radius map report.`);
    }

    // ODIC report body: project# + ESAI + author initials, NOT a specific doc type keyword
    // e.g., "6384737-ESAI-NK.pdf", "6384737-ESAI-NK Reviewed.docx"
    if (/\d{7}.*esai.*-[a-z]{2,3}\.(pdf|docx?)$/i.test(fn) &&
        !/sanborn|aerial|radius|topo|city|photo/i.test(fn)) {
      return make('report_body', 'body_introduction', 0.93, `ODIC project filename "${filename}" — report body.`);
    }
    if (/esai.*report.*compressed/i.test(fn) || /esai.*reviewed/i.test(fn)) {
      return make('report_body', 'body_introduction', 0.95, `Filename "${filename}" — reviewed/compressed report body.`);
    }

    // ── Report body: reviewed write-up ──
    if ((fn.includes('reviewed') || fn.includes('write up') || fn.includes('writeup') || fn.includes('write-up')) &&
        !fn.includes('photo') && !fn.includes('pic')) {
      return make('report_body', 'body_introduction', 0.98, `Filename "${filename}" — reviewed report body.`);
    }

    // ── Historical documents ──
    if (fn.includes('sanborn') || /fire.*insurance.*map/i.test(fn)) {
      return make('sanborn_map', 'appendix_d_historical', 0.97, `Filename "${filename}" — Sanborn/fire insurance map.`);
    }
    if (fn.includes('aerial') || fn.includes('airphoto') || fn.includes('air photo')) {
      return make('aerial_photograph', 'appendix_d_historical', 0.97, `Filename "${filename}" — aerial photograph.`);
    }
    if (fn.includes('topo') || fn.includes('usgs') || fn.includes('topograph')) {
      return make('topographic_map', 'appendix_d_historical', 0.97, `Filename "${filename}" — topographic map.`);
    }
    if (fn.includes('city dir') || fn.includes('city_dir') || fn.includes('directory') ||
        fn.includes('polk') || fn.includes('haines')) {
      return make('city_directory', 'appendix_d_historical', 0.97, `Filename "${filename}" — city directory.`);
    }

    // ── Appendix-labeled bundles ──
    if (/appendix.?a.*(site.?location|map|plot)/i.test(fn)) {
      return make('location_map', 'appendix_a_maps', 0.92, `Filename "${filename}" — Appendix A site location map.`);
    }
    if (/appendix.?c\b/i.test(fn) && (/radius|database|edr/i.test(fn))) {
      return make('edr_report', 'appendix_c_database_report', 0.95, `Filename "${filename}" — Appendix C EDR report.`);
    }
    if (/appendix.?d.*histor/i.test(fn)) {
      return make('sanborn_map', 'appendix_d_historical', 0.92, `Filename "${filename}" — Appendix D historical records bundle.`,
        { metadata: { classifiedBy: 'heuristic_filename', isBundle: 'true' } });
    }
    if (/appendix.?e.*agency/i.test(fn)) {
      return make('agency_records', 'appendix_e_agency_records', 0.90, `Filename "${filename}" — Appendix E agency records.`);
    }
    if (/appendix.?f.*qualif/i.test(fn)) {
      return make('ep_qualifications', 'appendix_f_qualifications', 0.97, `Filename "${filename}" — Appendix F EP qualifications.`);
    }
    if (fn.includes('appendix') && (fn.includes('photo') || fn.includes('pic'))) {
      return make('site_photograph', 'appendix_b_photographs', 0.95, `Filename "${filename}" — photo appendix.`);
    }

    // ── Other well-named files ──
    if (/qualifications?\.pdf$/i.test(fn) || fn.includes('credentials')) {
      return make('ep_qualifications', 'appendix_f_qualifications', 0.96, `Filename "${filename}" — EP qualifications.`);
    }
    if (/bldg.?permits?|building.?permits?/i.test(fn) || fn.includes('permit')) {
      return make('building_permit', 'appendix_e_agency_records', 0.95, `Filename "${filename}" — building permit.`);
    }
    if (/photos?.?appendix|site.?photos?|site_photos?/i.test(fn) ||
        (fn.includes('photo') && !fn.includes('record') && !fn.includes('directory') && !fn.includes('agency'))) {
      return make('site_photograph', 'appendix_b_photographs', 0.95, `Filename "${filename}" — site photographs.`);
    }
    if (/property.?detail.?report/i.test(fn) || fn.includes('assessor') ||
        (fn.includes('tax') && fn.includes('record'))) {
      return make('tax_record', 'appendix_e_agency_records', 0.90, `Filename "${filename}" — tax/property record.`);
    }
    if (/edr|radius.?map|envirostor|geotracker/i.test(fn)) {
      return make('edr_report', 'appendix_c_database_report', 0.95, `Filename "${filename}" — EDR/database report.`);
    }

    // ── Agency records by acronym ──
    if (/\bdtsc\b|\bsdceh\b|\brwqcb\b|\baqmd\b|\bdeh\b/i.test(fn)) {
      return make('regulatory_correspondence', 'appendix_e_agency_records', 0.95,
        `Filename "${filename}" — agency records by acronym.`);
    }
    if (fn.includes('agency') || fn.includes('regulatory') || fn.includes('correspondence')) {
      return make('regulatory_correspondence', 'appendix_e_agency_records', 0.93,
        `Filename "${filename}" — agency/regulatory correspondence.`);
    }

    // ── Location/plot plan ──
    if (fn.includes('location') || fn.includes('plot plan') || fn.includes('site plan') ||
        fn.includes('plot_plan') || fn.includes('site_plan')) {
      return make('location_map', 'appendix_a_maps', 0.92, `Filename "${filename}" — location/site plan.`);
    }

    // ── Title/property records ──
    if (fn.includes('title') && (fn.includes('record') || fn.includes('search') || fn.includes('report'))) {
      return make('title_record', 'appendix_e_agency_records', 0.95, `Filename "${filename}" — title records.`);
    }

    return null; // No match — proceed to page count check or full PDF read
  }

  /**
   * Layer 2: Filename + page count. Call after cheap getPageCount(), before full text extraction.
   * Catches EDR reports by their massive page count.
   */
  public tryHeuristicFromMetadata(
    filename: string,
    totalPages: number,
    fileSizeBytes: number
  ): ClassificationResult | null {
    const fn = filename.toLowerCase();

    // Very large documents (500+ pages) are almost certainly EDR reports
    if (totalPages >= 500) {
      return {
        documentType: 'edr_report',
        confidence: 0.97,
        reasoning: `Very large document (${totalPages} pages, ${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB) — almost certainly an EDR radius map report.`,
        dateDetected: null,
        projectIdDetected: null,
        pageCount: totalPages,
        pageRange: { start: 1, end: totalPages },
        suggestedSection: 'appendix_c_database_report',
        needsManualReview: false,
        isSbaSpecific: false,
        metadata: { classifiedBy: 'heuristic_metadata', pageCount: String(totalPages) },
      };
    }

    // Moderate EDR: filename has EDR-adjacent keywords + large page count
    if (totalPages >= 50 && (/edr|radius|lightbox/i.test(fn))) {
      return {
        documentType: 'edr_report',
        confidence: 0.95,
        reasoning: `Filename "${filename}" has EDR signals and ${totalPages} pages — EDR radius map report.`,
        dateDetected: null,
        projectIdDetected: null,
        pageCount: totalPages,
        pageRange: { start: 1, end: totalPages },
        suggestedSection: 'appendix_c_database_report',
        needsManualReview: false,
        isSbaSpecific: false,
        metadata: { classifiedBy: 'heuristic_metadata', pageCount: String(totalPages) },
      };
    }

    return null; // No metadata heuristic match — proceed to full PDF read + AI
  }

  protected async execute(input: ClassifierInput): Promise<ClassifierOutput> {
    const { readerOutput, docTypes, projectContext, filename } = input;

    // 1. Try content-based heuristics (free, instant — PDF already read by caller)
    const heuristicResult = tryHeuristicFromContent(filename, readerOutput);
    if (heuristicResult) {
      this.logger.info(
        { filename, type: heuristicResult.documentType, confidence: heuristicResult.confidence },
        `Content heuristic: ${filename} → ${heuristicResult.documentType}`
      );
      return {
        classification: heuristicResult,
        usedEscalation: false,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        models: ['heuristic_content'],
      };
    }

    // 2. Build prompts
    const systemPrompt = buildSystemPrompt(docTypes, projectContext);
    const userMessage = buildUserMessage(filename, readerOutput);

    // 3. Haiku classification — single AI call, no Sonnet escalation
    this.logger.info({ filename }, 'Classifying with Haiku...');

    const haikuResponse = await this.llm.classify<AIClassificationResponse>(
      systemPrompt,
      userMessage,
      readerOutput.pageImages.length > 0 ? readerOutput.pageImages : undefined
    );

    const totalInputTokens = haikuResponse.usage.inputTokens;
    const totalOutputTokens = haikuResponse.usage.outputTokens;
    const totalCostUsd = haikuResponse.costUsd;
    const models: string[] = [haikuResponse.model];
    const aiResult = haikuResponse.data;

    // 4. Low-confidence → flag for manual review (Rose classifies in dashboard)
    //    No Sonnet escalation — faster and Rose's judgment is often more accurate.
    if (aiResult.confidence < docTypes.thresholds.needs_review) {
      this.logger.info(
        { filename, confidence: aiResult.confidence, threshold: docTypes.thresholds.needs_review },
        'Low confidence — flagged for manual review (no Sonnet escalation)'
      );
    }

    // 5. Build ClassificationResult
    const classification = this.buildClassificationResult(aiResult, readerOutput.totalPages, docTypes);

    this.logger.info(
      {
        filename,
        type: classification.documentType,
        confidence: classification.confidence,
        section: classification.suggestedSection,
        needsReview: classification.needsManualReview,
        costUsd: totalCostUsd.toFixed(4),
      },
      `Classification complete: ${filename} → ${classification.documentType} (${(classification.confidence * 100).toFixed(0)}%)`
    );

    return {
      classification,
      usedEscalation: false,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      models,
    };
  }

  /**
   * Convert the AI's raw JSON response into our typed ClassificationResult.
   */
  private buildClassificationResult(
    aiResult: AIClassificationResponse,
    pageCount: number,
    docTypes: DocumentTypesConfig
  ): ClassificationResult {
    // Validate document_type — fallback to other_unknown if invalid
    const validTypes = docTypes.document_types.map((dt) => dt.id);
    const documentType: DocumentType = validTypes.includes(aiResult.document_type)
      ? (aiResult.document_type as DocumentType)
      : 'other_unknown';

    // Validate suggested_section — fallback to default mapping
    const defaultSection = DOCUMENT_TYPE_TO_DEFAULT_SECTION[documentType];
    const suggestedSection: ReportSection = aiResult.suggested_section
      ? (aiResult.suggested_section as ReportSection)
      : defaultSection;

    // Determine if manual review is needed
    const needsManualReview =
      aiResult.confidence < docTypes.thresholds.needs_review ||
      documentType === 'other_unknown';

    // Pass through embedded report fields via metadata for cross-property detection
    const metadata: Record<string, string> = { ...(aiResult.metadata ?? {}) };
    if (aiResult.is_embedded_report) {
      metadata.is_embedded_report = 'true';
    }
    if (aiResult.embedded_report_property) {
      metadata.embedded_report_property = aiResult.embedded_report_property;
    }

    return {
      documentType,
      confidence: Math.max(0, Math.min(1, aiResult.confidence)),
      reasoning: aiResult.reasoning || 'No reasoning provided',
      dateDetected: aiResult.date_detected || null,
      projectIdDetected: aiResult.project_id_detected || null,
      pageCount,
      pageRange: { start: 1, end: pageCount },
      suggestedSection,
      needsManualReview,
      isSbaSpecific: aiResult.is_sba_specific ?? false,
      metadata,
    };
  }

  /**
   * Classify a document using a cheap evidence pack (text only, no images).
   * Called by classify-step.ts after filename/metadata heuristics and keyword scorer fail.
   * This is the Haiku-only path — no images, no full PDF read.
   */
  public async classifyFromEvidencePack(
    input: ClassifyFromEvidencePackInput
  ): Promise<ClassifierOutput> {
    const { evidencePack, docTypes, projectContext, filename } = input;

    const systemPrompt = buildSystemPrompt(docTypes, projectContext);
    const userMessage = buildCompactLLMMessage(filename, evidencePack);

    this.logger.info({ filename }, 'Classifying from evidence pack with Haiku...');

    const haikuResponse = await this.llm.classify<AIClassificationResponse>(
      systemPrompt,
      userMessage
      // No images — evidence pack is text-only; CLI mode can't use them anyway
    );

    const aiResult = haikuResponse.data;

    if (aiResult.confidence < docTypes.thresholds.needs_review) {
      this.logger.info(
        { filename, confidence: aiResult.confidence, threshold: docTypes.thresholds.needs_review },
        'Low confidence — flagged for manual review'
      );
    }

    const classification = this.buildClassificationResult(
      aiResult,
      evidencePack.pageCount,
      docTypes
    );

    this.logger.info(
      {
        filename,
        type: classification.documentType,
        confidence: classification.confidence,
        section: classification.suggestedSection,
        needsReview: classification.needsManualReview,
        costUsd: haikuResponse.costUsd.toFixed(4),
      },
      `Classification complete: ${filename} → ${classification.documentType} (${(classification.confidence * 100).toFixed(0)}%)`
    );

    return {
      classification,
      usedEscalation: false,
      totalInputTokens: haikuResponse.usage.inputTokens,
      totalOutputTokens: haikuResponse.usage.outputTokens,
      totalCostUsd: haikuResponse.costUsd,
      models: [haikuResponse.model],
    };
  }
}
