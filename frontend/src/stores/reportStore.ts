import { create } from 'zustand';
import type { Report, Document, SectionCategory, AssembleResult, CompressResult } from '../types';
import * as api from '../api/client';
import { consumeSSEStream, uploadFolderStreamUrl, classifyStreamUrl, type SSEProgressEvent } from '../api/client';

export interface OperationProgress {
  phase: string;       // "scanning" | "processing" | "processed" | "classifying" | "classified" | "complete"
  current: number;
  total: number;
  filename?: string;
  detail?: string;     // e.g. "→ APPENDIX_B (90%)"
}

export interface ProgressLogEntry {
  filename: string;
  detail: string;
  reasoning?: string;
  status: 'ok' | 'error' | 'excluded' | 'classifying';
  timestamp: number;
}

interface ReportStore {
  // State
  reports: Report[];
  currentReport: Report | null;
  documents: Document[];
  selectedDocId: number | null;
  loading: boolean;
  error: string | null;
  assembleResult: AssembleResult | null;
  compressResult: CompressResult | null;

  // Pipeline state
  pipelineRunning: boolean;
  pipelinePhase: 'idle' | 'uploading' | 'converting' | 'classifying' | 'validating' | 'directing' | 'assembling';

  // Director results
  directorHealth: string | null;
  directorExcludeCount: number;
  directorEstimatedPages: number | null;

  // Report actions
  fetchReports: () => Promise<void>;
  createReport: (data: { name: string; address?: string; project_number?: string; has_reliance_letter?: boolean }) => Promise<Report>;
  selectReport: (id: number) => Promise<void>;
  updateReport: (id: number, data: Partial<Report>) => Promise<void>;
  deleteReport: (id: number) => Promise<void>;

  // Document actions
  fetchDocuments: (reportId: number) => Promise<void>;
  uploadFiles: (reportId: number, files: FileList | File[]) => Promise<void>;
  uploadFolder: (reportId: number, folderPath: string) => Promise<void>;
  classifyDocuments: (reportId: number) => Promise<void>;
  updateDocument: (reportId: number, docId: number, data: { category?: SectionCategory; subcategory?: string; sort_order?: number; is_included?: boolean }) => Promise<void>;
  deleteDocument: (reportId: number, docId: number) => Promise<void>;
  reorderDocuments: (reportId: number, docIds: number[], category: SectionCategory) => Promise<void>;
  selectDocument: (docId: number | null) => void;

  // Auto-naming
  autoNameReport: (reportId: number) => Promise<void>;

  // Reprocess errors
  reprocessErrors: (reportId: number) => Promise<{ fixed: number; remaining_errors: number }>;

  // Assembly actions
  assembleReport: (reportId: number, compression?: string) => Promise<void>;
  compressReport: (reportId: number, quality: string, targetSizeMb?: number) => Promise<void>;

  // Upload progress
  uploadProgress: number | null;  // 0-100 or null when not uploading

  // SSE streaming progress
  operationProgress: OperationProgress | null;
  progressLog: ProgressLogEntry[];

  // Streaming actions
  uploadFolderStream: (reportId: number, folderPath: string) => Promise<void>;
  classifyDocumentsStream: (reportId: number) => Promise<void>;
  clearProgress: () => void;

  // Director
  applyDirectorRecommendations: (reportId: number) => Promise<void>;

  // Full pipeline: upload → classify → assemble (automatic)
  runFullPipeline: (reportId: number, method: 'files' | 'folder', payload: FileList | File[] | string) => Promise<void>;

  // UI
  clearError: () => void;

  // Chat state
  chatHistory: { role: string; content: string }[];
  chatLoading: boolean;
  lastChatResponse: string | null;

  // Selection state
  selectedDocIds: Set<number>;
  toggleSelectDoc: (docId: number) => void;
  selectRange: (fromId: number, toId: number) => void;
  selectAllInSection: (docIds: number[]) => void;
  deselectAllInSection: (docIds: number[]) => void;
  clearSelection: () => void;

