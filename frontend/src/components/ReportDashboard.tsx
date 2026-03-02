import { useEffect, useState, useCallback, useMemo } from 'react';
import { Loader2, RefreshCw, Settings2, Download, FileText } from 'lucide-react';
import { useReportStore } from '../stores/reportStore';
import { getAutoDownloadUrl } from '../api/client';
import { UploadOverlay } from './UploadOverlay';
import { ProcessingOverlay } from './ProcessingOverlay';
import { Sidebar } from './Sidebar';
import { PDFPreview } from './PDFPreview';
import { ActionBar } from './ActionBar';
import { ChatBubble } from './ChatBubble';

export function ReportDashboard() {
  const {
    reports,
    currentReport,
    documents,
    error,
    operationProgress,
    progressLog,
    pipelineRunning,
    pipelinePhase,
    fetchReports,
    createReport,
    selectReport,
    updateReport,
    deleteReport,
    assembleReport,
    runFullPipeline,
    assembleResult,
    clearError,
  } = useReportStore();

  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isCreatingReport, setIsCreatingReport] = useState(false);
  const [previewDocId, setPreviewDocId] = useState<number | null>(null);
  const [editingDocId, setEditingDocId] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState('');

  // Load reports on mount
  useEffect(() => {
    fetchReports();
  }, []);

  // Doc stats
  const docStats = useMemo(() => {
    const included = documents.filter(d => d.is_included);
    const total = documents.length;
    const classified = documents.filter(d => d.category !== 'UNCLASSIFIED').length;
    const errors = documents.filter(d => d.status === 'error').length;
    const excluded = documents.filter(d => !d.is_included).length;
    return { included: included.length, total, classified, errors, excluded };
  }, [documents]);

  // Create report and run the full automatic pipeline
  const handleCreateAndUpload = useCallback(async (files: FileList | File[]) => {
    setIsCreatingReport(true);
    setHasUnsavedChanges(false);
    setPreviewDocId(null);
    try {
      const report = await createReport({
        name: `New Report — ${new Date().toLocaleDateString()}`,
        has_reliance_letter: true,
      });
      await selectReport(report.id);
      setIsCreatingReport(false);
      await runFullPipeline(report.id, 'files', files);
    } catch (e) {
      console.error('Failed to create report:', e);
      setIsCreatingReport(false);
    }
  }, [createReport, selectReport, runFullPipeline]);

  const handleFolderUpload = useCallback(async (path: string) => {
    setIsCreatingReport(true);
    setHasUnsavedChanges(false);
    setPreviewDocId(null);
    try {
      const report = await createReport({
        name: `New Report — ${new Date().toLocaleDateString()}`,
        has_reliance_letter: true,
      });
      await selectReport(report.id);
      setIsCreatingReport(false);
      await runFullPipeline(report.id, 'folder', path);
    } catch (e) {
      console.error('Failed to create report:', e);
      setIsCreatingReport(false);
    }
  }, [createReport, selectReport, runFullPipeline]);

  const handleSelectReport = useCallback(async (id: number) => {
    await selectReport(id);
    setHasUnsavedChanges(false);
    setPreviewDocId(null);
  }, [selectReport]);

  const handleReassemble = useCallback(async () => {
    if (!currentReport) return;
    useReportStore.setState({
      pipelineRunning: true,
      pipelinePhase: 'assembling',
      operationProgress: null,
      progressLog: [],
    });
    try {
      await assembleReport(currentReport.id);
      setHasUnsavedChanges(false);
      setPreviewDocId(null);
    } finally {
      useReportStore.setState({ pipelineRunning: false, pipelinePhase: 'idle' });
    }
  }, [currentReport, assembleReport]);

  const handleDocChanged = useCallback(() => {
    setHasUnsavedChanges(true);
  }, []);

  const handlePreview = useCallback((docId: number | null) => {
    setPreviewDocId(docId);
  }, []);

  const startEditName = () => {
    if (!currentReport) return;
    setEditName(currentReport.name);
    setIsEditingName(true);
  };

  const saveName = () => {
    if (!currentReport) return;
    if (editName.trim() && editName.trim() !== currentReport.name) {
      updateReport(currentReport.id, { name: editName.trim() } as any);
    }
    setIsEditingName(false);
  };

  // ─── No report loaded → show UploadOverlay ───
  if (!currentReport) {
    return (
      <UploadOverlay
        reports={reports}
        onCreateAndUpload={handleCreateAndUpload}
        onFolderUpload={handleFolderUpload}
        onSelectReport={handleSelectReport}
        onDeleteReport={deleteReport}
        isCreating={isCreatingReport}
      />
    );
  }

  // ─── Report loaded → main dashboard ───
  const assembledReady = !!currentReport.assembled_filename;

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => {
              useReportStore.setState({ currentReport: null, documents: [] });
              fetchReports();
            }}
            className="text-xs text-gray-400 hover:text-blue-600 transition shrink-0"
          >
            All Reports
          </button>
          <span className="text-gray-300 shrink-0">/</span>

          {isEditingName ? (
            <input
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onBlur={saveName}
              onKeyDown={e => e.key === 'Enter' && saveName()}
              className="font-semibold text-gray-900 border-b-2 border-blue-500 outline-none bg-transparent px-1 min-w-0"
              autoFocus
            />
          ) : (
            <button
              onClick={startEditName}
              className="font-semibold text-gray-900 hover:text-blue-600 transition truncate"
              title="Click to rename"
            >
              {currentReport.name}
            </button>
          )}

          {currentReport.address && (
            <span className="text-xs text-gray-400 shrink-0">{currentReport.address}</span>
          )}

          {/* Doc count badge */}
          {docStats.total > 0 && (
            <span className="text-[11px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full shrink-0 flex items-center gap-1">
              <FileText size={10} />
              {docStats.included}/{docStats.total}
              {docStats.errors > 0 && (
                <span className="text-red-500 ml-1">{docStats.errors} err</span>
              )}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Status */}
          {pipelineRunning && (
            <span className="text-xs text-blue-600 flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" /> Processing
            </span>
          )}

          {/* Re-assemble button */}
          {hasUnsavedChanges && !pipelineRunning && (
            <button
              onClick={handleReassemble}
              className="flex items-center gap-1.5 bg-orange-500 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-orange-600 transition font-medium shadow-sm"
            >
              <RefreshCw size={14} /> Re-assemble
            </button>
          )}

          {/* Download — auto-split if > 20MB */}
          {assembledReady && (
            <a
              href={getAutoDownloadUrl(currentReport.id)}
              className="flex items-center gap-1 bg-blue-700 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-blue-800 transition"
            >
              <Download size={14} /> Download
            </a>
          )}

          {/* Settings */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-1.5 rounded transition ${showSettings ? 'bg-gray-100 text-gray-700' : 'text-gray-400 hover:text-gray-600'}`}
          >
            <Settings2 size={16} />
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="bg-gray-50 border-b border-gray-200 px-4 py-2 flex items-center gap-6 text-sm shrink-0">
          <label className="flex items-center gap-2 text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={currentReport.has_reliance_letter}
              onChange={e => updateReport(currentReport.id, { has_reliance_letter: e.target.checked } as any)}
              className="rounded border-gray-300 text-blue-600"
            />
            Include Reliance Letter section
          </label>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-2 flex items-center justify-between shrink-0">
          <span className="text-sm text-red-700">{error}</span>
          <button onClick={clearError} className="text-red-500 text-xs hover:text-red-700 font-medium">Dismiss</button>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          reportId={currentReport.id}
          documents={documents}
          hasRelianceLetter={currentReport.has_reliance_letter}
          onPreview={handlePreview}
          onDocChanged={handleDocChanged}
          onEditDoc={(docId) => setEditingDocId(docId)}
        />

        {/* Main preview area */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {/* Doc preview breadcrumb */}
          {previewDocId && (
            <div className="px-4 py-1.5 bg-white border-b border-gray-200 flex items-center justify-between shrink-0">
              <span className="text-xs text-gray-500 truncate">
                {documents.find(d => d.id === previewDocId)?.original_filename}
              </span>
              <button
                onClick={() => setPreviewDocId(null)}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium shrink-0 ml-3"
              >
                Back to report
              </button>
            </div>
          )}

          <div className="flex-1">
            <PDFPreview
              reportId={currentReport.id}
              docId={previewDocId}
              assembledReady={assembledReady}
              manifest={assembleResult?.document_manifest || []}
              documents={documents}
              onDocChanged={handleDocChanged}
              onPreviewDoc={(id) => setPreviewDocId(id)}
              editingDocId={editingDocId}
              onEditDoc={(docId) => setEditingDocId(docId)}
              onEditClose={() => setEditingDocId(null)}
            />
          </div>

          {/* Processing overlay */}
          {pipelineRunning && (
            <ProcessingOverlay
              progress={operationProgress}
              progressLog={progressLog}
              pipelinePhase={pipelinePhase}
            />
          )}
        </div>
      </div>

      {/* Footer / action bar */}
      {assembledReady && <ActionBar reportId={currentReport.id} />}

      {/* Floating chat bubble */}
      <ChatBubble reportId={currentReport.id} onDocChanged={handleDocChanged} />
    </div>
  );
}
