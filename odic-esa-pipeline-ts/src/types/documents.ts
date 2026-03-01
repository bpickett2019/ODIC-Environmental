/**
 * Document and classification types for the ODIC ESA Pipeline.
 *
 * Updated to match the real ODIC Environmental report structure
 * as reverse-engineered from reference reports 6384578 and 6384642.
 */

// ─── Report Types ──────────────────────────────────────────────────────────────

/** All report types ODIC produces */
export type ReportType =
  | 'ESAI'    // Phase I Environmental Site Assessment
  | 'ESAII'   // Phase II Environmental Site Assessment
  | 'RSRA'    // Regulatory Search / Radius Analysis
  | 'DRV'     // Database Radius Verification
  | 'ECA'     // Environmental Compliance Audit
  | 'IAQ'     // Indoor Air Quality
  | 'PHASE2'; // Alias for ESAII used in some workflows

/** Human-readable report type labels */
export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  ESAI: 'Phase I Environmental Site Assessment',
  ESAII: 'Phase II Environmental Site Assessment',
  RSRA: 'Regulatory Search / Radius Analysis',
  DRV: 'Database Radius Verification',
  ECA: 'Environmental Compliance Audit',
  IAQ: 'Indoor Air Quality',
  PHASE2: 'Phase II Environmental Site Assessment',
};

// ─── Document Types ────────────────────────────────────────────────────────────

/** All recognized document types the classifier can return */
export type DocumentType =
  // Front matter
  | 'cover_page'
  | 'transmittal_letter'
  | 'reliance_letter'
  | 'insurance_certificate'
  | 'ep_declaration'
  // Report body (when provided as source document or needing reorganization)
  | 'report_body'
  | 'executive_summary'
  | 'findings_recommendations'
  // Appendix content
  | 'location_map'
  | 'plot_plan'
  | 'site_photograph'
  | 'edr_report'
  | 'sanborn_map'
  | 'aerial_photograph'
  | 'topographic_map'
  | 'city_directory'
  | 'fire_insurance_map'
  | 'agency_records'
  | 'ep_qualifications'
  // Supplemental documents
  | 'title_record'
  | 'tax_record'
  | 'building_permit'
  | 'prior_environmental_report'
  | 'client_correspondence'
  | 'lab_result'
  | 'boring_log'
  | 'regulatory_correspondence'
  | 'supporting_document'
  // Structural
  | 'appendix_divider'
  | 'blank_page'
  | 'other_unknown';

/** Human-readable labels for document types */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  cover_page: 'Cover Page',
  transmittal_letter: 'Transmittal Letter',
  reliance_letter: 'Reliance Letter (SBA)',
  insurance_certificate: 'E&O Insurance Certificate',
  ep_declaration: 'EP Declaration',
  report_body: 'Report Body',
  executive_summary: 'Executive Summary',
  findings_recommendations: 'Findings & Recommendations',
  location_map: 'Location Map (Figure 1)',
  plot_plan: 'Plot Plan (Figure 2)',
  site_photograph: 'Site Photograph',
  edr_report: 'EDR Radius Map Report',
  sanborn_map: 'Sanborn Fire Insurance Map',
  aerial_photograph: 'Aerial Photograph',
  topographic_map: 'Topographic Map',
  city_directory: 'City Directory',
  fire_insurance_map: 'Fire Insurance Map (Non-Sanborn)',
  agency_records: 'Public Agency Records',
  ep_qualifications: 'EP Qualifications / Resume',
  title_record: 'Title Record',
  tax_record: 'Tax Record',
  building_permit: 'Building Permit',
  prior_environmental_report: 'Prior Environmental Report',
  client_correspondence: 'Client Correspondence',
  lab_result: 'Laboratory Results',
  boring_log: 'Boring Log / Well Log',
  regulatory_correspondence: 'Regulatory Correspondence',
  supporting_document: 'Supporting Document',
  appendix_divider: 'Appendix Divider Page',
  blank_page: 'Blank Page',
  other_unknown: 'Other / Unknown',
};

// ─── Report Sections ───────────────────────────────────────────────────────────

/**
 * Report sections — these are the slots in the final assembled report.
 * The assembly engine uses these to order content.
 *
 * Based on actual ODIC report structure from reference report 6384642:
 *   Cover → Transmittal → [Reliance] → Insurance → [EP Declaration]
 *   → TOC → Exec Summary → Findings → Body (1.0-7.0)
 *   → App A (Maps) → App B (Photos) → App C (EDR)
 *   → App D (Historical) → App E (Agency Records) → App F (EP Quals)
 */
