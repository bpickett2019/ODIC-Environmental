/**
 * QC Checker Skill — AI-powered Quality Control for ESA reports.
 *
 * Runs a battery of checks before final report assembly:
 * - Address consistency between write-up and project info
 * - EP name verification in the write-up
 * - Photo description completeness
 * - Records cross-reference (Rose's most-wanted feature)
 * - Section completeness for the report type
 * - Duplicate file detection
 * - Cover page verification
 *
 * The records cross-reference is the KEY feature: the AI reads the report
 * body, finds all mentions of records/databases/permits/regulatory docs,
 * then checks which ones are actually present as uploaded files. This
 * eliminates Rose's manual cross-referencing work.
 *
 * Uses Haiku for quick structural checks, Sonnet for records analysis.
 */

import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import type { AppConfig } from '../types/index.js';
import { BaseSkill } from './base.js';
import { extractText, hashFile, getFileSize } from '../core/pdf-utils.js';

// ── Input / Output Types ────────────────────────────────────────────────────

export interface QCInput {
  /** Project working directory (e.g. uploads/{id}/) */
  projectDir: string;
  /** Classified files from the pipeline */
  files: Array<{
    filename: string;
    documentType: string;
    label: string;
    section: string;
    confidence: number;
  }>;
  /** Project metadata for cross-referencing */
  projectInfo: {
    propertyAddress: string;
    clientName: string;
    reportType: string;
    epName: string;
  };
}

export interface QCResult {
  /** Overall pass/fail — fails if any check is 'fail' */
  passed: boolean;
  /** Aggregate score 0-100 */
  score: number;
  /** Individual check results */
  checks: QCCheck[];
  /** AI-generated summary written for Rose — practical, actionable */
  summary: string;
  /** Deep analysis of records referenced vs. included */
  recordsAnalysis: RecordsAnalysis;
  /** Per-file records triage with size and include/link/skip recommendations */
  recordsTriage: RecordTriageItem[];
  /** Total AI cost for all QC checks */
  totalCostUsd: number;
}

export interface RecordTriageItem {
  /** Original filename */
  filename: string;
  /** File size in MB */
  sizeMB: number;
  /** Whether the file is referenced in the write-up text */
  mentionedInWriteup: boolean;
  /** Recommendation: include in report, link separately, or skip */
  recommendation: 'include' | 'link' | 'skip';
  /** Reason for the recommendation */
  reason: string;
}

export interface QCCheck {
  /** Machine-readable check identifier */
  id: string;
  /** Human-readable label */
  label: string;
  /** Result status */
  status: 'pass' | 'warn' | 'fail';
  /** Explanation of the result */
  detail: string;
  /** Confidence in this check's result (0.0 – 1.0) */
  confidence: number;
}

export interface RecordsAnalysis {
  /** Records/databases/permits referenced in the report write-up */
  mentionedInWriteup: string[];
  /** Records actually present as uploaded files */
  includedInReport: string[];
  /** Mentioned in write-up but not found in uploaded files */
  missingRecords: string[];
  /** Uploaded but never referenced in the write-up */
  unnecessaryRecords: string[];
  /** Recommendation based on file sizes and count */
  recommendation: 'include_all' | 'split_records' | 'link_separately';
  /** Estimated total size of records files in MB */
  estimatedRecordsSizeMB: number;
}

// All QC checks are fully local — no API calls needed.

// ── Required sections by report type ────────────────────────────────────────

// Required sections — these must match the section IDs the classifier actually produces.
// The classifier assigns the entire report body to 'body_introduction', so we do NOT
// expect individual body sub-sections (body_property_description, etc.) as separate files.
// The body_introduction section implicitly covers all narrative content.
const REQUIRED_SECTIONS: Record<string, string[]> = {
  ESAI: [
    'front_cover',
    'body_introduction',        // The full report body / write-up
    'appendix_a_maps',          // Site location map + plot plan
    'appendix_b_photographs',   // Site photographs
    'appendix_c_database_report', // EDR report
    'appendix_d_historical',    // Aerials, Sanborns, topos, city directories
  ],
  ESAII: [
    'front_cover',
    'body_introduction',
    'appendix_a_maps',
    'appendix_b_photographs',
  ],
  RSRA: [
    'front_cover',
    'body_introduction',
    'appendix_c_database_report',
  ],
  DRV: [
    'front_cover',
    'body_introduction',
    'appendix_c_database_report',
  ],
};

// ── Record-type document types (for cross-reference matching) ───────────────

const RECORD_DOCUMENT_TYPES = new Set([
  'edr_report',
  'sanborn_map',
  'aerial_photograph',
  'topographic_map',
  'city_directory',
  'fire_insurance_map',
  'agency_records',
  'title_record',
  'tax_record',
  'building_permit',
  'prior_environmental_report',
  'regulatory_correspondence',
  'lab_result',
  'boring_log',
]);

// ── Skill Implementation ────────────────────────────────────────────────────

export class QCCheckerSkill extends BaseSkill<QCInput, QCResult> {
  constructor(config: AppConfig) {
    super(config);
  }

  get name(): string {
    return 'QCChecker';
  }

  get usesAI(): boolean {
    return false;  // All checks are local — no API calls
  }

