export const SectionCategory = {
  RELIANCE_LETTER: 'RELIANCE_LETTER',
  EO_INSURANCE: 'EO_INSURANCE',
  COVER_WRITEUP: 'COVER_WRITEUP',
  APPENDIX_A: 'APPENDIX_A',
  APPENDIX_B: 'APPENDIX_B',
  APPENDIX_C: 'APPENDIX_C',
  APPENDIX_D: 'APPENDIX_D',
  APPENDIX_E: 'APPENDIX_E',
  REPORTS_AFTER_E: 'REPORTS_AFTER_E',
  APPENDIX_F: 'APPENDIX_F',
  UNCLASSIFIED: 'UNCLASSIFIED',
} as const;

export type SectionCategory = (typeof SectionCategory)[keyof typeof SectionCategory];

export const SECTION_DISPLAY: Record<SectionCategory, string> = {
  [SectionCategory.RELIANCE_LETTER]: 'Reliance Letter',
  [SectionCategory.EO_INSURANCE]: 'E&O Insurance',
  [SectionCategory.COVER_WRITEUP]: 'Cover / Write-Up',
  [SectionCategory.APPENDIX_A]: 'APPENDIX A \u2013 Property Location Map & Plot Plan',
  [SectionCategory.APPENDIX_B]: 'APPENDIX B \u2013 Property & Vicinity Photographs',
  [SectionCategory.APPENDIX_C]: 'APPENDIX C \u2013 Database Report',
  [SectionCategory.APPENDIX_D]: 'APPENDIX D \u2013 Historical Records Research',
  [SectionCategory.APPENDIX_E]: 'APPENDIX E \u2013 Public Agency Records',
  [SectionCategory.REPORTS_AFTER_E]: 'Supporting Reports (after E)',
  [SectionCategory.APPENDIX_F]: 'APPENDIX F \u2013 Qualifications',
  [SectionCategory.UNCLASSIFIED]: 'Unclassified',
};

export const SECTION_SHORT: Record<SectionCategory, string> = {
  [SectionCategory.RELIANCE_LETTER]: 'Reliance Letter',
  [SectionCategory.EO_INSURANCE]: 'E&O Insurance',
  [SectionCategory.COVER_WRITEUP]: 'Cover / Write-Up',
  [SectionCategory.APPENDIX_A]: 'App. A \u2013 Maps & Plot Plan',
  [SectionCategory.APPENDIX_B]: 'App. B \u2013 Photographs',
  [SectionCategory.APPENDIX_C]: 'App. C \u2013 Database Report',
  [SectionCategory.APPENDIX_D]: 'App. D \u2013 Historical Records',
  [SectionCategory.APPENDIX_E]: 'App. E \u2013 Agency Records',
  [SectionCategory.REPORTS_AFTER_E]: 'Reports (after E)',
  [SectionCategory.APPENDIX_F]: 'App. F \u2013 Qualifications',
  [SectionCategory.UNCLASSIFIED]: 'Unclassified',
};

export const SECTION_ORDER: SectionCategory[] = [
  SectionCategory.RELIANCE_LETTER,
  SectionCategory.EO_INSURANCE,
  SectionCategory.COVER_WRITEUP,
  SectionCategory.APPENDIX_A,
  SectionCategory.APPENDIX_B,
  SectionCategory.APPENDIX_C,
  SectionCategory.APPENDIX_D,
  SectionCategory.APPENDIX_E,
  SectionCategory.REPORTS_AFTER_E,
  SectionCategory.APPENDIX_F,
  SectionCategory.UNCLASSIFIED,
];

export interface Document {
  id: number;
  report_id: number;
  original_filename: string;
  original_path: string | null;
  stored_filename: string;
  pdf_filename: string | null;
  file_size: number;
  page_count: number | null;
  category: SectionCategory;
  subcategory: string | null;
  confidence: number | null;
  reasoning: string | null;
  sort_order: number;
  status: string;
  is_included: boolean;
  has_docx_source: boolean;
  created_at: string;
}

export interface Report {
  id: number;
  name: string;
  address: string | null;
  project_number: string | null;
  has_reliance_letter: boolean;
  status: 'todo' | 'in_progress' | 'done';
  document_count: number;
  assembled_filename: string | null;
  assembled_size: number | null;
  compressed_size: number | null;
  pipeline_duration: number | null;
  created_at: string;
  updated_at: string;
}

export interface ManifestEntry {
  doc_id: number;
  filename: string;
  category: SectionCategory;
  subcategory: string | null;
  start_page: number;
  end_page: number;
  page_count: number;
}

export interface AssembleResult {
  status: string;
  total_pages: number;
  total_documents: number;
  file_size: number;
  file_size_display: string;
  compressed_size: number | null;
  compressed_size_display: string | null;
  section_pages: Record<string, number>;
  document_manifest: ManifestEntry[];
  errors: string[];
}

export interface CompressResult {
  original_size: number;
  original_size_display: string;
  compressed_size: number;
  compressed_size_display: string;
  reduction_pct: number;
}

export interface ChatAction {
  action: string;
  params: Record<string, unknown>;
}

export interface ChatMessage {
  id: number;
  report_id: number;
  role: 'user' | 'assistant';
  content: string;
  actions?: ChatAction[];
  results?: Record<string, unknown>[];
  created_at: string;
}

export interface ChatResponse {
  message: string;
  actions: ChatAction[];
  results: Record<string, unknown>[];
  needs_confirmation: boolean;
  affected_count: number;
}

export interface DocxRun {
  text: string;
  bold?: boolean | null;
  italic?: boolean | null;
}

export interface DocxParagraph {
  text: string;
  style?: string | null;
  runs: DocxRun[];
}

export interface DocxContentResponse {
  is_docx: boolean;
  paragraphs: DocxParagraph[];
}

export interface SplitPart {
  part_number: number;
  filename: string;
  start_page: number;
  end_page: number;
  page_count: number;
  file_size: number;
}

export interface SplitResult {
  parts: SplitPart[];
  total_parts: number;
}
