import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { FileText, ChevronLeft, ChevronRight, X, Eye, ArrowRightLeft, Pencil } from 'lucide-react';
import { getAssembledPageUrl, getDocumentPreviewUrl } from '../api/client';
import { useReportStore } from '../stores/reportStore';
import { SectionCategory, SECTION_SHORT, SECTION_ORDER } from '../types';
import type { ManifestEntry, Document as DocType } from '../types';
import { DocxEditor } from './DocxEditor';

interface Props {
  reportId: number;
  docId: number | null;
  assembledReady: boolean;
  manifest: ManifestEntry[];
  documents: DocType[];
  onDocChanged: () => void;
  onPreviewDoc: (docId: number) => void;
  editingDocId?: number | null;
  onEditDoc?: (docId: number) => void;
  onEditClose?: () => void;
}

const CATEGORY_KEYS: Record<string, SectionCategory> = {
  '1': SectionCategory.RELIANCE_LETTER,
  '2': SectionCategory.EO_INSURANCE,
  '3': SectionCategory.COVER_WRITEUP,
  '4': SectionCategory.APPENDIX_A,
  '5': SectionCategory.APPENDIX_B,
  '6': SectionCategory.APPENDIX_C,
  '7': SectionCategory.APPENDIX_D,
  '8': SectionCategory.APPENDIX_E,
  '9': SectionCategory.REPORTS_AFTER_E,
  '0': SectionCategory.APPENDIX_F,
};