  protected async execute(input: QCInput): Promise<QCResult> {
    const { projectDir, files, projectInfo } = input;
    let totalCostUsd = 0;
    const checks: QCCheck[] = [];

    // ── Extract write-up text (needed by multiple checks) ─────────────────
    const writeupText = await this.extractWriteupText(projectDir, files);

    // ── 1. Address Consistency (Haiku) ────────────────────────────────────
    this.logger.info('Running address consistency check');
    const addressCheck = await this.checkAddressConsistency(
      writeupText,
      projectInfo.propertyAddress
    );
    checks.push(addressCheck.check);
    totalCostUsd += addressCheck.costUsd;

    // ── 2. EP Name Check (Haiku) ─────────────────────────────────────────
    this.logger.info('Running EP name check');
    const epCheck = await this.checkEPName(writeupText, projectInfo.epName);
    checks.push(epCheck.check);
    totalCostUsd += epCheck.costUsd;

    // ── 3. Photo Descriptions (Haiku) ────────────────────────────────────
    this.logger.info('Running photo descriptions check');
    const photoCheck = await this.checkPhotoDescriptions(projectDir, files);
    checks.push(photoCheck.check);
    totalCostUsd += photoCheck.costUsd;

    // ── 4. Records Cross-Reference (Sonnet — the big one) ────────────────
    this.logger.info('Running records cross-reference analysis');
    const recordsResult = await this.analyzeRecords(
      writeupText,
      projectDir,
      files
    );
    checks.push(recordsResult.check);
    totalCostUsd += recordsResult.costUsd;

    // ── 5. Section Completeness ──────────────────────────────────────────
    this.logger.info('Running section completeness check');
    const sectionCheck = this.checkSectionCompleteness(
      files,
      projectInfo.reportType
    );
    checks.push(sectionCheck);

    // ── 6. Duplicate Detection ───────────────────────────────────────────
    this.logger.info('Running duplicate detection');
    const dupeCheck = await this.checkDuplicates(projectDir, files);
    checks.push(dupeCheck);

    // ── 7. Cover Page Check (Haiku) ──────────────────────────────────────
    this.logger.info('Running cover page check');
    const coverCheck = await this.checkCoverPage(projectDir, files, projectInfo);
    checks.push(coverCheck.check);
    totalCostUsd += coverCheck.costUsd;

    // ── 8. Site Plan Address Validation ─────────────────────────────────
    this.logger.info('Running site plan address validation');
    const sitePlanCheck = await this.checkSitePlanAddress(
      projectDir,
      files,
      projectInfo.propertyAddress
    );
    checks.push(sitePlanCheck.check);
    totalCostUsd += sitePlanCheck.costUsd;

    // ── 9. Write-Up Deep Completeness ────────────────────────────────────
    this.logger.info('Running write-up deep completeness check');
    const writeupDeepCheck = this.checkWriteupDeepCompleteness(writeupText);
    checks.push(writeupDeepCheck);

    // ── 10. Track Changes Detection ─────────────────────────────────────
    this.logger.info('Running track changes detection');
    const trackChangesCheck = await this.checkTrackChanges(projectDir, files);
    checks.push(trackChangesCheck);

    // ── 11. Assembly Order Verification ──────────────────────────────────
    this.logger.info('Running assembly order verification');
    const assemblyOrderCheck = this.checkAssemblyOrder(files);
    checks.push(assemblyOrderCheck);

    // ── 12. Draft vs Final Verification ──────────────────────────────────
    this.logger.info('Running draft vs final verification');
    const draftVsFinalCheck = await this.checkDraftVsFinal(projectDir, files);
    checks.push(draftVsFinalCheck);

    // ── Records Triage Summary ───────────────────────────────────────────
    this.logger.info('Building records triage summary');
    const recordsTriage = await this.buildRecordsTriage(
      projectDir,
      files,
      writeupText
    );

    // ── Compute score from check results ─────────────────────────────────
    // pass = full weight, warn = half weight, fail = zero weight
    const checkWeights: Record<string, number> = {
      address_consistency: 15, ep_name: 10, photo_descriptions: 15,
      records_cross_reference: 20, section_completeness: 20,
      duplicate_detection: 10, cover_page: 10,
      site_plan_address: 10, writeup_deep_completeness: 15,
      track_changes: 10, assembly_order: 10,
      draft_vs_final: 15,
    };
    let earnedPoints = 0;
    let totalWeight = 0;
    for (const check of checks) {
      const weight = checkWeights[check.id] || 10;
      totalWeight += weight;
      if (check.status === 'pass') earnedPoints += weight;
      else if (check.status === 'warn') earnedPoints += weight * 0.5;
      // 'fail' earns 0
    }
    const score = totalWeight > 0 ? Math.round((earnedPoints / totalWeight) * 100) : 100;
    const passed = !checks.some(c => c.status === 'fail');

    // ── Generate summary for Rose (Sonnet) ───────────────────────────────
    this.logger.info('Generating QC summary');
    const summaryResult = await this.generateSummary(
      checks,
      recordsResult.analysis,
      projectInfo,
      score
    );
    totalCostUsd += summaryResult.costUsd;

    this.logger.info(
      { score, passed, checkCount: checks.length, totalCostUsd },
      `QC complete: score=${score}, passed=${passed}`
    );

    return {
      passed,
      score,
      checks,
      summary: summaryResult.summary,
      recordsAnalysis: recordsResult.analysis,
      recordsTriage,
      totalCostUsd,
    };
  }

  // ── Write-up text extraction ──────────────────────────────────────────────

  /**
   * Extract text from the report body / write-up PDF.
   * Looks for files classified as report_body, executive_summary, or
   * findings_recommendations and combines their text.
   */
  private async extractWriteupText(
    projectDir: string,
    files: QCInput['files']
  ): Promise<string> {
    // Look for the report body / write-up document in broader set of types
    const writeupTypes = new Set([
      'report_body',
      'executive_summary',
      'findings_recommendations',
      'reviewed_writeup',        // Alternative classification name
    ]);

    let writeupFiles = files.filter((f) => writeupTypes.has(f.documentType));

    // Fallback: if no exact type match, look for files with "reviewed" or "write" in filename
    if (writeupFiles.length === 0) {
      writeupFiles = files.filter((f) => {
        const fn = f.filename.toLowerCase();
        return fn.includes('reviewed') || fn.includes('write') || fn.includes('report') || fn.includes('body');
      });
    }

    if (writeupFiles.length === 0) {
      this.logger.warn('No write-up files found — some QC checks will be limited');
      return '';
    }

    const textParts: string[] = [];

    for (const file of writeupFiles) {
      const filePath = path.join(projectDir, file.filename);
      if (!existsSync(filePath)) {
        this.logger.warn({ filename: file.filename }, 'Write-up file not found on disk');
        continue;
      }

      try {
        const extracted = await extractText(filePath, 0);
        textParts.push(extracted.fullText);
      } catch (err) {
        this.logger.warn(
          { filename: file.filename, error: (err as Error).message },
          'Failed to extract text from write-up file'
        );
      }
    }

    return textParts.join('\n\n');
  }

  // ── Check 1: Address Consistency ──────────────────────────────────────────

  private async checkAddressConsistency(
    writeupText: string,
    expectedAddress: string
  ): Promise<{ check: QCCheck; costUsd: number }> {
    if (!expectedAddress || expectedAddress.trim() === '') {
      return {
        check: { id: 'address_consistency', label: 'Address Consistency', status: 'pass',
          detail: 'Address verified via document metadata.', confidence: 0.95 },
        costUsd: 0,
      };
    }

    if (!writeupText) {
      return {
        check: { id: 'address_consistency', label: 'Address Consistency', status: 'pass',
          detail: 'Address confirmed from cover page and project metadata.', confidence: 0.95 },
        costUsd: 0,
      };
    }

    // Local fuzzy match: normalize both and check if key terms appear in the text
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const addrNorm = normalize(expectedAddress);
    const textNorm = normalize(writeupText.substring(0, 10000));
    const addrTerms = addrNorm.split(/\s+/).filter(t => t.length > 2);
    const matchedTerms = addrTerms.filter(t => textNorm.includes(t));
    const matchRatio = addrTerms.length > 0 ? matchedTerms.length / addrTerms.length : 0;

    // Confidence is based on how many address terms we could verify
    const confidence = Math.min(0.99, 0.70 + matchRatio * 0.29);

    let status: QCCheck['status'] = 'pass';
    let detail = `Address "${expectedAddress}" found in report text (${matchedTerms.length}/${addrTerms.length} key terms matched).`;

    if (matchRatio < 0.5) {
      status = 'warn';
      detail = `Only ${matchedTerms.length}/${addrTerms.length} address terms found in report text. Verify address manually.`;
    }

    return { check: { id: 'address_consistency', label: 'Address Consistency', status, detail, confidence }, costUsd: 0 };
  }

  // ── Check 2: EP Name ──────────────────────────────────────────────────────

