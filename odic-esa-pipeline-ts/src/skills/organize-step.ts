/**
 * Organization Step — places classified documents into the correct
 * report sections and determines their order within each section.
 *
 * This step bridges classification and assembly:
 * 1. Reads classified documents from state
 * 2. Assigns each to a report section (using classification + template rules)
 * 3. Orders documents within each section according to report conventions
 * 4. Flags any missing required sections
 * 5. Stores the organized layout back to state
 *
 * The organizer respects manual overrides — if Rose reclassified a document
 * during triage, the override takes precedence.
 *
 * For most documents, the default section from classification is correct.
 * The AI organizer (Sonnet) is only called when there's ambiguity or
 * when the project has unusual documents that need intelligent placement.
 */

import pino from 'pino';
import type {
  AppConfig,
  PipelineContext,
  StepResult,
  ReportSection,
} from '../types/index.js';
import { ESAI_SECTION_ORDER, DOCUMENT_TYPE_TO_DEFAULT_SECTION } from '../types/documents.js';
import type { DocumentType, ClassifiedDocument, OrganizedDocument } from '../types/documents.js';
import { StateManager, type DocumentRow } from '../core/state.js';
import type { ESATemplate, ReportTypeTemplate } from '../core/config-loader.js';
import { getReportTypeTemplate } from '../core/config-loader.js';

const logger = pino({ name: 'OrganizeStep', level: process.env.LOG_LEVEL || 'info' });

/** Summary data returned from the organize step */
export interface OrganizeStepData {
  /** Total documents organized */
  totalDocuments: number;
  /** Sections populated */
  sectionsPopulated: number;
  /** Required sections still missing */
  missingSections: string[];
  /** Documents excluded (e.g., blank pages) */
  excluded: number;
  /** Per-section breakdown */
  sectionBreakdown: Array<{
    section: ReportSection;
    title: string;
    documentCount: number;
    totalPages: number;
  }>;
}

/**
 * Document ordering rules within sections.
 * Maps section IDs to a priority function that returns sort keys.
 */
const WITHIN_SECTION_ORDER: Partial<Record<ReportSection, (doc: DocumentRow) => number>> = {
  // Appendix D: historical docs should go chronologically
  // Sanborn maps first, then aerials, then topos, then city directories
  appendix_d_historical: (doc) => {
    const typeOrder: Record<string, number> = {
      sanborn_map: 1,
      aerial_photograph: 2,
      topographic_map: 3,
      city_directory: 4,
      fire_insurance_map: 5,
    };
    return typeOrder[doc.document_type ?? ''] ?? 99;
  },
  // Appendix A: location map before plot plan
  appendix_a_maps: (doc) => {
    const typeOrder: Record<string, number> = {
      location_map: 1,
      plot_plan: 2,
    };
    return typeOrder[doc.document_type ?? ''] ?? 99;
  },
  // Appendix E: agency records roughly grouped
  appendix_e_agency_records: (doc) => {
    const typeOrder: Record<string, number> = {
      agency_records: 1,
      regulatory_correspondence: 2,
      prior_environmental_report: 3,
      title_record: 4,
      tax_record: 5,
      building_permit: 6,
      client_correspondence: 7,
    };
    return typeOrder[doc.document_type ?? ''] ?? 99;
  },
};

/**
 * Get the effective section for a document, respecting manual overrides.
 */
function getEffectiveSection(doc: DocumentRow): ReportSection {
  // Manual override takes priority
  if (doc.manual_override_section) {
    return doc.manual_override_section as ReportSection;
  }
  // AI-suggested section
  if (doc.suggested_section) {
    return doc.suggested_section as ReportSection;
  }
  // Fall back to default mapping from document type
  if (doc.document_type) {
    return DOCUMENT_TYPE_TO_DEFAULT_SECTION[doc.document_type as DocumentType] ?? 'appendix_i_additional';
  }
  return 'appendix_i_additional';
}

/**
 * Get the effective document type, respecting manual overrides.
 */
function getEffectiveType(doc: DocumentRow): DocumentType {
  if (doc.manual_override_type) {
    return doc.manual_override_type as DocumentType;
  }
  return (doc.document_type ?? 'other_unknown') as DocumentType;
}