export function PDFPreview({ reportId, docId, assembledReady, manifest, documents, onDocChanged, onPreviewDoc, editingDocId, onEditDoc, onEditClose }: Props) {
  const { updateDocument } = useReportStore();
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [showMoveDropdown, setShowMoveDropdown] = useState(false);
  const [reviewed, setReviewed] = useState<Set<number>>(new Set());
  const [imgLoading, setImgLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Compute total pages from manifest
  useEffect(() => {
    if (manifest.length > 0) {
      const last = manifest[manifest.length - 1];
      setTotalPages(last.end_page);
    } else {
      setTotalPages(0);
    }
  }, [manifest]);

  // Reset page when manifest changes (new assembly)
  useEffect(() => {
    setCurrentPage(1);
    setReviewed(new Set());
  }, [manifest.length]);

  // Find which document the current page belongs to
  const currentDocIndex = useMemo(() => {
    if (!manifest.length) return -1;
    return manifest.findIndex(m => currentPage >= m.start_page && currentPage <= m.end_page);
  }, [manifest, currentPage]);

  const entry = currentDocIndex >= 0 ? manifest[currentDocIndex] : null;
  const matchingDoc = entry ? documents.find(d => d.id === entry.doc_id) : null;

  // Page navigation
  const goToPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(page, totalPages));
    if (clamped !== currentPage) {
      setCurrentPage(clamped);
    }
  }, [totalPages, currentPage]);

  // Document navigation — jump to first page of prev/next document
  const goToDoc = useCallback((docIndex: number) => {
    if (docIndex >= 0 && docIndex < manifest.length) {
      setCurrentPage(manifest[docIndex].start_page);
      setShowMoveDropdown(false);
    }
  }, [manifest]);

  const handleExclude = useCallback(async () => {
    if (!entry) return;
    await updateDocument(reportId, entry.doc_id, { is_included: false });
    onDocChanged();
    // Auto-advance to next document
    if (currentDocIndex < manifest.length - 1) {
      goToDoc(currentDocIndex + 1);
    } else if (currentDocIndex > 0) {
      goToDoc(currentDocIndex - 1);
    }
  }, [entry, reportId, updateDocument, onDocChanged, currentDocIndex, manifest.length, goToDoc]);

  const handleReclassify = useCallback(async (category: SectionCategory) => {
    if (!entry) return;
    await updateDocument(reportId, entry.doc_id, { category });
    onDocChanged();
    setShowMoveDropdown(false);
  }, [entry, reportId, updateDocument, onDocChanged]);

  // Keyboard shortcuts
  useEffect(() => {
    if (docId) return; // Disable shortcuts when previewing individual doc
    if (!totalPages) return;

    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.key === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) {
        // Ctrl+Left = previous DOCUMENT
        e.preventDefault();
        if (currentDocIndex > 0) goToDoc(currentDocIndex - 1);
      } else if (e.key === 'ArrowRight' && (e.ctrlKey || e.metaKey)) {
        // Ctrl+Right = next DOCUMENT
        e.preventDefault();
        if (currentDocIndex < manifest.length - 1) goToDoc(currentDocIndex + 1);
      } else if (e.key === 'ArrowLeft') {
        // Left = previous PAGE
        e.preventDefault();
        goToPage(currentPage - 1);
      } else if (e.key === 'ArrowRight') {
        // Right = next PAGE
        e.preventDefault();
        goToPage(currentPage + 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (entry) {
          setReviewed(prev => new Set(prev).add(entry.doc_id));
          // Advance to next doc
          if (currentDocIndex < manifest.length - 1) goToDoc(currentDocIndex + 1);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        handleExclude();
      } else if (CATEGORY_KEYS[e.key]) {
        e.preventDefault();
        handleReclassify(CATEGORY_KEYS[e.key]);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [docId, totalPages, currentPage, currentDocIndex, manifest.length, entry, goToPage, goToDoc, handleExclude, handleReclassify]);

  // Preload adjacent pages
  useEffect(() => {
    if (!assembledReady || docId || !totalPages) return;
    const preload = [currentPage - 1, currentPage + 1].filter(p => p >= 1 && p <= totalPages);
    preload.forEach(p => {
      const img = new Image();
      img.src = getAssembledPageUrl(reportId, p);
    });
  }, [assembledReady, docId, reportId, currentPage, totalPages]);

  // Individual doc preview mode — use iframe
  if (docId) {
    const previewDoc = documents.find(d => d.id === docId);
    return (
      <div className="h-full flex flex-col relative">
        {/* DocxEditor overlay for individual preview */}
        {editingDocId && (
          <DocxEditor
            reportId={reportId}
            docId={editingDocId}
            filename={documents.find(d => d.id === editingDocId)?.original_filename || ''}
            onSaved={() => {
              onEditClose?.();
              onDocChanged();
            }}
            onClose={() => onEditClose?.()}
          />
        )}
        {/* Toolbar for individual doc */}
        {previewDoc?.has_docx_source && onEditDoc && (
          <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-200">
            <button
              onClick={() => onEditDoc(docId)}
              className="flex items-center gap-1 text-xs text-purple-600 bg-purple-50 hover:bg-purple-100 px-2.5 py-1 rounded transition"
            >
              <Pencil size={11} /> Edit DOCX
            </button>
          </div>
        )}
        <iframe
          src={getDocumentPreviewUrl(reportId, docId)}
          className="w-full flex-1 border-0"
          title="Document Preview"
        />
      </div>
    );
  }

  // No preview available
  if (!assembledReady || !totalPages) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 bg-gray-50">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
            <FileText size={28} className="text-gray-300" />
          </div>
          <p className="text-base font-medium text-gray-500 mb-1">No preview available</p>
          <p className="text-sm text-gray-400 max-w-xs">
            Drop files or use the folder import to start building your report.
            The assembled PDF will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col relative">
      {/* DOCX Editor overlay */}
      {editingDocId && (
        <DocxEditor
          reportId={reportId}
          docId={editingDocId}
          filename={documents.find(d => d.id === editingDocId)?.original_filename || ''}
          onSaved={() => {
            onEditClose?.();
            onDocChanged();
          }}
          onClose={() => onEditClose?.()}
        />
      )}

      {/* Page navigation bar */}
      <div className="shrink-0 flex items-center justify-center gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-200">
        <button
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage <= 1}
          className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition"
          title="Previous page (←)"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-xs text-gray-600 tabular-nums min-w-[8rem] text-center">
          Page {currentPage.toLocaleString()} / {totalPages.toLocaleString()}
        </span>
        <button
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition"
          title="Next page (→)"
        >
          <ChevronRight size={16} />
        </button>
        {entry && (
          <>
            <span className="text-gray-300 mx-1">|</span>
            <span className="text-xs text-gray-400 truncate max-w-[20rem]" title={entry.filename}>
              {entry.filename} · {SECTION_SHORT[entry.category] || entry.category} · {entry.page_count}p
            </span>
          </>
        )}
      </div>

      {/* Single page display */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto bg-gray-100 flex items-start justify-center p-4"
      >
        <div className="relative">
          {imgLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          <img
            ref={imgRef}
            src={getAssembledPageUrl(reportId, currentPage)}
            alt={`Page ${currentPage}`}
            className="max-w-full max-h-[calc(100vh-10rem)] w-auto h-auto shadow-lg bg-white"
            style={{ objectFit: 'contain' }}
            onLoadStart={() => setImgLoading(true)}
            onLoad={() => setImgLoading(false)}
            onError={() => setImgLoading(false)}
            draggable={false}
          />
        </div>
      </div>

      {/* Document navigator bar */}
      {manifest.length > 0 && entry && (
        <div className="shrink-0 bg-white border-t border-gray-200 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
          {/* Row 1: Document navigation + doc info */}
          <div className="flex items-center gap-2 px-3 py-1.5">
            <button
              onClick={() => goToDoc(currentDocIndex - 1)}
              disabled={currentDocIndex <= 0}
              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition"
              title="Previous document (Ctrl+←)"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs text-gray-500 tabular-nums min-w-[5rem] text-center">
              Doc {currentDocIndex + 1} / {manifest.length}
            </span>
            <button
              onClick={() => goToDoc(currentDocIndex + 1)}
              disabled={currentDocIndex >= manifest.length - 1}
              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition"
              title="Next document (Ctrl+→)"
            >
              <ChevronRight size={16} />
            </button>

            <span className="text-gray-300 mx-1">|</span>

            <span
              className="text-sm font-medium text-gray-800 truncate flex-1"
              title={entry.filename}
            >
              {reviewed.has(entry.doc_id) && (
                <span className="inline-block w-2 h-2 rounded-full bg-green-400 mr-1.5 align-middle" />
              )}
              {entry.filename}
            </span>

            <span className="text-xs text-gray-400 shrink-0">
              {SECTION_SHORT[entry.category] || entry.category}
              {' · '}
              {entry.page_count}p
              {matchingDoc?.reasoning && (
                <span className="ml-1 text-gray-300" title={matchingDoc.reasoning}>
                  · {matchingDoc.reasoning.length > 30
                    ? matchingDoc.reasoning.slice(0, 30) + '…'
                    : matchingDoc.reasoning}
                </span>
              )}
            </span>
          </div>

          {/* Row 2: Actions */}
          <div className="flex items-center gap-1.5 px-3 py-1 border-t border-gray-100 bg-gray-50/50">
            <button
              onClick={() => {
                if (entry) setReviewed(prev => new Set(prev).add(entry.doc_id));
                if (currentDocIndex < manifest.length - 1) goToDoc(currentDocIndex + 1);
              }}
              className="flex items-center gap-1 text-xs text-green-700 bg-green-50 hover:bg-green-100 px-2 py-1 rounded transition"
              title="Mark as reviewed (Enter)"
            >
              ✓ Keep
            </button>

            <button
              onClick={handleExclude}
              className="flex items-center gap-1 text-xs text-red-600 bg-red-50 hover:bg-red-100 px-2 py-1 rounded transition"
              title="Exclude document (Delete)"
            >
              <X size={11} /> Exclude
            </button>

            <div className="relative">
              <button
                onClick={() => setShowMoveDropdown(!showMoveDropdown)}
                className="flex items-center gap-1 text-xs text-blue-600 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded transition"
                title="Move to different section"
              >
                <ArrowRightLeft size={11} /> Move to
              </button>

              {showMoveDropdown && (
                <div className="absolute bottom-full left-0 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 w-64">
                  {SECTION_ORDER.filter(s => s !== SectionCategory.UNCLASSIFIED && s !== entry.category).map(cat => (
                    <button
                      key={cat}
                      onClick={() => handleReclassify(cat)}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 transition truncate"
                    >
                      {SECTION_SHORT[cat]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {matchingDoc?.has_docx_source && onEditDoc && (
              <button
                onClick={() => onEditDoc(entry.doc_id)}
                className="flex items-center gap-1 text-xs text-purple-600 bg-purple-50 hover:bg-purple-100 px-2 py-1 rounded transition"
                title="Edit DOCX content"
              >
                <Pencil size={11} /> Edit
              </button>
            )}

            <button
              onClick={() => onPreviewDoc(entry.doc_id)}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 px-2 py-1 rounded transition"
              title="Preview individual document"
            >
              <Eye size={11} /> Preview
            </button>

            {/* Keyboard hint */}
            <span className="ml-auto text-[10px] text-gray-300">
              ← → page · Ctrl+← → doc · 1-0 reclassify · Del exclude · Enter keep
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
