/**
 * Assembly Step — builds the final report PDF from organized documents.
 *
 * This is where classified, organized documents become an actual report.
 * The assembler:
 * 1. Walks through sections in canonical order
 * 2. Generates appendix divider pages between appendices
 * 3. Merges all component PDFs into a single output document
 * 4. Performs page integrity verification (input pages == output pages)
 * 5. Records the report manifest for QA
 *
 * Page integrity is NON-NEGOTIABLE. If the merge produces a different
 * page count than expected, the assembly halts with an error.
 *
 * Generated content (cover pages, TOC, executive summary, etc.) is
 * expected to be created by earlier pipeline steps (generate_cover,
 * generate_toc, generate_narrative). This step only merges.
 */

import pino from 'pino';
import fs from 'fs/promises';
import path from 'path';
import type {
  AppConfig,
  PipelineContext,
  StepResult,
  ReportSection,
} from '../types/index.js';
import { ESAI_SECTION_ORDER } from '../types/documents.js';
import type { ReportManifest, ReportSectionManifest } from '../types/documents.js';
import { StateManager, type DocumentRow } from '../core/state.js';
import type { ESATemplate } from '../core/config-loader.js';
import { getReportTypeTemplate } from '../core/config-loader.js';
import {
  mergePDFs,
  createTextPage,
  ensureDir,
  getPageCount,
  isValidPDF,
  type MergeInput,
} from '../core/pdf-utils.js';

const logger = pino({ name: 'AssembleStep', level: process.env.LOG_LEVEL || 'info' });

/** Summary data returned from the assemble step */
export interface AssembleStepData {
  /** Path to the final output PDF */
  outputPdfPath: string;
  /** Total pages in the final report */
  totalPages: number;
  /** Pages from source documents */
  sourcePages: number;
  /** Pages generated (dividers, etc.) */
  generatedPages: number;
  /** Sections included */
  sectionsIncluded: number;
  /** Page integrity check passed */
  integrityPassed: boolean;
  /** The full report manifest */
  manifest: ReportManifest;
}

// ── Appendix Divider Configuration ────────────────────────────────────────────

interface AppendixDividerConfig {
  letter: string;
  title: string;
  subtitle?: string;
}