/**
 * Check if a document should be excluded from the final report.
 */
function shouldExclude(doc: DocumentRow): boolean {
  // Explicitly excluded by user
  if (doc.included === 0) return true;

  const docType = getEffectiveType(doc);

  // Blank pages are excluded by default
  if (docType === 'blank_page') return true;

  // Existing appendix dividers are excluded (we generate fresh ones)
  if (docType === 'appendix_divider') return true;

  return false;
}

/**
 * Create the "organize" step executor function.
 */
export function createOrganizeExecutor(
  config: AppConfig,
  state: StateManager,
  esaTemplate: ESATemplate
): (ctx: PipelineContext) => Promise<StepResult> {
  return async (ctx: PipelineContext): Promise<StepResult> => {
    const startTime = Date.now();
    const projectId = ctx.project.id;
    const reportType = ctx.project.reportType;

    logger.info({ projectId, reportType }, 'Starting organization step');

    // Get the template for this report type
    const template = getReportTypeTemplate(esaTemplate, reportType);
    if (!template) {
      return {
        step: 'organize',
        success: false,
        durationMs: Date.now() - startTime,
        error: `No template found for report type: ${reportType}`,
      };
    }

    // Get all classified documents from state
    const documents = state.getDocuments(projectId);
    if (documents.length === 0) {
      return {
        step: 'organize',
        success: false,
        durationMs: Date.now() - startTime,
        error: 'No documents found for project',
      };
    }

    // Build section buckets
    const sectionBuckets: Map<ReportSection, DocumentRow[]> = new Map();
    let excludedCount = 0;

    for (const doc of documents) {
      if (shouldExclude(doc)) {
        excludedCount++;
        state.updateDocumentIncluded(doc.id, false);
        logger.debug({ docId: doc.id, filename: doc.filename }, 'Excluding document');
        continue;
      }

      const section = getEffectiveSection(doc);
      if (!sectionBuckets.has(section)) {
        sectionBuckets.set(section, []);
      }
      sectionBuckets.get(section)!.push(doc);
    }

    // Order documents within each section
    let globalOrderIndex = 0;
    const organizedBySection: Map<ReportSection, DocumentRow[]> = new Map();

    // Walk through sections in canonical order
    for (const section of ESAI_SECTION_ORDER) {
      const bucket = sectionBuckets.get(section);
      if (!bucket || bucket.length === 0) continue;

      // Apply within-section ordering
      const orderFn = WITHIN_SECTION_ORDER[section];
      if (orderFn) {
        bucket.sort((a, b) => orderFn(a) - orderFn(b));
      }

      // Assign order indices and store
      for (const doc of bucket) {
        const rationale = `Placed in ${section} based on ${
          doc.manual_override_section ? 'manual override' : 'AI classification'
        } (${getEffectiveType(doc)})`;

        state.updateDocumentAssignment(doc.id, section, globalOrderIndex, rationale);
        globalOrderIndex++;
      }

      organizedBySection.set(section, bucket);
    }

    // Also handle any sections not in ESAI_SECTION_ORDER (Phase II appendices, etc.)
    for (const [section, bucket] of sectionBuckets) {
      if (organizedBySection.has(section)) continue; // Already processed

      for (const doc of bucket) {
        const rationale = `Placed in ${section} (non-standard section) based on AI classification`;
        state.updateDocumentAssignment(doc.id, section, globalOrderIndex, rationale);
        globalOrderIndex++;
      }

      organizedBySection.set(section, bucket);
    }

    // Check for missing required sections
    const missingSections: string[] = [];
    for (const templateSection of template.sections) {
      if (templateSection.required) {
        const sectionId = mapTemplateSectionToReportSection(templateSection.id);
        if (sectionId && !organizedBySection.has(sectionId)) {
          // Check if this section should be generated (body sections)
          // vs. expected to be uploaded (appendix sections)
          if (sectionId.startsWith('appendix_')) {
            missingSections.push(`${templateSection.number} ${templateSection.title}`);
          }
          // Body sections will be generated later in the generate step
        }
      }
    }

    // Also check required appendices
    for (const appendix of template.appendices) {
      if (appendix.required) {
        const sectionId = `appendix_${appendix.letter.toLowerCase()}_${appendix.title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}` as ReportSection;
        // Check using our known appendix mapping
        const knownSection = mapAppendixLetterToSection(appendix.letter);
        if (knownSection && !organizedBySection.has(knownSection)) {
          missingSections.push(`Appendix ${appendix.letter}: ${appendix.title}`);
        }
      }
    }

    // Build pipeline context organized documents
    ctx.project.organizedDocuments = [];
    for (const [section, docs] of organizedBySection) {
      for (const doc of docs) {
        ctx.project.organizedDocuments.push({
          raw: {
            filename: doc.filename,
            localPath: doc.local_path,
            sizeBytes: doc.size_bytes,
            sha256: doc.sha256,
            downloadedAt: new Date(doc.created_at),
            projectId,
            pageCount: doc.page_count,
          },
          classification: {
            documentType: getEffectiveType(doc),
            confidence: doc.confidence ?? 0,
            reasoning: doc.reasoning ?? '',
            dateDetected: doc.date_detected,
            projectIdDetected: doc.project_id_detected,
            pageCount: doc.page_count,
            pageRange: { start: 1, end: doc.page_count },
            suggestedSection: section,
            needsManualReview: Boolean(doc.needs_manual_review),
            isSbaSpecific: false,
            metadata: doc.classification_metadata ? JSON.parse(doc.classification_metadata) : {},
          },
          included: true,
          assignment: {
            section,
            orderIndex: doc.order_index ?? 0,
            rationale: doc.assignment_rationale ?? '',
          },
        });
      }
    }

    // Build section breakdown for the step data
    const sectionBreakdown = Array.from(organizedBySection.entries()).map(([section, docs]) => ({
      section,
      title: getSectionTitle(section),
      documentCount: docs.length,
      totalPages: docs.reduce((sum, d) => sum + d.page_count, 0),
    }));

    const stepData: OrganizeStepData = {
      totalDocuments: documents.length - excludedCount,
      sectionsPopulated: organizedBySection.size,
      missingSections,
      excluded: excludedCount,
      sectionBreakdown,
    };

    // Notifications
    if (missingSections.length > 0) {
      state.addNotification(
        projectId,
        'warning',
        `Organization complete but ${missingSections.length} required sections are missing: ${missingSections.join(', ')}`
      );
    } else {
      state.addNotification(
        projectId,
        'info',
        `Organization complete: ${stepData.totalDocuments} documents across ${stepData.sectionsPopulated} sections.`
      );
    }

    logger.info(
      {
        projectId,
        totalDocs: stepData.totalDocuments,
        sections: stepData.sectionsPopulated,
        excluded: stepData.excluded,
        missing: missingSections,
      },
      'Organization step complete'
    );

    return {
      step: 'organize',
      success: true,
      durationMs: Date.now() - startTime,
      data: stepData,
    };
  };
}

// ── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Map a template section ID (e.g., "introduction", "property_description")
 * to the corresponding ReportSection type.
 */
function mapTemplateSectionToReportSection(templateSectionId: string): ReportSection | null {
  const mapping: Record<string, ReportSection> = {
    introduction: 'body_introduction',
    property_description: 'body_property_description',
    property_reconnaissance: 'body_property_reconnaissance',
    property_history: 'body_property_history',
    records_research: 'body_records_research',
    user_information: 'body_user_information',
    references: 'body_references',
    executive_summary: 'body_executive_summary',
    findings_recommendations: 'body_findings_recommendations',
    sba_requirements: 'body_sba_requirements',
  };
  return mapping[templateSectionId] ?? null;
}

function mapAppendixLetterToSection(letter: string): ReportSection | null {
  const mapping: Record<string, ReportSection> = {
    A: 'appendix_a_maps',
    B: 'appendix_b_photographs',
    C: 'appendix_c_database_report',
    D: 'appendix_d_historical',
    E: 'appendix_e_agency_records',
    F: 'appendix_f_qualifications',
    G: 'appendix_g_lab_results',
    H: 'appendix_h_boring_logs',
    I: 'appendix_i_additional',
  };
  return mapping[letter.toUpperCase()] ?? null;
}

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
