import axios from 'axios';
import type { Report, Document, AssembleResult, CompressResult, SectionCategory, ChatResponse, ChatMessage, SplitResult, DocxContentResponse, DocxParagraph } from '../types';

// Determine API URL based on environment
const getApiUrl = () => {
  const envUrl = import.meta.env.VITE_API_URL;
  
  // If explicit VITE_API_URL is set, use it
  if (envUrl && envUrl !== 'http://localhost:8000') {
    return `${envUrl}/api`;
  }
  
  // Local development: use /api proxy
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return '/api';
  }
  
  // Production: derive from current domain
  const protocol = window.location.protocol;
  const hostname = window.location.hostname;
  const port = window.location.port ? `:${window.location.port}` : '';
  return `${protocol}//${hostname}${port}/api`;
};

const api = axios.create({ baseURL: getApiUrl() });

// Reports
export const createReport = (data: {
  name: string;
  address?: string;
  project_number?: string;
  has_reliance_letter?: boolean;
}) => api.post<Report>('/reports', data).then(r => r.data);

export const listReports = () =>
  api.get<Report[]>('/reports').then(r => r.data);

export const getReport = (id: number) =>
  api.get<Report>(`/reports/${id}`).then(r => r.data);

export const updateReport = (id: number, data: Partial<Report>) =>
  api.put<Report>(`/reports/${id}`, data).then(r => r.data);

export const deleteReport = (id: number) =>
  api.delete(`/reports/${id}`).then(r => r.data);

// Documents
export const uploadFiles = (
  reportId: number,
  files: FileList | File[],
  onProgress?: (pct: number) => void,
) => {
  const formData = new FormData();
  Array.from(files).forEach(f => formData.append('files', f));
  return api.post(`/reports/${reportId}/upload`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 600000,
    onUploadProgress: (e) => {
      if (onProgress && e.total) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    },
  }).then(r => r.data);
};

export const uploadFolder = (reportId: number, folderPath: string) => {
  const formData = new FormData();
  formData.append('folder_path', folderPath);
  return api.post(`/reports/${reportId}/upload-folder`, formData, {
    timeout: 600000,
  }).then(r => r.data);
};

export const classifyDocuments = (reportId: number) =>
  api.post(`/reports/${reportId}/classify`, {}, { timeout: 600000 }).then(r => r.data);

export const listDocuments = (reportId: number) =>
  api.get<Document[]>(`/reports/${reportId}/documents`).then(r => r.data);

export const updateDocument = (reportId: number, docId: number, data: {
  category?: SectionCategory;
  subcategory?: string;
  sort_order?: number;
  is_included?: boolean;
}) => api.put<Document>(`/reports/${reportId}/documents/${docId}`, data).then(r => r.data);

export const deleteDocument = (reportId: number, docId: number) =>
  api.delete(`/reports/${reportId}/documents/${docId}`).then(r => r.data);

export const reorderDocuments = (reportId: number, data: {
  document_ids: number[];
  category: SectionCategory;
}) => api.put(`/reports/${reportId}/reorder`, data).then(r => r.data);

export const getDocumentPreviewUrl = (reportId: number, docId: number) =>
  `/api/reports/${reportId}/documents/${docId}/preview`;

// Pre-flight check
export interface PreflightResult {
  can_assemble: boolean;
  warnings: string[];
  errors: string[];
  stats: {
    total_pages: number;
    total_docs: number;
    sections_filled: number;
    sections_empty: number;
  };
}

export const preflightCheck = (reportId: number) =>
  api.get<PreflightResult>(`/reports/${reportId}/preflight`).then(r => r.data);

// Assembly
export const assembleReport = (reportId: number, compression?: string) =>
  api.post<AssembleResult>(`/reports/${reportId}/assemble`, { compression }, {
    timeout: 600000,
  }).then(r => r.data);

export const getReportPreviewUrl = (reportId: number) =>
  `/api/reports/${reportId}/preview`;

export const getAssembledPageUrl = (reportId: number, pageNum: number, width = 1600) =>
  `/api/reports/${reportId}/assembled/page/${pageNum}?width=${width}`;

export const getReportDownloadUrl = (reportId: number, compressed = false) =>
  `/api/reports/${reportId}/download?compressed=${compressed}`;

// Auto-naming
export interface AutoNameResult {
  status: string;
  updated?: Record<string, string>;
  extracted?: { project_number?: string; address?: string; name?: string };
  reason?: string;
}

export const autoNameReport = (reportId: number) =>
  api.post<AutoNameResult>(`/reports/${reportId}/auto-name`, {}, { timeout: 60000 }).then(r => r.data);

// Processing status (background conversion polling)
export interface ProcessingStatus {
  total: number;
  pending: number;
  ready: number;
  errors: number;
  complete: boolean;
}

export const getProcessingStatus = (reportId: number) =>
  api.get<ProcessingStatus>(`/reports/${reportId}/processing-status`).then(r => r.data);

/**
 * Poll processing-status until all background conversion is done.
 * Calls onProgress with each status update for UI feedback.
 * Returns final status when complete.
 */
export async function waitForProcessing(
  reportId: number,
  onProgress?: (status: ProcessingStatus) => void,
  intervalMs = 500,
  maxWaitMs = 300000,
): Promise<ProcessingStatus> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = await getProcessingStatus(reportId);
    onProgress?.(status);
    if (status.complete) return status;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  // Timeout — return last status
  return getProcessingStatus(reportId);
}