const APPENDIX_DIVIDERS: Record<string, AppendixDividerConfig> = {
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

/**
 * Generate a single appendix divider page PDF.
 * Matches ODIC's style: centered text with company header.
 */
async function generateDividerPage(
  divider: AppendixDividerConfig,
  esaTemplate: ESATemplate
): Promise<Buffer> {
  type LineSpec = {
    text: string;
    fontSize?: number;
    bold?: boolean;
    align?: 'left' | 'center' | 'right';
    color?: { r: number; g: number; b: number };
  };

  const lines: LineSpec[] = [
    // Company header
    { text: esaTemplate.company, fontSize: 10, align: 'center', color: { r: 0.3, g: 0.3, b: 0.3 } },
    { text: '', fontSize: 40 }, // Large spacer
    { text: '', fontSize: 40 },
    { text: '', fontSize: 40 },
    // Appendix title
    { text: divider.title, fontSize: 28, bold: true, align: 'center' },
    { text: '', fontSize: 20 }, // Spacer
  ];

  // Subtitle in smaller text
  if (divider.subtitle) {
    lines.push({ text: divider.subtitle, fontSize: 14, bold: false, align: 'center', color: { r: 0.3, g: 0.3, b: 0.3 } });
  }

  return createTextPage(lines);
}

/**
 * Get section title for the manifest.
 */
function getSectionTitle(section: ReportSection): string {
  const titles: Record<string, string> = {
    front_cover: 'Cover Page',
    front_transmittal: 'Transmittal Letter',
    front_reliance: 'Reliance Letter',
    front_insurance: 'Insurance Certificate',
    front_ep_declaration: 'EP Declaration',
    front_toc: 'Table of Contents',
    body_executive_summary: 'Executive Summary',
    body_findings_recommendations: 'Findings & Recommendations',
    body_introduction: '1.0 Introduction',
    body_property_description: '2.0 Property Description',
    body_property_reconnaissance: '3.0 Property Reconnaissance',
    body_property_history: '4.0 Property History',
    body_records_research: '5.0 Records Research',
    body_user_information: '6.0 User Information',
    body_references: '7.0 References',
    body_sba_requirements: 'SBA Requirements',
    appendix_a_maps: 'Appendix A — Maps & Figures',
    appendix_b_photographs: 'Appendix B — Photographs',
    appendix_c_database_report: 'Appendix C — Database Report',
    appendix_d_historical: 'Appendix D — Historical Records',
    appendix_e_agency_records: 'Appendix E — Agency Records',
    appendix_f_qualifications: 'Appendix F — EP Qualifications',
    appendix_g_lab_results: 'Appendix G — Laboratory Results',
    appendix_h_boring_logs: 'Appendix H — Boring Logs',
    appendix_i_additional: 'Appendix I — Additional Documents',
  };
  return titles[section] ?? section;
}

function getSectionNumber(section: ReportSection): string {
  const numbers: Record<string, string> = {
    front_cover: '',
    front_transmittal: '',
    front_reliance: '',
    front_insurance: '',
    front_ep_declaration: '',
    front_toc: '',
    body_executive_summary: '',
    body_findings_recommendations: '',
    body_introduction: '1.0',
    body_property_description: '2.0',
    body_property_reconnaissance: '3.0',
    body_property_history: '4.0',
    body_records_research: '5.0',
    body_user_information: '6.0',
    body_references: '7.0',
    body_sba_requirements: '',
    appendix_a_maps: 'Appendix A',
    appendix_b_photographs: 'Appendix B',
    appendix_c_database_report: 'Appendix C',
    appendix_d_historical: 'Appendix D',
    appendix_e_agency_records: 'Appendix E',
    appendix_f_qualifications: 'Appendix F',
    appendix_g_lab_results: 'Appendix G',
    appendix_h_boring_logs: 'Appendix H',
    appendix_i_additional: 'Appendix I',
  };
  return numbers[section] ?? '';
}

/**
 * Create the "assemble" step executor function.
 */
export function createAssembleExecutor(
  config: AppConfig,
  state: StateManager,
  esaTemplate: ESATemplate
): (ctx: PipelineContext) => Promise<StepResult> {
  return async (ctx: PipelineContext): Promise<StepResult> => {
    const startTime = Date.now();
    const projectId = ctx.project.id;

    logger.info({ projectId }, 'Starting assembly step');

    // Get organized documents grouped by section
    const documents = state.getDocuments(projectId);
    const includedDocs = documents.filter((d) => d.included !== 0 && d.section_assignment);

    if (includedDocs.length === 0) {
      return {
        step: 'assemble',
        success: false,
        durationMs: Date.now() - startTime,
        error: 'No organized documents found for assembly',
      };
    }

    // Group by section
    const sectionDocs = new Map<ReportSection, DocumentRow[]>();
    for (const doc of includedDocs) {
      const section = doc.section_assignment as ReportSection;
      if (!sectionDocs.has(section)) {
        sectionDocs.set(section, []);
      }
      sectionDocs.get(section)!.push(doc);
    }

    // Sort docs within each section by order_index
    for (const [, docs] of sectionDocs) {
      docs.sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
    }

    // Build the merge list in canonical section order
    const mergeInputs: MergeInput[] = [];
    const sectionManifests: ReportSectionManifest[] = [];
    let currentPage = 1;
    let totalSourcePages = 0;
    let totalGeneratedPages = 0;

    // Temp directory for generated divider pages
    const tempDir = path.join(config.pipeline.project_base_dir, projectId, '_assembly_temp');
    await ensureDir(tempDir);

    for (const section of ESAI_SECTION_ORDER) {
      const docs = sectionDocs.get(section);
      if (!docs || docs.length === 0) continue;

      // Skip SBA-specific sections for non-SBA projects
      if (section === 'front_reliance' && !ctx.project.isSbaLoan) continue;
      if (section === 'body_sba_requirements' && !ctx.project.isSbaLoan) continue;

      // Generate appendix divider page if this is an appendix section
      const dividerConfig = APPENDIX_DIVIDERS[section];
      if (dividerConfig) {
        const dividerPdf = await generateDividerPage(dividerConfig, esaTemplate);
        const dividerPath = path.join(tempDir, `divider_${dividerConfig.letter}.pdf`);
        await fs.writeFile(dividerPath, dividerPdf);

        mergeInputs.push({
          filePath: dividerPath,
          label: `${dividerConfig.title} Divider`,
        });
        totalGeneratedPages += 1; // Dividers are always 1 page
      }

      // Add each document in this section
      const sectionDocEntries: ReportSectionManifest['documents'] = [];

      // If a divider was generated, count it
      if (dividerConfig) {
        sectionDocEntries.push({
          filename: `_divider_${dividerConfig.letter}.pdf`,
          pageCount: 1,
          isGenerated: true,
        });
      }

      for (const doc of docs) {
        // Validate the file exists and is a valid PDF
        const valid = await isValidPDF(doc.local_path);
        if (!valid) {
          logger.warn({ filename: doc.filename }, `Skipping invalid PDF: ${doc.filename}`);
          continue;
        }

        const docPageCount = await getPageCount(doc.local_path);

        mergeInputs.push({
          filePath: doc.local_path,
          label: `${section}/${doc.filename}`,
        });

        sectionDocEntries.push({
          filename: doc.filename,
          pageCount: docPageCount,
          isGenerated: false,
        });

        totalSourcePages += docPageCount;
      }

      const sectionPageCount = sectionDocEntries.reduce((sum, d) => sum + d.pageCount, 0);

      sectionManifests.push({
        section,
        title: getSectionTitle(section),
        sectionNumber: getSectionNumber(section),
        startPage: currentPage,
        documents: sectionDocEntries,
        totalPages: sectionPageCount,
      });

      currentPage += sectionPageCount;
    }

    // Also handle non-standard sections (Phase II appendices etc.)
    for (const [section, docs] of sectionDocs) {
      if (ESAI_SECTION_ORDER.includes(section)) continue; // Already handled

      for (const doc of docs) {
        const valid = await isValidPDF(doc.local_path);
        if (!valid) continue;

        const docPageCount = await getPageCount(doc.local_path);
        mergeInputs.push({
          filePath: doc.local_path,
          label: `${section}/${doc.filename}`,
        });
        totalSourcePages += docPageCount;

        sectionManifests.push({
          section,
          title: getSectionTitle(section),
          sectionNumber: getSectionNumber(section),
          startPage: currentPage,
          documents: [{ filename: doc.filename, pageCount: docPageCount, isGenerated: false }],
          totalPages: docPageCount,
        });
        currentPage += docPageCount;
      }
    }

    if (mergeInputs.length === 0) {
      return {
        step: 'assemble',
        success: false,
        durationMs: Date.now() - startTime,
        error: 'No valid PDFs to merge after validation',
      };
    }

    // Perform the merge
    logger.info(
      { inputCount: mergeInputs.length, expectedPages: totalSourcePages + totalGeneratedPages },
      'Merging PDFs...'
    );

    const mergeResult = await mergePDFs(mergeInputs);

    // Page integrity check
    const expectedTotal = totalSourcePages + totalGeneratedPages;
    const integrityPassed = mergeResult.totalPages === expectedTotal;

    if (!integrityPassed) {
      logger.error(
        { expected: expectedTotal, actual: mergeResult.totalPages },
        'PAGE INTEGRITY FAILURE'
      );
      // Still save the output for debugging, but mark as failed
    }

    // Write the output PDF
    const outputDir = config.pipeline.output_dir;
    await ensureDir(outputDir);
    const outputPdfPath = path.join(outputDir, `${projectId}_report.pdf`);
    await fs.writeFile(outputPdfPath, mergeResult.pdfBuffer);

    // Update project state
    state.updateProjectField(projectId, 'output_pdf_path', outputPdfPath);

    // Build manifest
    const manifest: ReportManifest = {
      projectId,
      reportType: ctx.project.reportType,
      sections: sectionManifests,
      totalPages: mergeResult.totalPages,
      sourcePages: totalSourcePages,
      generatedPages: totalGeneratedPages,
      outputPdfPath,
      outputDocxPath: null,
      assembledAt: new Date(),
    };

    ctx.project.reportManifest = manifest;
    ctx.project.outputPdfPath = outputPdfPath;

    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Non-critical
    }

    const durationMs = Date.now() - startTime;

    const stepData: AssembleStepData = {
      outputPdfPath,
      totalPages: mergeResult.totalPages,
      sourcePages: totalSourcePages,
      generatedPages: totalGeneratedPages,
      sectionsIncluded: sectionManifests.length,
      integrityPassed,
      manifest,
    };

    // Notification
    if (integrityPassed) {
      state.addNotification(
        projectId,
        'success',
        `Report assembled: ${mergeResult.totalPages} pages across ${sectionManifests.length} sections. ` +
        `Output: ${path.basename(outputPdfPath)}`
      );
    } else {
      state.addNotification(
        projectId,
        'error',
        `Report assembled but PAGE INTEGRITY FAILED: expected ${expectedTotal} pages, got ${mergeResult.totalPages}. ` +
        `Review the output before delivery.`
      );
    }

    logger.info(
      {
        projectId,
        totalPages: mergeResult.totalPages,
        sourcePages: totalSourcePages,
        generatedPages: totalGeneratedPages,
        sections: sectionManifests.length,
        integrityPassed,
        outputSize: `${(mergeResult.pdfBuffer.length / 1024 / 1024).toFixed(1)} MB`,
        durationMs,
      },
      'Assembly step complete'
    );

    return {
      step: 'assemble',
      success: integrityPassed,
      durationMs,
      data: stepData,
      error: integrityPassed ? undefined : `Page integrity check failed: expected ${expectedTotal}, got ${mergeResult.totalPages}`,
    };
  };
}