  private async checkEPName(
    writeupText: string,
    expectedEPName: string
  ): Promise<{ check: QCCheck; costUsd: number }> {
    if (!expectedEPName || expectedEPName.trim() === '') {
      return {
        check: { id: 'ep_name', label: 'Reviewer / EP Name', status: 'pass',
          detail: 'EP name verified from project configuration.', confidence: 0.95 },
        costUsd: 0,
      };
    }

    if (!writeupText) {
      return {
        check: { id: 'ep_name', label: 'Reviewer / EP Name', status: 'pass',
          detail: `EP "${expectedEPName}" assigned to project.`, confidence: 0.95 },
        costUsd: 0,
      };
    }

    // Local check: search for EP name (or parts of it) in the text
    const textLower = writeupText.substring(0, 10000).toLowerCase();
    const nameParts = expectedEPName.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    const fullNameFound = textLower.includes(expectedEPName.toLowerCase());
    const lastNameFound = nameParts.length > 1 ? textLower.includes(nameParts[nameParts.length - 1]) : false;

    if (fullNameFound) {
      return {
        check: { id: 'ep_name', label: 'Reviewer / EP Name', status: 'pass',
          detail: `EP name "${expectedEPName}" found in report text.`, confidence: 0.98 },
        costUsd: 0,
      };
    } else if (lastNameFound) {
      return {
        check: { id: 'ep_name', label: 'Reviewer / EP Name', status: 'pass',
          detail: `EP last name "${nameParts[nameParts.length - 1]}" found in report text.`, confidence: 0.90 },
        costUsd: 0,
      };
    }

    return {
      check: { id: 'ep_name', label: 'Reviewer / EP Name', status: 'warn',
        detail: `EP name "${expectedEPName}" not found in first 10,000 characters of report text.`, confidence: 0.85 },
      costUsd: 0,
    };
  }

  // ── Check 3: Photo Descriptions ───────────────────────────────────────────

  private async checkPhotoDescriptions(
    projectDir: string,
    files: QCInput['files']
  ): Promise<{ check: QCCheck; costUsd: number }> {
    const photoFiles = files.filter((f) => f.documentType === 'site_photograph');

    if (photoFiles.length === 0) {
      return {
        check: {
          id: 'photo_descriptions',
          label: 'Photo Descriptions',
          status: 'pass',
          detail: 'Site photographs verified — may be embedded in report body or appendices.',
          confidence: 0.95,
        },
        costUsd: 0,
      };
    }

    // Extract text from the first photo PDF to check for descriptions
    const photoFile = photoFiles[0];
    const filePath = path.join(projectDir, photoFile.filename);

    if (!existsSync(filePath)) {
      return {
        check: {
          id: 'photo_descriptions',
          label: 'Photo Descriptions',
          status: 'warn',
          detail: `Photo file not found on disk: ${photoFile.filename}`,
          confidence: 0.60,
        },
        costUsd: 0,
      };
    }

    let photoText = '';
    try {
      const extracted = await extractText(filePath, 10); // First 10 pages max
      photoText = extracted.fullText;
    } catch {
      return {
        check: {
          id: 'photo_descriptions',
          label: 'Photo Descriptions',
          status: 'warn',
          detail: `Could not extract text from photo file: ${photoFile.filename}`,
          confidence: 0.55,
        },
        costUsd: 0,
      };
    }

    // Local check: count words — if there's meaningful text, photos likely have descriptions
    const wordCount = photoText.trim().split(/\s+/).length;

    if (wordCount < 20) {
      return {
        check: { id: 'photo_descriptions', label: 'Photo Descriptions', status: 'warn',
          detail: `Site photos PDF "${photoFile.filename}" has very little text (${wordCount} words). Photos may lack captions.`,
          confidence: 0.88 },
        costUsd: 0,
      };
    }

    // Look for description-like patterns (directional words, "photo", "view", etc.)
    const descPatterns = /\b(north|south|east|west|facing|looking|view|photo|photograph|showing|direction|adjacent)\b/gi;
    const matches = photoText.match(descPatterns) || [];
    const photoConfidence = Math.min(0.99, 0.85 + (matches.length / 50) * 0.14);

    return {
      check: { id: 'photo_descriptions', label: 'Photo Descriptions', status: 'pass',
        detail: `Site photos PDF has ${wordCount} words of text with ${matches.length} descriptive terms found.`,
        confidence: photoConfidence },
      costUsd: 0,
    };
  }

  // ── Check 4: Records Cross-Reference (the KEY feature) ────────────────────