// Reprocess errors
export interface ReprocessResult {
  fixed: number;
  remaining_errors: number;
}

export const reprocessErrors = (reportId: number) =>
  api.post<ReprocessResult>(`/reports/${reportId}/reprocess-errors`, {}, { timeout: 600000 }).then(r => r.data);

// Director
export interface DirectorResult {
  health: string;
  estimated_pages?: number;
  section_flags?: Array<{ section: string; issue: string; severity: string }>;
  exclude_count?: number;
  reclassify_count?: number;
  exclude_recommendations?: Array<{ doc_id: number; filename: string; reason: string }>;
  reclassify_recommendations?: Array<{ doc_id: number; filename: string; current: string; suggested: string; reason: string }>;
  flagged?: number;
  skipped?: boolean;
  error?: string;
}

export interface ApplyDirectorResult {
  excluded: number;
  remaining_docs: number;
  remaining_pages: number;
}

export const runDirector = (reportId: number) =>
  api.post<DirectorResult>(`/reports/${reportId}/director`, {}, { timeout: 120000 }).then(r => r.data);

export const applyDirectorRecommendations = (reportId: number) =>
  api.post<ApplyDirectorResult>(`/reports/${reportId}/apply-director`, {}).then(r => r.data);

export const compressReport = (reportId: number, quality: string, targetSizeMb?: number) =>
  api.post<CompressResult>(`/reports/${reportId}/compress`, {
    quality,
    target_size_mb: targetSizeMb,
  }).then(r => r.data);

// ---- SSE streaming helpers ----

export interface SSEProgressEvent {
  phase: string;
  current?: number;
  total?: number;
  filename?: string;
  category?: string;
  confidence?: number | null;
  reasoning?: string;
  status?: string;
  excluded?: boolean;
  // complete event fields
  uploaded?: number;
  errors?: number;
  classified?: number;
  // director fields
  director_health?: string;
  director_exclude_count?: number;
  director_estimated_pages?: number;
}

/**
 * Consume a POST-based SSE stream. Calls onEvent for each parsed SSE event.
 * Returns when the stream ends or on error.
 */
export async function consumeSSEStream(
  url: string,
  body: FormData | Record<string, unknown>,
  onEvent: (eventType: string, data: SSEProgressEvent) => void,
): Promise<void> {
  const isFormData = body instanceof FormData;
  const response = await fetch(url, {
    method: 'POST',
    body: isFormData ? body : JSON.stringify(body),
    headers: isFormData ? {} : { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Stream request failed: ${response.status}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    let currentEvent = 'message';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const dataStr = line.slice(5).trim();
        if (dataStr) {
          try {
            const data = JSON.parse(dataStr) as SSEProgressEvent;
            onEvent(currentEvent, data);
          } catch {
            // Skip malformed JSON
          }
        }
        currentEvent = 'message'; // Reset after data line
      }
    }
  }
}

export function uploadFolderStreamUrl(reportId: number) {
  return `/api/reports/${reportId}/upload-folder-stream`;
}

export function classifyStreamUrl(reportId: number) {
  return `/api/reports/${reportId}/classify-stream`;
}

// Chat / Command Bar
export const sendChatMessage = (reportId: number, message: string, history: { role: string; content: string }[] = []) =>
  api.post<ChatResponse>(`/reports/${reportId}/chat`, { message, history }, { timeout: 120000 }).then(r => r.data);

export const undoChatAction = (reportId: number) =>
  api.post<{ status: string; restored: number }>(`/reports/${reportId}/undo`).then(r => r.data);

export const getChatHistory = (reportId: number) =>
  api.get<ChatMessage[]>(`/reports/${reportId}/chat-history`).then(r => r.data);

export const getChatSuggestions = (reportId: number) =>
  api.get<{ suggestions: string[] }>(`/reports/${reportId}/suggestions`).then(r => r.data);

// Batch operations
export const batchUpdateDocuments = (reportId: number, data: {
  document_ids: number[];
  category?: SectionCategory;
  is_included?: boolean;
}) => api.put<{ updated: number }>(`/reports/${reportId}/documents/batch`, data).then(r => r.data);

// Split for email
export const splitReport = (reportId: number, maxSizeMb = 20) =>
  api.post<SplitResult>(`/reports/${reportId}/split`, null, { params: { max_size_mb: maxSizeMb } }).then(r => r.data);

export const getSplitPartUrl = (reportId: number, partNum: number) =>
  `/api/reports/${reportId}/split/${partNum}`;

// Text editing
export const textReplace = (reportId: number, docId: number, find: string, replace: string) =>
  api.post(`/reports/${reportId}/documents/${docId}/text-replace`, { find, replace }, { timeout: 120000 }).then(r => r.data);

export const deletePages = (reportId: number, docId: number, pages: number[]) =>
  api.post(`/reports/${reportId}/documents/${docId}/delete-pages`, { pages }).then(r => r.data);

// DOCX inline editing
export const getDocxContent = (reportId: number, docId: number) =>
  api.get<DocxContentResponse>(`/reports/${reportId}/documents/${docId}/docx-content`).then(r => r.data);

export const saveDocxContent = (reportId: number, docId: number, paragraphs: DocxParagraph[]) =>
  api.put(`/reports/${reportId}/documents/${docId}/docx-content`, { paragraphs }, { timeout: 120000 }).then(r => r.data);

// Auto-split download (single PDF or zip of parts)
export const getAutoDownloadUrl = (reportId: number) =>
  `/api/reports/${reportId}/download-auto`;