export type ReportSection =
  // Front matter
  | 'front_cover'
  | 'front_transmittal'
  | 'front_reliance'
  | 'front_insurance'
  | 'front_ep_declaration'
  | 'front_toc'
  // Report body
  | 'body_executive_summary'
  | 'body_findings_recommendations'
  | 'body_introduction'            // 1.0
  | 'body_property_description'    // 2.0
  | 'body_property_reconnaissance' // 3.0
  | 'body_property_history'        // 4.0
  | 'body_records_research'        // 5.0
  | 'body_user_information'        // 6.0
  | 'body_references'              // 7.0
  // SBA-specific (only for SBA loan reports)
  | 'body_sba_requirements'
  // Appendices
  | 'appendix_a_maps'             // Location Map & Plot Plan
  | 'appendix_b_photographs'      // Property & Vicinity Photos
  | 'appendix_c_database_report'  // EDR Radius Map Report
  | 'appendix_d_historical'       // Sanborn, Aerials, Topos, Directories
  | 'appendix_e_agency_records'   // Public Agency Records / FOIA
  | 'appendix_f_qualifications'   // EP Qualifications
  // Extra appendices for Phase II / IAQ
  | 'appendix_g_lab_results'
  | 'appendix_h_boring_logs'
  | 'appendix_i_additional';

/** Mapping from document type to default report section (for ESAI) */
export const DOCUMENT_TYPE_TO_DEFAULT_SECTION: Record<DocumentType, ReportSection> = {
  cover_page: 'front_cover',
  transmittal_letter: 'appendix_i_additional',
  reliance_letter: 'front_reliance',
  insurance_certificate: 'front_insurance',
  ep_declaration: 'appendix_f_qualifications',
  report_body: 'body_introduction',
  executive_summary: 'body_executive_summary',
  findings_recommendations: 'body_findings_recommendations',
  location_map: 'appendix_a_maps',
  plot_plan: 'appendix_a_maps',
  site_photograph: 'appendix_b_photographs',
  edr_report: 'appendix_c_database_report',
  sanborn_map: 'appendix_d_historical',
  aerial_photograph: 'appendix_d_historical',
  topographic_map: 'appendix_d_historical',
  city_directory: 'appendix_d_historical',
  fire_insurance_map: 'appendix_d_historical',
  agency_records: 'appendix_e_agency_records',
  ep_qualifications: 'appendix_f_qualifications',
  title_record: 'appendix_e_agency_records',
  tax_record: 'appendix_e_agency_records',
  building_permit: 'appendix_e_agency_records',
  prior_environmental_report: 'appendix_i_additional',
  client_correspondence: 'appendix_e_agency_records',
  lab_result: 'appendix_g_lab_results',
  boring_log: 'appendix_h_boring_logs',
  regulatory_correspondence: 'appendix_e_agency_records',
  supporting_document: 'appendix_i_additional',
  appendix_divider: 'appendix_a_maps',
  blank_page: 'appendix_i_additional',
  other_unknown: 'appendix_i_additional',
};

// ─── Section Ordering ──────────────────────────────────────────────────────────

/**
 * Canonical section order for a Phase I ESA report.
 * This defines the exact page order in the final assembled PDF.
 */
export const ESAI_SECTION_ORDER: ReportSection[] = [
  // Front matter (Rose's order: [Reliance] → E&O → Cover)
  'front_reliance',
  'front_insurance',
  'front_cover',
  // Report body (write-up)
  'body_introduction',
  'body_executive_summary',
  'body_findings_recommendations',
  'body_property_description',
  'body_property_reconnaissance',
  'body_property_history',
  'body_records_research',
  'body_user_information',
  'body_references',
  'body_sba_requirements',
  // Appendices A–E
  'appendix_a_maps',
  'appendix_b_photographs',
  'appendix_c_database_report',
  'appendix_d_historical',
  'appendix_e_agency_records',
  // Reports/Additional (after E, before F)
  'appendix_i_additional',
  // Appendix F — EP Qualifications
  'appendix_f_qualifications',
];

// ─── Document Interfaces ───────────────────────────────────────────────────────

