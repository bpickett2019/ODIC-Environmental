/**
 * Pipeline state and orchestration types.
 */

import type {
  ClassifiedDocument,
  OrganizedDocument,
  ReportManifest,
  QAResult,
  ReportType,
} from './documents.js';

/** Project processing status */
export type ProjectStatus =
  | 'new'              // Just detected on FTP
  | 'downloading'      // Files being downloaded
  | 'classifying'      // AI classifying documents
  | 'awaiting_triage'  // Classification done, waiting for Rose's review
  | 'organizing'       // AI organizing into report sections
  | 'assembling'       // Building the final PDF
  | 'qa_checking'      // Running QA validation
  | 'qa_failed'        // QA found critical issues
  | 'compressing'      // Compressing the final PDF
  | 'complete'         // All done, report ready
  | 'failed'           // Pipeline error
  | 'archived';        // Moved to archive

/** Priority levels */
export type Priority = 'rush' | 'normal' | 'low';

/** A project being processed through the pipeline */
export interface Project {
  /** Unique project identifier (from FTP folder name) */
  id: string;
  /** Human-readable project name */
  name: string;
  /** Client name */
  clientName: string;
  /** Property address */
  propertyAddress: string;
  /** Report type (ESAI, RSRA, DRV, ECA, ESAII, IAQ) */
  reportType: ReportType;
  /** Whether this is an SBA loan (affects front matter) */
  isSbaLoan: boolean;
  /** Current processing status */
  status: ProjectStatus;
  /** Priority level */
  priority: Priority;
  /** FTP path to the project folder */
  ftpPath: string;
  /** Local working directory */
  localPath: string;
  /** Raw files downloaded from FTP */
  fileCount: number;
  /** Classified documents (populated after classification) */
  classifiedDocuments: ClassifiedDocument[];
  /** Organized documents (populated after organization) */
  organizedDocuments: OrganizedDocument[];
  /** Report manifest (populated after assembly) */
  reportManifest: ReportManifest | null;
  /** QA results (populated after QA check) */
  qaResult: QAResult | null;
  /** Path to final output PDF */
  outputPdfPath: string | null;
  /** Path to final output DOCX (if exported) */
  outputDocxPath: string | null;
  /** Estimated API cost for this project */
  estimatedCostUsd: number;
  /** Error message if status is 'failed' */
  errorMessage: string | null;
  /** Timestamps */
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

/** Result from a single pipeline step */
export interface StepResult {
  /** Which step ran */
  step: PipelineStep;
  /** Whether it succeeded */
  success: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** Error if failed */
  error?: string;
  /** Any data the step produced */
  data?: any;
  /** Token usage for AI steps */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    costUsd: number;
  };
}

/** Pipeline steps in execution order */
export type PipelineStep =
  | 'download'
  | 'classify'
  | 'triage_review'  // Human-in-the-loop pause
  | 'organize'
  | 'generate_narrative'
  | 'generate_cover'
  | 'generate_toc'
  | 'assemble'
  | 'qa_check'
  | 'compress'
  | 'export_docx'
  | 'notify';

/** Pipeline execution context passed between steps */
export interface PipelineContext {
  project: Project;
  /** Results from completed steps */
  stepResults: Map<PipelineStep, StepResult>;
  /** Whether to halt on QA failure or continue with warnings */
  haltOnQAFailure: boolean;
  /** Whether Rose has approved the triage */
  triageApproved: boolean;
  /** Cancellation flag */
  cancelled: boolean;
}

/** API usage tracking for cost estimation */
export interface APIUsageRecord {
  projectId: string;
  step: PipelineStep;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: Date;
}

/** Dashboard-facing project summary */
export interface ProjectSummary {
  id: string;
  name: string;
  clientName: string;
  status: ProjectStatus;
  priority: Priority;
  fileCount: number;
  classifiedCount: number;
  needsReviewCount: number;
  qaScore: number | null;
  qaPassed: boolean | null;
  estimatedCostUsd: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dashboard notification */
export interface DashboardNotification {
  id: string;
  projectId: string;
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: Date;
  read: boolean;
}