  // Search state
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

export const useReportStore = create<ReportStore>((set, _get) => ({
  reports: [],
  currentReport: null,
  documents: [],
  selectedDocId: null,
  loading: false,
  error: null,
  assembleResult: null,
  compressResult: null,
  pipelineRunning: false,
  pipelinePhase: 'idle',
  directorHealth: null,
  directorExcludeCount: 0,
  directorEstimatedPages: null,
  uploadProgress: null,
  operationProgress: null,
  progressLog: [],
  chatHistory: [],
  chatLoading: false,
  lastChatResponse: null,
  selectedDocIds: new Set(),
  searchQuery: '',

  fetchReports: async () => {
    set({ loading: true, error: null });
    try {
      const reports = await api.listReports();
      set({ reports, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  createReport: async (data) => {
    set({ loading: true, error: null });
    try {
      const report = await api.createReport(data);
      set(s => ({ reports: [report, ...s.reports], loading: false }));
      return report;
    } catch (e: any) {
      set({ error: e.message, loading: false });
      throw e;
    }
  },

  selectReport: async (id) => {
    set({ loading: true, error: null, assembleResult: null, compressResult: null });
    try {
      const report = await api.getReport(id);
      const documents = await api.listDocuments(id);
      set({ currentReport: report, documents, loading: false, selectedDocId: null });

      // Auto-assemble if report has classified docs but no assembled PDF
      const hasClassifiedDocs = documents.some(
        (d: any) => d.is_included && d.category !== 'UNCLASSIFIED' &&
        (d.status === 'ready' || d.status === 'classified')
      );
      if (!report.assembled_filename && hasClassifiedDocs) {
        set({ pipelineRunning: true, pipelinePhase: 'assembling' });
        try {
          const result = await api.assembleReport(id);
          const updatedReport = await api.getReport(id);
          set({
            assembleResult: result,
            currentReport: updatedReport,
            pipelineRunning: false,
            pipelinePhase: 'idle',
          });
        } catch {
          set({ pipelineRunning: false, pipelinePhase: 'idle' });
        }
      }
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  updateReport: async (id, data) => {
    try {
      const report = await api.updateReport(id, data);
      set(s => ({
        currentReport: s.currentReport?.id === id ? report : s.currentReport,
        reports: s.reports.map(r => r.id === id ? report : r),
      }));
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  deleteReport: async (id) => {
    try {
      await api.deleteReport(id);
      set(s => ({
        reports: s.reports.filter(r => r.id !== id),
        currentReport: s.currentReport?.id === id ? null : s.currentReport,
        documents: s.currentReport?.id === id ? [] : s.documents,
      }));
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  fetchDocuments: async (reportId) => {
    try {
      const documents = await api.listDocuments(reportId);
      set({ documents });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  uploadFiles: async (reportId, files) => {
    set({ loading: true, error: null, uploadProgress: 0 });
    try {
      await api.uploadFiles(reportId, files, (pct) => set({ uploadProgress: pct }));
      const documents = await api.listDocuments(reportId);
      const report = await api.getReport(reportId);
      set({ documents, currentReport: report, loading: false, uploadProgress: null });
    } catch (e: any) {
      set({ error: e.message, loading: false, uploadProgress: null });
    }
  },

  uploadFolder: async (reportId, folderPath) => {
    set({ loading: true, error: null });
    try {
      await api.uploadFolder(reportId, folderPath);
      const documents = await api.listDocuments(reportId);
      const report = await api.getReport(reportId);
      set({ documents, currentReport: report, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  classifyDocuments: async (reportId) => {
    set({ loading: true, error: null });
    try {
      await api.classifyDocuments(reportId);
      const documents = await api.listDocuments(reportId);
      set({ documents, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  updateDocument: async (reportId, docId, data) => {
    try {
      const doc = await api.updateDocument(reportId, docId, data);
      set(s => ({
        documents: s.documents.map(d => d.id === docId ? doc : d),
      }));
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  deleteDocument: async (reportId, docId) => {
    try {
      await api.deleteDocument(reportId, docId);
      set(s => ({
        documents: s.documents.filter(d => d.id !== docId),
        selectedDocId: s.selectedDocId === docId ? null : s.selectedDocId,
      }));
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  reorderDocuments: async (reportId, docIds, category) => {
    try {
      await api.reorderDocuments(reportId, { document_ids: docIds, category });
      const documents = await api.listDocuments(reportId);
      set({ documents });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  selectDocument: (docId) => set({ selectedDocId: docId }),

  autoNameReport: async (reportId) => {
    try {
      const result = await api.autoNameReport(reportId);
      if (result.status === 'ok' && result.updated && Object.keys(result.updated).length > 0) {
        // Refresh report to pick up the new name/address/project_number
        const report = await api.getReport(reportId);
        set(s => ({
          currentReport: s.currentReport?.id === reportId ? report : s.currentReport,
          reports: s.reports.map(r => r.id === reportId ? report : r),
        }));
      }
    } catch (e: any) {
      // Non-critical — don't set error, just log
      console.warn('Auto-name failed:', e.message);
    }
  },

  reprocessErrors: async (reportId) => {
    set({ loading: true, error: null });
    try {
      const result = await api.reprocessErrors(reportId);
      const documents = await api.listDocuments(reportId);
      set({ documents, loading: false });
      return result;
    } catch (e: any) {
      set({ error: e.message, loading: false });
      throw e;
    }
  },

  assembleReport: async (reportId, compression) => {
    set({ loading: true, error: null, assembleResult: null });
    try {
      const result = await api.assembleReport(reportId, compression);
      const report = await api.getReport(reportId);
      set({ assembleResult: result, currentReport: report, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  compressReport: async (reportId, quality, targetSizeMb) => {
    set({ loading: true, error: null, compressResult: null });
    try {
      const result = await api.compressReport(reportId, quality, targetSizeMb);
      const report = await api.getReport(reportId);
      set({ compressResult: result, currentReport: report, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  uploadFolderStream: async (reportId, folderPath) => {
    set({ loading: true, error: null, operationProgress: null, progressLog: [] });
    try {
      const formData = new FormData();
      formData.append('folder_path', folderPath);

      await consumeSSEStream(
        uploadFolderStreamUrl(reportId),
        formData,
        (eventType: string, data: SSEProgressEvent) => {
          if (eventType === 'progress') {
            const progress: OperationProgress = {
              phase: data.phase || 'processing',
              current: data.current || 0,
              total: data.total || 0,
              filename: data.filename,
            };

            if (data.phase === 'processed' && data.filename) {
              const logEntry: ProgressLogEntry = {
                filename: data.filename,
                detail: data.excluded ? 'excluded' : data.status === 'error' ? 'error' : 'converted',
                reasoning: data.reasoning || undefined,
                status: data.excluded ? 'excluded' : data.status === 'error' ? 'error' : 'ok',
                timestamp: Date.now(),
              };
              set(s => ({
                operationProgress: progress,
                progressLog: [...s.progressLog, logEntry],
              }));
              return;
            }

            // Classification phases within the upload stream
            if (data.phase === 'classifying') {
              set(s => ({
                operationProgress: progress,
                progressLog: s.operationProgress?.phase !== 'classifying'
                  && s.operationProgress?.phase !== 'classified' ? [] : s.progressLog,
              }));
              return;
            }

            if (data.phase === 'classified' && data.filename) {
              const catShort = data.category
                ? data.category.replace(/_/g, ' ')
                : 'unclassified';
              const confPct = data.confidence != null
                ? `${Math.round(data.confidence * 100)}%`
                : '';
              progress.detail = `→ ${catShort}${confPct ? ` (${confPct})` : ''}`;

              const logEntry: ProgressLogEntry = {
                filename: data.filename,
                detail: progress.detail,
                reasoning: data.reasoning || undefined,
                status: 'ok',
                timestamp: Date.now(),
              };
              set(s => ({
                operationProgress: progress,
                progressLog: [...s.progressLog, logEntry],
              }));
              return;
            }

            if (data.phase === 'validating') {
              set({ operationProgress: progress });
              return;
            }

            if (data.phase === 'directing') {
              set({ operationProgress: progress });
              return;
            }

            set({ operationProgress: progress });
          } else if (eventType === 'complete') {
            set(s => ({
              operationProgress: {
                phase: 'complete',
                current: data.uploaded || s.operationProgress?.total || 0,
                total: data.total || s.operationProgress?.total || 0,
                detail: data.errors ? `${data.errors} errors` : undefined,
              },
              directorHealth: data.director_health || null,
              directorExcludeCount: data.director_exclude_count || 0,
              directorEstimatedPages: data.director_estimated_pages || null,
            }));
          }
        },
      );

      // Refresh data after stream completes
      const documents = await api.listDocuments(reportId);
      const report = await api.getReport(reportId);
      set({ documents, currentReport: report, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false, operationProgress: null });
    }
  },

  classifyDocumentsStream: async (reportId) => {
    set({ loading: true, error: null, operationProgress: null, progressLog: [] });
    try {
      await consumeSSEStream(
        classifyStreamUrl(reportId),
        {},
        (eventType: string, data: SSEProgressEvent) => {
          if (eventType === 'progress') {
            const progress: OperationProgress = {
              phase: data.phase || 'classifying',
              current: data.current || 0,
              total: data.total || 0,
              filename: data.filename,
            };

            if (data.phase === 'classified' && data.filename) {
              const catShort = data.category
                ? data.category.replace(/_/g, ' ')
                : 'unclassified';
              const confPct = data.confidence != null
                ? `${Math.round(data.confidence * 100)}%`
                : '';
              progress.detail = `→ ${catShort}${confPct ? ` (${confPct})` : ''}`;

              const logEntry: ProgressLogEntry = {
                filename: data.filename,
                detail: progress.detail,
                reasoning: data.reasoning || undefined,
                status: 'ok',
                timestamp: Date.now(),
              };
              set(s => ({
                operationProgress: progress,
                progressLog: [...s.progressLog, logEntry],
              }));
              return;
            }

            if (data.phase === 'classifying' && data.filename) {
              const logEntry: ProgressLogEntry = {
                filename: data.filename,
                detail: 'analyzing...',
                status: 'classifying',
                timestamp: Date.now(),
              };
              set(s => ({
                operationProgress: progress,
                // Replace the last "classifying" entry if it exists, or append
                progressLog: s.progressLog.at(-1)?.status === 'classifying'
                  ? [...s.progressLog.slice(0, -1), logEntry]
                  : [...s.progressLog, logEntry],
              }));
              return;
            }

            set({ operationProgress: progress });
          } else if (eventType === 'complete') {
            set(s => ({
              operationProgress: {
                phase: 'complete',
                current: data.classified || s.operationProgress?.total || 0,
                total: s.operationProgress?.total || 0,
              },
            }));
          }
        },
      );

      // Refresh data after stream completes
      const documents = await api.listDocuments(reportId);
      set({ documents, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false, operationProgress: null });
    }
  },

  applyDirectorRecommendations: async (reportId) => {
    set({ loading: true, error: null });
    try {
      await api.applyDirectorRecommendations(reportId);
      const documents = await api.listDocuments(reportId);
      set({
        documents,
        loading: false,
        directorHealth: null,
        directorExcludeCount: 0,
      });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  clearProgress: () => set({ operationProgress: null, progressLog: [] }),

  runFullPipeline: async (reportId, method, payload) => {
    set({
      pipelineRunning: true,
      pipelinePhase: method === 'files' ? 'uploading' : 'converting',
      error: null,
      operationProgress: null,
      progressLog: [],
      assembleResult: null,
    });

    try {
      // Step 1: Upload (+ convert + filename-classify for folder path)
      if (method === 'files') {
        // Upload files — returns fast, processing happens in background
        await api.uploadFiles(reportId, payload as FileList | File[], (pct) =>
          set({ uploadProgress: pct })
        );
        set({ uploadProgress: null, pipelinePhase: 'converting' });

        // Wait for background processing (PDF conversion, page counting)
        await api.waitForProcessing(reportId, (status) => {
          const done = status.total - status.pending;
          set({
            operationProgress: {
              phase: 'converting',
              current: done,
              total: status.total,
              detail: status.errors > 0 ? `${status.errors} errors` : undefined,
            },
          });
        });
        set({ operationProgress: null });
      } else {
        // Folder upload via SSE — converts files AND classifies in one stream
        const formData = new FormData();
        formData.append('folder_path', payload as string);

        await consumeSSEStream(
          uploadFolderStreamUrl(reportId),
          formData,
          (eventType: string, data: SSEProgressEvent) => {
            if (eventType === 'progress') {
              const progress: OperationProgress = {
                phase: data.phase || 'processing',
                current: data.current || 0,
                total: data.total || 0,
                filename: data.filename,
              };

              if (data.phase === 'processed' && data.filename) {
                const logEntry: ProgressLogEntry = {
                  filename: data.filename,
                  detail: data.excluded ? 'excluded' : data.status === 'error' ? 'error' : 'converted',
                  reasoning: data.reasoning || undefined,
                  status: data.excluded ? 'excluded' : data.status === 'error' ? 'error' : 'ok',
                  timestamp: Date.now(),
                };
                set(s => ({
                  operationProgress: progress,
                  progressLog: [...s.progressLog, logEntry],
                }));
                return;
              }

              // Classification phases within the upload stream
              if (data.phase === 'classifying') {
                set(s => ({
                  pipelinePhase: 'classifying',
                  operationProgress: progress,
                  // Clear upload log, start fresh for classification
                  progressLog: s.pipelinePhase !== 'classifying' ? [] : s.progressLog,
                }));
                return;
              }

              if (data.phase === 'classified' && data.filename) {
                const catShort = data.category
                  ? data.category.replace(/_/g, ' ')
                  : 'unclassified';
                const confPct = data.confidence != null
                  ? `${Math.round(data.confidence * 100)}%`
                  : '';
                progress.detail = `→ ${catShort}${confPct ? ` (${confPct})` : ''}`;

                const logEntry: ProgressLogEntry = {
                  filename: data.filename,
                  detail: progress.detail,
                  reasoning: data.reasoning || undefined,
                  status: 'ok',
                  timestamp: Date.now(),
                };
                set(s => ({
                  operationProgress: progress,
                  progressLog: [...s.progressLog, logEntry],
                }));
                return;
              }

              if (data.phase === 'validating') {
                set({ pipelinePhase: 'validating', operationProgress: progress });
                return;
              }

              if (data.phase === 'directing') {
                set({ pipelinePhase: 'directing', operationProgress: progress });
                return;
              }

              set({ operationProgress: progress });
            } else if (eventType === 'complete') {
              set(s => ({
                operationProgress: {
                  phase: 'complete',
                  current: data.uploaded || s.operationProgress?.total || 0,
                  total: data.total || s.operationProgress?.total || 0,
                  detail: data.errors ? `${data.errors} errors` : undefined,
                },
                directorHealth: data.director_health || null,
                directorExcludeCount: data.director_exclude_count || 0,
                directorEstimatedPages: data.director_estimated_pages || null,
              }));
            }
          },
        );
      }

      // Refresh documents after upload + classification
      const docsAfterUpload = await api.listDocuments(reportId);
      const reportAfterUpload = await api.getReport(reportId);
      set({ documents: docsAfterUpload, currentReport: reportAfterUpload });

      // Step 3: Auto-name (non-blocking, don't await)
      api.autoNameReport(reportId).then(result => {
        if (result.status === 'ok' && result.updated && Object.keys(result.updated).length > 0) {
          api.getReport(reportId).then(report => {
            set(s => ({
              currentReport: s.currentReport?.id === reportId ? report : s.currentReport,
              reports: s.reports.map(r => r.id === reportId ? report : r),
            }));
          });
        }
      }).catch(() => {});

      // Step 4: Assemble
      set({ pipelinePhase: 'assembling', operationProgress: null, progressLog: [] });

      const assembleResult = await api.assembleReport(reportId);
      const finalReport = await api.getReport(reportId);
      set({
        assembleResult,
        currentReport: finalReport,
        pipelineRunning: false,
        pipelinePhase: 'idle',
        operationProgress: null,
        progressLog: [],
      });
    } catch (e: any) {
      set({
        error: e.message,
        pipelineRunning: false,
        pipelinePhase: 'idle',
        operationProgress: null,
      });
    }
  },

  clearError: () => set({ error: null }),

  toggleSelectDoc: (docId) => set(s => {
    const next = new Set(s.selectedDocIds);
    if (next.has(docId)) next.delete(docId);
    else next.add(docId);
    return { selectedDocIds: next };
  }),

  selectRange: (fromId, toId) => set(s => {
    const ids = s.documents.filter(d => d.is_included).map(d => d.id);
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return {};
    const start = Math.min(fromIdx, toIdx);
    const end = Math.max(fromIdx, toIdx);
    const next = new Set(s.selectedDocIds);
    for (let i = start; i <= end; i++) next.add(ids[i]);
    return { selectedDocIds: next };
  }),

  selectAllInSection: (docIds) => set(s => {
    const next = new Set(s.selectedDocIds);
    docIds.forEach(id => next.add(id));
    return { selectedDocIds: next };
  }),

  deselectAllInSection: (docIds) => set(s => {
    const next = new Set(s.selectedDocIds);
    docIds.forEach(id => next.delete(id));
    return { selectedDocIds: next };
  }),

  clearSelection: () => set({ selectedDocIds: new Set() }),

  setSearchQuery: (query) => set({ searchQuery: query }),
}));