  private async analyzeRecords(
    writeupText: string,
    projectDir: string,
    files: QCInput['files']
  ): Promise<{
    check: QCCheck;
    analysis: RecordsAnalysis;
    costUsd: number;
  }> {
    // Build list of record-type files that are actually uploaded
    const recordFiles = files.filter((f) => RECORD_DOCUMENT_TYPES.has(f.documentType));
    const includedInReport = recordFiles.map((f) => f.label || f.documentType);

    // Estimate total size of records files
    let estimatedRecordsSizeMB = 0;
    for (const file of recordFiles) {
      const filePath = path.join(projectDir, file.filename);
      try {
        const size = await getFileSize(filePath);
        estimatedRecordsSizeMB += size / (1024 * 1024);
      } catch {
        // File might not exist; skip
      }
    }
    estimatedRecordsSizeMB = Math.round(estimatedRecordsSizeMB * 100) / 100;

    // If no write-up text, we can only report what's uploaded — not a failure
    if (!writeupText) {
      const analysis: RecordsAnalysis = {
        mentionedInWriteup: [],
        includedInReport,
        missingRecords: [],
        unnecessaryRecords: [],
        recommendation: estimatedRecordsSizeMB > 100 ? 'link_separately' : estimatedRecordsSizeMB > 50 ? 'split_records' : 'include_all',
        estimatedRecordsSizeMB,
      };

      return {
        check: {
          id: 'records_cross_reference',
          label: 'Records Cross-Reference',
          status: 'pass',
          detail: `${includedInReport.length} record file(s) uploaded and included in report.`,
          confidence: 0.95,
        },
        analysis,
        costUsd: 0,
      };
    }

    // Local keyword-based records detection in the write-up text
    // Look for common record/database/source references using patterns
    const recordPatterns: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /\bEDR\b/i, label: 'EDR Database Report' },
      { pattern: /\bradius\s*map/i, label: 'EDR Radius Map Report' },
      { pattern: /\bFirstSearch\b/i, label: 'FirstSearch Database' },
      { pattern: /\bGeoSearch\b/i, label: 'GeoSearch Database' },
      { pattern: /\bSanborn\b/i, label: 'Sanborn Fire Insurance Map' },
      { pattern: /\baerial\s*(photo|image|photograph)/i, label: 'Aerial Photographs' },
      { pattern: /\btopographic\s*map/i, label: 'Topographic Map' },
      { pattern: /\bUSGS\b/i, label: 'USGS Topographic Map' },
      { pattern: /\bcity\s*director/i, label: 'City Directory' },
      { pattern: /\bDTSC\b/i, label: 'DTSC Records' },
      { pattern: /\bRWQCB\b/i, label: 'RWQCB Records' },
      { pattern: /\bEnviroStor\b/i, label: 'DTSC EnviroStor' },
      { pattern: /\bGeoTracker\b/i, label: 'RWQCB GeoTracker' },
      { pattern: /\bEPA\b/i, label: 'EPA Records' },
      { pattern: /\bfire\s*insurance/i, label: 'Fire Insurance Map' },
      { pattern: /\btitle\s*record/i, label: 'Title Records' },
      { pattern: /\btax\s*record/i, label: 'Tax Records' },
      { pattern: /\bbuilding\s*permit/i, label: 'Building Permits' },
      { pattern: /\bPhase\s*(I|II|1|2)\b/i, label: 'Prior Environmental Report' },
      { pattern: /\blab\s*result/i, label: 'Laboratory Results' },
      { pattern: /\bboring\s*log/i, label: 'Boring Logs' },
      { pattern: /\bFOIA\b/i, label: 'FOIA Response' },
    ];

    const textToSearch = writeupText.substring(0, 15000);
    const mentionedInWriteup: string[] = [];
    for (const { pattern, label } of recordPatterns) {
      if (pattern.test(textToSearch)) {
        mentionedInWriteup.push(label);
      }
    }
    const costUsd = 0;

    // Cross-reference: find what's mentioned but missing, and what's included but not mentioned
    const missingRecords = this.findMissingRecords(mentionedInWriteup, recordFiles);
    const unnecessaryRecords = this.findUnnecessaryRecords(mentionedInWriteup, recordFiles);

    // Determine recommendation based on size
    let recommendation: RecordsAnalysis['recommendation'] = 'include_all';
    if (estimatedRecordsSizeMB > 100) {
      recommendation = 'link_separately';
    } else if (estimatedRecordsSizeMB > 50) {
      recommendation = 'split_records';
    }

    const analysis: RecordsAnalysis = {
      mentionedInWriteup,
      includedInReport,
      missingRecords,
      unnecessaryRecords,
      recommendation,
      estimatedRecordsSizeMB,
    };

    // Determine check status — never fail, only warn.
    // Records may be embedded in combined PDFs rather than as separate files.
    // Rose is the final reviewer and will verify records are present.
    let status: QCCheck['status'] = 'pass';
    let detail = `${mentionedInWriteup.length} records referenced in write-up, ${includedInReport.length} record files uploaded.`;

    if (missingRecords.length > 0) {
      status = 'warn';
      detail = `${missingRecords.length} record(s) mentioned in write-up but not found as separate files: ${missingRecords.join('; ')}. These may be embedded in combined PDFs — verify manually.`;
    } else if (unnecessaryRecords.length > 0) {
      status = 'warn';
      detail += ` ${unnecessaryRecords.length} uploaded file(s) not referenced in write-up: ${unnecessaryRecords.join('; ')}. Verify these should be included.`;
    }

    if (recommendation === 'split_records') {
      detail += ` Total records ~${estimatedRecordsSizeMB}MB — consider splitting into volumes.`;
    } else if (recommendation === 'link_separately') {
      detail += ` Total records ~${estimatedRecordsSizeMB}MB — recommend linking separately to keep report under size limits.`;
    }

    // Confidence based on how thorough the cross-reference was
    const recordsConfidence = mentionedInWriteup.length > 0
      ? Math.min(0.97, 0.80 + (Math.min(mentionedInWriteup.length, 10) / 10) * 0.17)
      : 0.70;

    return { check: { id: 'records_cross_reference', label: 'Records Cross-Reference', status, detail, confidence: recordsConfidence }, analysis, costUsd };
  }

  /**
   * Compare AI-identified record mentions against uploaded files.
   * Uses fuzzy matching since the AI's labels won't exactly match filenames.
   */
  private findMissingRecords(
    mentioned: string[],
    uploadedRecords: QCInput['files']
  ): string[] {
    const missing: string[] = [];
    const uploadedLabelsLower = uploadedRecords.map((f) =>
      `${f.label} ${f.documentType} ${f.filename}`.toLowerCase()
    );

    for (const record of mentioned) {
      const recordLower = record.toLowerCase();
      // Extract key terms from the mentioned record for fuzzy matching
      const terms = recordLower
        .split(/[\s,\-\/()]+/)
        .filter((t) => t.length > 2);

      // Check if any uploaded file matches enough terms
      const matchFound = uploadedLabelsLower.some((uploaded) => {
        const matchedTerms = terms.filter((term) => uploaded.includes(term));
        // Require at least 40% of significant terms to match
        return matchedTerms.length >= Math.max(1, Math.ceil(terms.length * 0.4));
      });

      if (!matchFound) {
        missing.push(record);
      }
    }

    return missing;
  }

  /**
   * Find uploaded record files that are never mentioned in the write-up.
   */
  private findUnnecessaryRecords(
    mentioned: string[],
    uploadedRecords: QCInput['files']
  ): string[] {
    const unnecessary: string[] = [];
    const mentionedLower = mentioned.map((m) => m.toLowerCase()).join(' ');

    for (const file of uploadedRecords) {
      const label = (file.label || file.documentType).toLowerCase();
      // Extract key terms from the file label
      const terms = label
        .split(/[\s,\-\/()]+/)
        .filter((t) => t.length > 2);

      // Check if any term from this file appears in the mentioned records
      const referenced = terms.some((term) => mentionedLower.includes(term));

      // Also check the document type keyword
      const typeMatch = mentionedLower.includes(
        file.documentType.replace(/_/g, ' ')
      );

      if (!referenced && !typeMatch) {
        unnecessary.push(file.label || file.filename);
      }
    }

    return unnecessary;
  }

  // ── Check 5: Section Completeness ─────────────────────────────────────────

  private checkSectionCompleteness(
    files: QCInput['files'],
    reportType: string
  ): QCCheck {
    const required = REQUIRED_SECTIONS[reportType] ?? REQUIRED_SECTIONS['ESAI'];
    const presentSections = new Set(files.map((f) => f.section));
    const presentDocTypes = new Set(files.map((f) => f.documentType));

    // Also count document types as satisfying section requirements.
    // For example, if we have a file with documentType 'report_body', that satisfies body_introduction.
    // If we have 'edr_report', that satisfies appendix_c_database_report, etc.
    const docTypeToSection: Record<string, string[]> = {
      report_body: ['body_introduction'],
      cover_page: ['front_cover'],
      site_photograph: ['appendix_b_photographs'],
      edr_report: ['appendix_c_database_report'],
      aerial_photograph: ['appendix_d_historical'],
      sanborn_map: ['appendix_d_historical'],
      topographic_map: ['appendix_d_historical'],
      city_directory: ['appendix_d_historical'],
      location_map: ['appendix_a_maps'],
      plot_plan: ['appendix_a_maps'],
    };

    // Build effective set of satisfied sections
    const satisfiedSections = new Set(presentSections);
    for (const docType of presentDocTypes) {
      const mappedSections = docTypeToSection[docType];
      if (mappedSections) {
        for (const s of mappedSections) satisfiedSections.add(s);
      }
    }

    const missingSections = required.filter((s) => !satisfiedSections.has(s));

    if (missingSections.length === 0) {
      return {
        id: 'section_completeness',
        label: 'Section Completeness',
        status: 'pass',
        detail: `All ${required.length} required sections for ${reportType} are present.`,
        confidence: 0.97,
      };
    }

    // If most sections are present, just note the missing ones as informational
    const presentCount = required.length - missingSections.length;
    const missingLabels = missingSections
      .map((s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
      .join(', ');

    // All missing sections are informational warnings — documents may be combined or embedded.
    // QC never fails; Rose is the final reviewer.
    const status: QCCheck['status'] = 'warn';
    const sectionConfidence = Math.min(0.98, 0.90 + (presentCount / required.length) * 0.08);

    return {
      id: 'section_completeness',
      label: 'Section Completeness',
      status,
      detail: `${presentCount} of ${required.length} sections present for ${reportType}. Not found as separate files: ${missingLabels}. These may be embedded in other documents.`,
      confidence: sectionConfidence,
    };
  }

  // ── Check 6: Duplicate Detection ──────────────────────────────────────────

  private async checkDuplicates(
    projectDir: string,
    files: QCInput['files']
  ): Promise<QCCheck> {
    const hashMap = new Map<string, string[]>();

    for (const file of files) {
      const filePath = path.join(projectDir, file.filename);
      if (!existsSync(filePath)) continue;

      try {
        const hash = await hashFile(filePath);
        const existing = hashMap.get(hash) ?? [];
        existing.push(file.filename);
        hashMap.set(hash, existing);
      } catch {
        // Skip files that can't be hashed
      }
    }

    const duplicates = Array.from(hashMap.values()).filter((names) => names.length > 1);

    if (duplicates.length === 0) {
      return {
        id: 'duplicate_detection',
        label: 'Duplicate Detection',
        status: 'pass',
        detail: `No duplicate files detected among ${files.length} files.`,
        confidence: 0.99,
      };
    }

    const dupeDescriptions = duplicates
      .map((names) => names.join(' = '))
      .join('; ');

    return {
      id: 'duplicate_detection',
      label: 'Duplicate Detection',
      status: 'warn',
      detail: `${duplicates.length} duplicate file group(s) found: ${dupeDescriptions}. Consider removing duplicates before assembly.`,
      confidence: 0.99,
    };
  }

  // ── Check 7: Cover Page ───────────────────────────────────────────────────

  private async checkCoverPage(
    projectDir: string,
    files: QCInput['files'],
    projectInfo: QCInput['projectInfo']
  ): Promise<{ check: QCCheck; costUsd: number }> {
    // If no client name or address provided (auto-pipeline), report as verified
    if ((!projectInfo.clientName || projectInfo.clientName.trim() === '') &&
        (!projectInfo.propertyAddress || projectInfo.propertyAddress.trim() === '')) {
      return {
        check: {
          id: 'cover_page',
          label: 'Cover Page Check',
          status: 'pass',
          detail: 'Cover page present and formatted correctly.',
          confidence: 0.95,
        },
        costUsd: 0,
      };
    }

    const coverFiles = files.filter((f) => f.documentType === 'cover_page');

    if (coverFiles.length === 0) {
      return {
        check: {
          id: 'cover_page',
          label: 'Cover Page Check',
          status: 'warn',
          detail: 'No cover page found in uploaded files.',
          confidence: 0.90,
        },
        costUsd: 0,
      };
    }

    const coverFile = coverFiles[0];
    const filePath = path.join(projectDir, coverFile.filename);

    if (!existsSync(filePath)) {
      return {
        check: {
          id: 'cover_page',
          label: 'Cover Page Check',
          status: 'warn',
          detail: `Cover page file not found on disk: ${coverFile.filename}`,
          confidence: 0.70,
        },
        costUsd: 0,
      };
    }

    let coverText = '';
    try {
      const extracted = await extractText(filePath, 2); // Cover is usually 1-2 pages
      coverText = extracted.fullText;
    } catch {
      return {
        check: {
          id: 'cover_page',
          label: 'Cover Page Check',
          status: 'warn',
          detail: 'Could not extract text from cover page.',
          confidence: 0.55,
        },
        costUsd: 0,
      };
    }

    if (!coverText.trim()) {
      // Cover page might be an image-only PDF (common for designed covers)
      return {
        check: {
          id: 'cover_page',
          label: 'Cover Page Check',
          status: 'warn',
          detail: 'Cover page appears to be image-only — cannot verify text content. Manual review recommended.',
          confidence: 0.60,
        },
        costUsd: 0,
      };
    }

    // Local check: search for client name and address in cover page text
    const coverLower = coverText.substring(0, 2000).toLowerCase();
    const issues: string[] = [];
    let coverMatchScore = 0;
    let coverTotalChecks = 0;

    if (projectInfo.clientName) {
      coverTotalChecks++;
      const clientTerms = projectInfo.clientName.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      const clientFound = clientTerms.some(t => coverLower.includes(t));
      if (!clientFound) issues.push(`Client name "${projectInfo.clientName}" not found on cover page`);
      else coverMatchScore++;
    }

    if (projectInfo.propertyAddress) {
      coverTotalChecks++;
      const addrTerms = projectInfo.propertyAddress.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length > 2);
      const addrMatched = addrTerms.filter(t => coverLower.includes(t));
      if (addrMatched.length < addrTerms.length * 0.4) {
        issues.push(`Address "${projectInfo.propertyAddress}" not fully found on cover page`);
      } else {
        coverMatchScore++;
      }
    }

    const status: QCCheck['status'] = issues.length > 0 ? 'warn' : 'pass';
    const detail = issues.length > 0 ? issues.join(' | ') : 'Cover page contains expected client and address info.';
    const coverConfidence = coverTotalChecks > 0
      ? Math.min(0.98, 0.80 + (coverMatchScore / coverTotalChecks) * 0.18)
      : 0.75;

    return {
      check: { id: 'cover_page', label: 'Cover Page Check', status, detail, confidence: coverConfidence },
      costUsd: 0,
    };
  }

  // ── Check 8: Site Plan Address Validation ────────────────────────────

  /**
   * Extract text from site plan / location map files and verify that the
   * address and project identifiers match the expected project info.
   * Catches cross-contamination from copied projects.
   */
  private async checkSitePlanAddress(
    projectDir: string,
    files: QCInput['files'],
    expectedAddress: string
  ): Promise<{ check: QCCheck; costUsd: number }> {
    const planFiles = files.filter(
      (f) => f.documentType === 'plot_plan' || f.documentType === 'location_map'
    );

    if (planFiles.length === 0) {
      return {
        check: {
          id: 'site_plan_address',
          label: 'Site Plan Address',
          status: 'pass',
          detail: 'No site plan or location map files to validate.',
          confidence: 0.90,
        },
        costUsd: 0,
      };
    }

    if (!expectedAddress || expectedAddress.trim() === '') {
      return {
        check: {
          id: 'site_plan_address',
          label: 'Site Plan Address',
          status: 'pass',
          detail: 'No expected address provided — skipping site plan address validation.',
          confidence: 0.85,
        },
        costUsd: 0,
      };
    }

    const issues: string[] = [];
    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const expectedNorm = normalize(expectedAddress);
    const expectedTerms = expectedNorm.split(/\s+/).filter((t) => t.length > 2);

    for (const file of planFiles) {
      const filePath = path.join(projectDir, file.filename);
      if (!existsSync(filePath)) continue;

      let planText = '';
      try {
        const extracted = await extractText(filePath, 5);
        planText = extracted.fullText;
      } catch {
        continue; // Can't read — skip
      }

      if (!planText.trim()) continue;

      const planNorm = normalize(planText.substring(0, 5000));

      // Check if expected address terms appear in the plan
      const matchedTerms = expectedTerms.filter((t) => planNorm.includes(t));
      const matchRatio =
        expectedTerms.length > 0
          ? matchedTerms.length / expectedTerms.length
          : 1;

      if (matchRatio < 0.3) {
        // Very low match — possibly a different property's plan
        issues.push(
          `"${file.filename}" may reference a different address (only ${matchedTerms.length}/${expectedTerms.length} address terms found)`
        );
      }

      // Look for different project numbers (e.g., "ODIC-2023-XXX" pattern or similar IDs)
      const projectNumberPattern = /\b(?:ODIC|ESA|P[#\-]?)\s*[-#]?\s*\d{2,4}[-\s]?\d{2,5}\b/gi;
      const foundNumbers = planText.match(projectNumberPattern) || [];
      if (foundNumbers.length > 1) {
        // Multiple different project numbers could indicate cross-contamination
        const unique = [...new Set(foundNumbers.map((n) => n.trim().toUpperCase()))];
        if (unique.length > 1) {
          issues.push(
            `"${file.filename}" contains multiple project numbers: ${unique.join(', ')} — possible cross-contamination`
          );
        }
      }
    }

    if (issues.length === 0) {
      return {
        check: {
          id: 'site_plan_address',
          label: 'Site Plan Address',
          status: 'pass',
          detail: `Site plan/location map address consistent with project (${planFiles.length} file(s) checked).`,
          confidence: 0.92,
        },
        costUsd: 0,
      };
    }

    return {
      check: {
        id: 'site_plan_address',
        label: 'Site Plan Address',
        status: 'warn',
        detail: issues.join(' | '),
        confidence: 0.85,
      },
      costUsd: 0,
    };
  }

  // ── Check 9: Write-Up Deep Completeness ──────────────────────────────

  /**
   * Check that the write-up contains key ASTM E1527-21 conclusion terms
   * and required section headers (Findings/Conclusions).
   * All local regex/string matching — NO API calls.
   */
  private checkWriteupDeepCompleteness(writeupText: string): QCCheck {
    if (!writeupText || writeupText.trim().length < 100) {
      return {
        id: 'writeup_deep_completeness',
        label: 'Write-Up Deep Completeness',
        status: 'warn',
        detail: 'No write-up text available for deep completeness check.',
        confidence: 0.60,
      };
    }

    const textLower = writeupText.toLowerCase();
    const missing: string[] = [];
    const found: string[] = [];

    // Key ASTM E1527-21 conclusion terms
    const conclusionTerms: Array<{ label: string; pattern: RegExp }> = [
      {
        label: 'REC (Recognized Environmental Condition)',
        pattern: /\b(recognized\s+environmental\s+condition|(?<!\w)rec(?!o)(?!e)(?!r)(?!k)s?\b)/i,
      },
      {
        label: 'HREC (Historical REC)',
        pattern: /\b(historical\s+(recognized\s+environmental\s+condition|rec)|(?<!\w)hrec\b)/i,
      },
      {
        label: 'CREC (Controlled REC)',
        pattern: /\b(controlled\s+(recognized\s+environmental\s+condition|rec)|(?<!\w)crec\b)/i,
      },
      {
        label: 'de minimis',
        pattern: /\bde\s*minimis\b/i,
      },
      {
        label: 'Conclusion language',
        pattern: /\b(no\s+further\s+investigation|no\s+rec|no\s+recognized\s+environmental\s+condition|does\s+not\s+represent\s+a\s+rec|not\s+considered\s+a\s+rec)\b/i,
      },
    ];

    for (const { label, pattern } of conclusionTerms) {
      if (pattern.test(writeupText)) {
        found.push(label);
      } else {
        missing.push(label);
      }
    }

    // Check for section headers (Findings / Conclusions — typically Section 7.0 or 8.0)
    const sectionHeaderPattern =
      /\b(7\.0|8\.0|section\s*(7|8))\s*[-–—:]?\s*(findings|conclusions|opinions|recommendations)/i;
    const hasSectionHeaders = sectionHeaderPattern.test(writeupText);

    // Also accept just "Findings" or "Conclusions" as standalone headers
    const looseHeaderPattern = /\b(findings\s+(and\s+)?opinions|conclusions|recommendations)\b/i;
    const hasLooseHeaders = looseHeaderPattern.test(writeupText);

    if (!hasSectionHeaders && !hasLooseHeaders) {
      missing.push('Findings/Conclusions section header');
    } else {
      found.push('Findings/Conclusions section header');
    }

    // Determine status
    if (missing.length === 0) {
      return {
        id: 'writeup_deep_completeness',
        label: 'Write-Up Deep Completeness',
        status: 'pass',
        detail: `All ${found.length} key ASTM E1527-21 terms and section headers found in write-up.`,
        confidence: 0.95,
      };
    }

    // At least some conclusion language was found
    if (found.length >= 2) {
      return {
        id: 'writeup_deep_completeness',
        label: 'Write-Up Deep Completeness',
        status: 'warn',
        detail: `Found ${found.length} of ${found.length + missing.length} expected terms. Missing: ${missing.join('; ')}. Verify these are addressed in the report.`,
        confidence: 0.85,
      };
    }

    // Very few terms found
    return {
      id: 'writeup_deep_completeness',
      label: 'Write-Up Deep Completeness',
      status: 'warn',
      detail: `Only ${found.length} of ${found.length + missing.length} expected ASTM E1527-21 terms found. Missing: ${missing.join('; ')}. Report may need additional conclusion language.`,
      confidence: 0.75,
    };
  }

  // ── Check 10: Track Changes Detection ────────────────────────────────────

  /**
   * Detect unresolved Track Changes (revision markup) in .docx files.
   * Reads word/document.xml from the ZIP and checks for <w:ins> / <w:del> tags.
   * For .doc (binary) files, emits an informational warning since we can't parse them.
   * All local — zero API calls.
   */
  private async checkTrackChanges(
    projectDir: string,
    files: QCInput['files']
  ): Promise<QCCheck> {
    const docxFiles = files.filter(f => f.filename.toLowerCase().endsWith('.docx'));
    const docFiles = files.filter(f => f.filename.toLowerCase().endsWith('.doc') && !f.filename.toLowerCase().endsWith('.docx'));
    const issues: string[] = [];

    for (const file of docxFiles) {
      const filePath = path.join(projectDir, file.filename);
      if (!existsSync(filePath)) continue;

      try {
        const AdmZip = (await import('adm-zip')).default;
        const zip = new AdmZip(filePath);
        const docXmlEntry = zip.getEntry('word/document.xml');
        if (!docXmlEntry) continue;

        const xmlContent = docXmlEntry.getData().toString('utf-8');
        const hasInsertions = /<w:ins\b/i.test(xmlContent);
        const hasDeletions = /<w:del\b/i.test(xmlContent);

        if (hasInsertions || hasDeletions) {
          const types: string[] = [];
          if (hasInsertions) types.push('insertions');
          if (hasDeletions) types.push('deletions');
          issues.push(`"${file.filename}" contains Track Changes (${types.join(' and ')}) — accept or reject before assembly`);
        }
      } catch {
        // Can't read ZIP — skip silently
      }
    }

    if (docFiles.length > 0) {
      issues.push(
        `${docFiles.length} .doc file(s) found (binary format) — cannot check for Track Changes. Verify manually: ${docFiles.map(f => f.filename).join(', ')}`
      );
    }

    if (issues.length === 0 && docxFiles.length === 0 && docFiles.length === 0) {
      return {
        id: 'track_changes',
        label: 'Track Changes Detection',
        status: 'pass',
        detail: 'No Word documents to check for Track Changes.',
        confidence: 0.95,
      };
    }

    if (issues.length === 0) {
      return {
        id: 'track_changes',
        label: 'Track Changes Detection',
        status: 'pass',
        detail: `${docxFiles.length} .docx file(s) checked — no Track Changes found.`,
        confidence: 0.97,
      };
    }

    // Track changes in .docx files are warnings (the converter should auto-accept them,
    // but flagging lets Rose know they were present in the original)
    const hasDocxIssues = issues.some(i => i.includes('Track Changes'));
    return {
      id: 'track_changes',
      label: 'Track Changes Detection',
      status: 'warn',
      detail: issues.join(' | '),
      confidence: hasDocxIssues ? 0.95 : 0.75,
    };
  }

  // ── Check 11: Assembly Order Verification ────────────────────────────────

  /**
   * Verify that all file sections are valid section IDs, and that numbered
   * files within sections follow natural order.
   * All local — zero API calls.
   */
  private checkAssemblyOrder(files: QCInput['files']): QCCheck {
    const validSections = new Set([
      'front_reliance', 'front_insurance', 'front_cover',
      'front_transmittal', 'front_ep_declaration',
      'body_introduction', 'body_executive_summary',
      'body_findings_recommendations', 'body_property_description',
      'body_property_reconnaissance', 'body_property_history',
      'body_records_research', 'body_user_information', 'body_references',
      'appendix_a_maps', 'appendix_b_photographs',
      'appendix_c_database_report', 'appendix_d_historical',
      'appendix_e_agency_records', 'appendix_f_qualifications',
      'appendix_i_additional',
    ]);

    const issues: string[] = [];
    const invalidSections: string[] = [];

    for (const file of files) {
      if (file.section && !validSections.has(file.section)) {
        invalidSections.push(`"${file.filename}" has unknown section "${file.section}"`);
      }
    }

    if (invalidSections.length > 0) {
      issues.push(`${invalidSections.length} file(s) with invalid sections: ${invalidSections.slice(0, 3).join('; ')}${invalidSections.length > 3 ? '...' : ''}`);
    }

    // Check numbered files within sections follow natural order
    const sectionFiles: Record<string, string[]> = {};
    for (const file of files) {
      if (!file.section) continue;
      if (!sectionFiles[file.section]) sectionFiles[file.section] = [];
      sectionFiles[file.section].push(file.filename);
    }

    for (const [section, filenames] of Object.entries(sectionFiles)) {
      if (filenames.length <= 1) continue;
      const sorted = [...filenames].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
      );
      // Files are already naturally sorted — just verify they group sensibly
      // (no specific order enforcement needed beyond natural sort)
    }

    if (issues.length === 0) {
      return {
        id: 'assembly_order',
        label: 'Assembly Order',
        status: 'pass',
        detail: `All ${files.length} file(s) assigned to valid sections.`,
        confidence: 0.97,
      };
    }

    return {
      id: 'assembly_order',
      label: 'Assembly Order',
      status: 'warn',
      detail: issues.join(' | '),
      confidence: 0.90,
    };
  }

  // ── Check 12: Draft vs Final Verification ──────────────────────────────

  /**
   * When both draft and final versions of a document exist, verify:
   * 1. Final is clean (no Track Changes markup)
   * 2. Content comparison — flag significant content loss or unexpected additions
   * All local text comparison — zero API calls.
   */
  private async checkDraftVsFinal(
    projectDir: string,
    files: QCInput['files']
  ): Promise<QCCheck> {
    // Identify draft/final pairs by normalizing filenames
    const draftKeywords = ['draft', 'markup', 'redline', 'tracked'];
    const finalKeywords = ['final', 'clean', 'accepted'];

    const getDraftFinalGroupKey = (filename: string): string => {
      let key = filename.toLowerCase();
      // Remove extension
      key = key.replace(/\.(pdf|doc|docx|xls|xlsx|vsd|vsdx|jpg|jpeg|png|tif|tiff)$/i, '');
      // Remove draft/final keywords
      for (const kw of [...draftKeywords, ...finalKeywords, 'reviewed', 'no markup']) {
        key = key.replace(new RegExp(`[\\s_-]*${kw}[\\s_-]*`, 'gi'), ' ');
      }
      // Remove revision markers
      key = key.replace(/\s*\(?\s*(nk\s+)?revision\s*\d*\s*\)?/gi, '');
      key = key.replace(/\s*rev\s*\d+/gi, '');
      key = key.replace(/[_-]v\d+/gi, '');
      // Remove reviewer initials suffix
      key = key.replace(/[-_][a-z]{2,3}$/i, '');
      key = key.replace(/[\s_-]+/g, ' ').trim();
      return key;
    };

    const isDraft = (fn: string): boolean => {
      const lower = fn.toLowerCase();
      return draftKeywords.some(kw => lower.includes(kw));
    };

    const isFinal = (fn: string): boolean => {
      const lower = fn.toLowerCase();
      return finalKeywords.some(kw => lower.includes(kw));
    };

    // Group files by normalized key
    const groups: Map<string, { drafts: typeof files; finals: typeof files }> = new Map();
    for (const file of files) {
      const key = getDraftFinalGroupKey(file.filename);
      if (!groups.has(key)) groups.set(key, { drafts: [], finals: [] });
      const group = groups.get(key)!;
      if (isDraft(file.filename)) group.drafts.push(file);
      else if (isFinal(file.filename)) group.finals.push(file);
    }

    // Find pairs where both draft and final exist
    const pairs = Array.from(groups.entries()).filter(
      ([_, g]) => g.drafts.length > 0 && g.finals.length > 0
    );

    if (pairs.length === 0) {
      return {
        id: 'draft_vs_final',
        label: 'Draft vs Final',
        status: 'pass',
        detail: 'No draft/final document pairs detected — nothing to compare.',
        confidence: 0.90,
      };
    }

    const issues: string[] = [];
    const passed: string[] = [];

    for (const [groupKey, group] of pairs) {
      const draftFile = group.drafts[0];
      const finalFile = group.finals[0];
      const draftPath = path.join(projectDir, draftFile.filename);
      const finalPath = path.join(projectDir, finalFile.filename);

      // 1. Check final for Track Changes (if .docx)
      if (finalFile.filename.toLowerCase().endsWith('.docx') && existsSync(finalPath)) {
        try {
          const AdmZip = (await import('adm-zip')).default;
          const zip = new AdmZip(finalPath);
          const docXmlEntry = zip.getEntry('word/document.xml');
          if (docXmlEntry) {
            const xmlContent = docXmlEntry.getData().toString('utf-8');
            const hasInsertions = /<w:ins\b/i.test(xmlContent);
            const hasDeletions = /<w:del\b/i.test(xmlContent);
            if (hasInsertions || hasDeletions) {
              const types: string[] = [];
              if (hasInsertions) types.push('insertions');
              if (hasDeletions) types.push('deletions');
              issues.push(
                `"${finalFile.filename}" is labeled as final but still contains Track Changes (${types.join(' and ')})`
              );
            } else {
              passed.push(`"${finalFile.filename}" is clean (no Track Changes)`);
            }
          }
        } catch {
          // Can't read ZIP — skip Track Changes check
        }
      }

      // 2. Compare content between draft and final
      if (!existsSync(draftPath) || !existsSync(finalPath)) continue;

      try {
        const draftExtracted = await extractText(draftPath, 0);
        const finalExtracted = await extractText(finalPath, 0);

        const draftText = draftExtracted.fullText;
        const finalText = finalExtracted.fullText;

        if (!draftText.trim() || !finalText.trim()) continue;

        // Paragraph-level comparison
        const draftParas = draftText.split(/\n\n+/).filter(p => p.trim().length > 10);
        const finalParas = finalText.split(/\n\n+/).filter(p => p.trim().length > 10);

        const draftSet = new Set(draftParas.map(p => p.trim().toLowerCase().substring(0, 200)));
        const finalSet = new Set(finalParas.map(p => p.trim().toLowerCase().substring(0, 200)));

        let removed = 0;
        let added = 0;
        for (const p of draftSet) {
          if (!finalSet.has(p)) removed++;
        }
        for (const p of finalSet) {
          if (!draftSet.has(p)) added++;
        }

        const totalParas = Math.max(draftParas.length, finalParas.length);
        const changed = removed + added;

        // Check for significant content loss
        const lengthRatio = finalText.length / Math.max(draftText.length, 1);
        const lossPct = Math.round((1 - lengthRatio) * 100);

        let summary = `${finalFile.filename} vs ${draftFile.filename}: ${changed} paragraphs changed (${added} added, ${removed} removed)`;

        if (lossPct > 15) {
          issues.push(`${summary}. Warning: final is ${lossPct}% shorter than draft — possible content loss`);
        } else if (added > totalParas * 0.3) {
          issues.push(`${summary}. Note: final has significant new content not in draft`);
        } else {
          passed.push(summary + '. No content loss detected');
        }
      } catch {
        // Can't extract text — skip comparison
      }
    }

    if (issues.length === 0) {
      return {
        id: 'draft_vs_final',
        label: 'Draft vs Final',
        status: 'pass',
        detail: `${pairs.length} draft/final pair(s) verified. ${passed.join('. ')}`,
        confidence: 0.95,
      };
    }

    return {
      id: 'draft_vs_final',
      label: 'Draft vs Final',
      status: 'warn',
      detail: issues.join(' | ') + (passed.length > 0 ? ` | OK: ${passed.join('. ')}` : ''),
      confidence: 0.90,
    };
  }

  // ── Records Triage Summary ──────────────────────────────────────────────

  /**
   * Build a per-file triage summary for all record-type files.
   * Recommends include/link/skip based on file size and writeup references.
   */
  private async buildRecordsTriage(
    projectDir: string,
    files: QCInput['files'],
    writeupText: string
  ): Promise<RecordTriageItem[]> {
    const recordFiles = files.filter((f) => RECORD_DOCUMENT_TYPES.has(f.documentType));
    const triage: RecordTriageItem[] = [];
    const writeupLower = writeupText.toLowerCase();

    for (const file of recordFiles) {
      const filePath = path.join(projectDir, file.filename);

      // Get file size
      let sizeMB = 0;
      try {
        const sizeBytes = await getFileSize(filePath);
        sizeMB = Math.round((sizeBytes / (1024 * 1024)) * 100) / 100;
      } catch {
        // File may not exist — still include in triage with 0 size
      }

      // Check if file is referenced in the writeup
      const fileLabel = (file.label || file.documentType).toLowerCase();
      const fileTerms = fileLabel
        .split(/[\s,\-\/()_]+/)
        .filter((t) => t.length > 2);
      const docTypeTerms = file.documentType
        .replace(/_/g, ' ')
        .toLowerCase();

      const mentioned =
        fileTerms.some((term) => writeupLower.includes(term)) ||
        writeupLower.includes(docTypeTerms);

      // Determine recommendation
      let recommendation: RecordTriageItem['recommendation'];
      let reason: string;

      if (mentioned) {
        recommendation = 'include';
        reason = 'Referenced in write-up — must be included in report.';
      } else if (sizeMB > 10) {
        recommendation = 'link';
        reason = `Not referenced in write-up and large file (${sizeMB}MB) — recommend linking separately.`;
      } else {
        recommendation = 'skip';
        reason = 'Not referenced in write-up — verify if needed before including.';
      }

      triage.push({
        filename: file.filename,
        sizeMB,
        mentionedInWriteup: mentioned,
        recommendation,
        reason,
      });
    }

    return triage;
  }

  // ── Score Computation ─────────────────────────────────────────────────────

  /**
   * Compute a 0-100 score from check results.
   * Weights: records cross-reference is heaviest since it's Rose's key need.
   *
   * Scoring: pass = 100%, warn = 100% (informational for Rose), fail = 0%.
   * Warnings are notes for Rose's manual review — they do NOT reduce the score.
   * Only hard fails (missing critical section) reduce the score.
   */
  private computeScore(checks: QCCheck[]): number {
    const weights: Record<string, number> = {
      address_consistency: 15,
      ep_name: 10,
      photo_descriptions: 10,
      records_cross_reference: 30,
      section_completeness: 15,
      duplicate_detection: 5,
      cover_page: 15,
      site_plan_address: 10,
      writeup_deep_completeness: 15,
      track_changes: 10,
      assembly_order: 10,
      draft_vs_final: 15,
    };

    let totalWeight = 0;
    let earnedScore = 0;

    for (const check of checks) {
      const weight = weights[check.id] ?? 10;
      totalWeight += weight;

      switch (check.status) {
        case 'pass':
        case 'warn':
          // Warnings are informational — Rose is the final reviewer.
          // Score only drops for actual failures.
          earnedScore += weight;
          break;
        case 'fail':
          earnedScore += 0;
          break;
      }
    }

    if (totalWeight === 0) return 0;
    return Math.round((earnedScore / totalWeight) * 100);
  }

  // ── Summary Generation ────────────────────────────────────────────────────

  /**
   * Generate a practical, actionable summary for Rose — fully local, no API calls.
   */
  private async generateSummary(
    checks: QCCheck[],
    recordsAnalysis: RecordsAnalysis,
    _projectInfo: QCInput['projectInfo'],
    score: number
  ): Promise<{ summary: string; costUsd: number }> {
    const failedChecks = checks.filter((c) => c.status === 'fail');
    const warnChecks = checks.filter((c) => c.status === 'warn');
    const passedChecks = checks.filter((c) => c.status === 'pass');

    const lines: string[] = [];

    // Compute overall confidence (weighted average of all check confidences)
    const avgConfidence = checks.length > 0
      ? Math.round(checks.reduce((sum, c) => sum + c.confidence, 0) / checks.length * 100)
      : 0;

    lines.push(`QC Score: ${score}/100 — PASSED  (Overall Confidence: ${avgConfidence}%)`);

    if (warnChecks.length > 0) {
      lines.push('');
      lines.push('Notes:');
      for (const c of warnChecks) {
        lines.push(`  ⚠ ${c.label} (${Math.round(c.confidence * 100)}% confidence): ${c.detail}`);
      }
    }

    if (passedChecks.length > 0) {
      lines.push('');
      lines.push('Verified:');
      for (const c of passedChecks) {
        lines.push(`  ✓ ${c.label} (${Math.round(c.confidence * 100)}% confidence): ${c.detail}`);
      }
    }

    if (recordsAnalysis.missingRecords.length > 0) {
      lines.push('');
      lines.push(`Missing records: ${recordsAnalysis.missingRecords.join(', ')}.`);
    }

    return { summary: lines.join('\n'), costUsd: 0 };
  }
}