/** Raw file info before any processing */
export interface RawDocument {
  /** Original filename on FTP */
  filename: string;
  /** Local file path after download */
  localPath: string;
  /** File size in bytes */
  sizeBytes: number;
  /** SHA-256 hash for dedup */
  sha256: string;
  /** When we downloaded it */
  downloadedAt: Date;
  /** Project ID this belongs to */
  projectId: string;
  /** Total pages in this PDF */
  pageCount: number;
}

/** Result of AI classification for a single document or page range */
export interface ClassificationResult {
  /** The AI-determined document type */
  documentType: DocumentType;
  /** Confidence score 0-1 */
  confidence: number;
  /** AI's reasoning for the classification */
  reasoning: string;
  /** Date detected within the document (if any) */
  dateDetected: string | null;
  /** Project ID detected within the document (for cross-contamination checks) */
  projectIdDetected: string | null;
  /** Total page count of the classified segment */
  pageCount: number;
  /** Page range in the source PDF (1-indexed, inclusive) */
  pageRange: { start: number; end: number };
  /** AI's suggested report section */
  suggestedSection: ReportSection;
  /** Whether this needs manual review (low confidence or anomalies) */
  needsManualReview: boolean;
  /** Whether this is an SBA-specific document */
  isSbaSpecific: boolean;
  /** Additional metadata the AI extracted */
  metadata: Record<string, string>;
}

/** A document (or page range) after classification */
export interface ClassifiedDocument {
  /** The raw document info */
  raw: RawDocument;
  /** AI classification result */
  classification: ClassificationResult;
  /** Rose's override classification (if she changed it) */
  manualOverride?: {
    documentType: DocumentType;
    section: ReportSection;
    overriddenBy: string;
    overriddenAt: Date;
  };
  /** Whether to include in the final report */
  included: boolean;
}

/** Section assignment from the organizer */
export interface SectionAssignment {
  /** The report section this document belongs to */
  section: ReportSection;
  /** Order within that section (0-based) */
  orderIndex: number;
  /** Rationale for this placement */
  rationale: string;
}

/** A document after organization (section assigned, ordered) */
export interface OrganizedDocument extends ClassifiedDocument {
  /** Where in the report this document goes */
  assignment: SectionAssignment;
}

/** Represents a generated page (cover, TOC, dividers, etc.) */
export interface GeneratedPage {
  /** What kind of generated content */
  type:
    | 'cover_page'
    | 'transmittal_letter'
    | 'reliance_letter'
    | 'table_of_contents'
    | 'executive_summary'
    | 'findings_recommendations'
    | 'appendix_divider'
    | 'ep_declaration';
  /** The section it belongs to */
  section: ReportSection;
  /** PDF bytes */
  pdfBuffer: Buffer;
  /** Page count of this generated content */
  pageCount: number;
  /** Label for the appendix divider (e.g., "APPENDIX A") */
  label?: string;
}

/** The full report manifest after assembly */
export interface ReportManifest {
  projectId: string;
  /** Report type */
  reportType: ReportType;
  /** All sections in order */
  sections: ReportSectionManifest[];
  /** Total page count */
  totalPages: number;
  /** Pages from source documents */
  sourcePages: number;
  /** Pages generated by AI */
  generatedPages: number;
  /** Final PDF path */
  outputPdfPath: string;
  /** Final DOCX path (if exported) */
  outputDocxPath: string | null;
  /** Assembly timestamp */
  assembledAt: Date;
}

export interface ReportSectionManifest {
  section: ReportSection;
  /** Human-readable section title */
  title: string;
  /** Section number (e.g., "1.0", "Appendix C") */
  sectionNumber: string;
  /** Starting page in the final report */
  startPage: number;
  /** Documents in this section, in order */
  documents: Array<{
    filename: string;
    pageCount: number;
    pageRange?: { start: number; end: number };
    isGenerated: boolean;
  }>;
  /** Total pages in this section */
  totalPages: number;
}

/** QA check result */
export interface QAResult {
  /** Overall pass/fail */
  passed: boolean;
  /** Score 0-1 */
  score: number;
  /** Critical issues that must be fixed */
  criticalIssues: string[];
  /** Non-critical warnings */
  warnings: string[];
  /** Suggestions for improvement */
  suggestions: string[];
  /** Documents that appear to be from wrong project */
  crossContamination: string[];
  /** Required sections that are missing */
  missingSections: string[];
  /** Page count verification */
  pageCountVerification: {
    inputPages: number;
    outputPages: number;
    generatedPages: number;
    match: boolean;
  };
  /** Timestamp of QA check */
  checkedAt: Date;
}
