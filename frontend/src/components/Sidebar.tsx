import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { FolderInput, Plus, FileText, AlertCircle, AlertTriangle, CheckCircle2, Search, X } from 'lucide-react';
import type { Document as DocType } from '../types';
import { SectionCategory, SECTION_ORDER } from '../types';
import { useReportStore } from '../stores/reportStore';
import { SidebarSection } from './SidebarSection';
import { ExcludedPanel } from './ExcludedPanel';
import { ErrorPanel } from './ErrorPanel';
import { BatchActionBar } from './BatchActionBar';

interface Props {
  reportId: number;
  documents: DocType[];
  hasRelianceLetter: boolean;
  onPreview: (docId: number | null) => void;
  onDocChanged: () => void;
  onEditDoc?: (docId: number) => void;
}

export function Sidebar({ reportId, documents, hasRelianceLetter, onPreview, onDocChanged, onEditDoc }: Props) {
  const {
    updateDocument, reorderDocuments, reprocessErrors, uploadFiles, uploadFolderStream,
    directorHealth, directorExcludeCount, applyDirectorRecommendations,
    selectedDocIds, clearSelection, searchQuery, setSearchQuery, toggleSelectDoc, selectRange,
    selectAllInSection, deselectAllInSection,
  } = useReportStore();

  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  // Group documents by section — only included docs go in sections
  const docsBySection = useMemo(() => {
    const grouped: Record<string, DocType[]> = {};
    for (const cat of SECTION_ORDER) {
      grouped[cat] = [];
    }
    for (const doc of documents) {
      if (!doc.is_included) continue;
      const cat = doc.category as string;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(doc);
    }
    for (const cat of Object.keys(grouped)) {
      grouped[cat].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    }
    return grouped;
  }, [documents]);

  // Auto-expand sections that have docs
  useEffect(() => {
    const withDocs = new Set<string>();
    for (const [cat, docs] of Object.entries(docsBySection)) {
      if (docs.length > 0) withDocs.add(cat);
    }
    if (withDocs.size > 0) {
      setExpandedSections(prev => {
        const next = new Set(prev);
        for (const cat of withDocs) next.add(cat);
        return next;
      });
    }
  }, [docsBySection]);

  // Search filtering
  const filteredDocs = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.toLowerCase();
    return documents.filter(d => d.original_filename.toLowerCase().includes(q));
  }, [documents, searchQuery]);

  const excludedDocs = useMemo(() => documents.filter(d => !d.is_included && d.status !== 'error'), [documents]);
  const errorDocs = useMemo(() => documents.filter(d => d.status === 'error'), [documents]);

  const visibleSections = useMemo(() => {
    return SECTION_ORDER.filter(s => {
      if (s === SectionCategory.RELIANCE_LETTER && !hasRelianceLetter) return false;
      // Hide UNCLASSIFIED when it has no docs
      if (s === SectionCategory.UNCLASSIFIED && (docsBySection[s]?.length || 0) === 0) return false;
      return true;
    });
  }, [hasRelianceLetter, docsBySection]);

  const totalDocs = documents.filter(d => d.is_included).length;
  const totalPages = documents.filter(d => d.is_included).reduce((s, d) => s + (d.page_count || 0), 0);

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const handleReclassify = (docId: number, category: SectionCategory, subcategory?: string) => {
    const update: { category: SectionCategory; subcategory?: string } = { category };
    if (subcategory !== undefined) update.subcategory = subcategory;
    updateDocument(reportId, docId, update);
    onDocChanged();
  };

  const handleToggleInclude = (docId: number, included: boolean) => {
    updateDocument(reportId, docId, { is_included: included });
    onDocChanged();
  };

  const handleReorder = useCallback((docId: number, direction: 'up' | 'down') => {
    const doc = documents.find(d => d.id === docId);
    if (!doc) return;
    const sectionDocs = docsBySection[doc.category] || [];
    const ids = sectionDocs.map(d => d.id);
    const idx = ids.indexOf(docId);
    if (idx < 0) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= ids.length) return;
    ids.splice(idx, 1);
    ids.splice(newIdx, 0, docId);
    reorderDocuments(reportId, ids, doc.category as SectionCategory);
    onDocChanged();
  }, [documents, docsBySection, reportId, reorderDocuments, onDocChanged]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeDoc = documents.find(d => d.id === active.id);
    const overDoc = documents.find(d => d.id === over.id);
    if (!activeDoc || !overDoc) return;

    if (activeDoc.category === overDoc.category) {
      const sectionDocs = docsBySection[activeDoc.category] || [];
      const ids = sectionDocs.map(d => d.id);
      const oldIdx = ids.indexOf(activeDoc.id);
      const newIdx = ids.indexOf(overDoc.id);
      ids.splice(oldIdx, 1);
      ids.splice(newIdx, 0, activeDoc.id);
      reorderDocuments(reportId, ids, activeDoc.category as SectionCategory);
    } else {
      updateDocument(reportId, activeDoc.id, { category: overDoc.category as SectionCategory });
    }
    onDocChanged();
  };

  const lastSelectedRef = useRef<number | null>(null);
  const handleSelectDoc = useCallback((docId: number, shiftKey: boolean) => {
    if (shiftKey && lastSelectedRef.current !== null) {
      selectRange(lastSelectedRef.current, docId);
    } else {
      toggleSelectDoc(docId);
    }
    lastSelectedRef.current = docId;
  }, [toggleSelectDoc, selectRange]);

  const handleRetryAll = async () => {
    await reprocessErrors(reportId);
  };

  const handleAddFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      uploadFiles(reportId, e.target.files);
    }
  };

  const handleFolderSubmit = () => {
    if (folderPath.trim()) {
      uploadFolderStream(reportId, folderPath.trim());
      setFolderPath('');
      setShowFolderInput(false);
    }
  };

  return (
    <div className="w-[380px] border-r border-gray-200 bg-white flex flex-col overflow-hidden shrink-0">
      {/* Top bar: add files + summary */}
      <div className="px-3 py-2 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 transition font-medium"
            >
              <Plus size={14} /> Add files
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleAddFiles}
              accept=".pdf,.docx,.doc,.heic,.heif,.jpg,.jpeg,.png,.tiff,.tif,.vsd,.vsdx,.txt,.zip"
            />
            <span className="text-gray-300">|</span>
            <button
              onClick={() => setShowFolderInput(!showFolderInput)}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-600 transition"
            >
              <FolderInput size={12} /> Folder
            </button>
          </div>
          {totalDocs > 0 && (
            <span className="text-[11px] text-gray-400 flex items-center gap-1">
              <FileText size={11} />
              {totalDocs} docs
              {totalPages > 0 && ` \u00b7 ${totalPages.toLocaleString()}p`}
            </span>
          )}
        </div>
      </div>

      {showFolderInput && (
        <div className="px-3 py-2 border-b border-gray-100 flex gap-2">
          <input
            type="text"
            value={folderPath}
            onChange={e => setFolderPath(e.target.value)}
            placeholder="/path/to/folder"
            className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-blue-500"
            onKeyDown={e => e.key === 'Enter' && handleFolderSubmit()}
            autoFocus
          />
          <button
            onClick={handleFolderSubmit}
            disabled={!folderPath.trim()}
            className="bg-blue-600 text-white px-2 py-1 rounded text-xs hover:bg-blue-700 disabled:opacity-50"
          >
            Import
          </button>
        </div>
      )}

      {/* Search filter */}
      <div className="px-3 py-1.5 border-b border-gray-100">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Filter documents..."
            className="w-full pl-7 pr-7 py-1 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-blue-500 outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Director health banner */}
      {directorHealth === 'critical' && (
        <div className="mx-3 mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded-md flex items-start gap-2">
          <AlertCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
          <div className="text-xs text-red-700">
            <span className="font-medium">Critical</span> — Cover/Write-Up may be missing
          </div>
        </div>
      )}
      {directorHealth === 'needs_attention' && (
        <div className="mx-3 mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-amber-500 mt-0.5 shrink-0" />
            <div className="text-xs text-amber-700">
              <div className="font-medium">{totalPages.toLocaleString()} pages (typical: 1,000–4,000)</div>
              {directorExcludeCount > 0 && (
                <div className="mt-1">AI recommends excluding {directorExcludeCount} documents</div>
              )}
            </div>
          </div>
          {directorExcludeCount > 0 && (
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => applyDirectorRecommendations(reportId)}
                className="text-xs bg-amber-600 text-white px-2 py-1 rounded hover:bg-amber-700 transition"
              >
                Apply Recommendations
              </button>
              <button
                onClick={() => useReportStore.setState({ directorHealth: null, directorExcludeCount: 0 })}
                className="text-xs text-amber-600 hover:text-amber-800 transition"
              >
                Keep All
              </button>
            </div>
          )}
        </div>
      )}
      {directorHealth === 'good' && (
        <div className="mx-3 mt-2 px-3 py-2 bg-green-50 border border-green-200 rounded-md flex items-start gap-2">
          <CheckCircle2 size={16} className="text-green-500 mt-0.5 shrink-0" />
          <div className="text-xs text-green-700">
            Report looks good — {totalPages.toLocaleString()} pages
          </div>
        </div>
      )}

      {/* Section list */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1 relative">
        {!filteredDocs && <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          {visibleSections.map(section => (
            <SidebarSection
              key={section}
              section={section}
              documents={docsBySection[section] || []}
              isExpanded={expandedSections.has(section)}
              onToggleExpand={() => toggleSection(section)}
              onPreview={(id) => onPreview(id)}
              onReclassify={handleReclassify}
              onToggleInclude={handleToggleInclude}
              onReorder={handleReorder}
              onEditDoc={onEditDoc}
              selectedDocIds={selectedDocIds}
              onSelectDoc={handleSelectDoc}
              onSelectAllInSection={selectAllInSection}
              onDeselectAllInSection={deselectAllInSection}
            />
          ))}
        </DndContext>}

        {/* Search results (flat list) */}
        {filteredDocs && (
          <div className="px-1">
            <div className="text-[11px] text-gray-400 px-2 py-1">
              {filteredDocs.length} result{filteredDocs.length !== 1 ? 's' : ''} for "{searchQuery}"
            </div>
            {filteredDocs.map(doc => (
              <div
                key={doc.id}
                className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-blue-50 rounded cursor-pointer"
                onClick={() => onPreview(doc.id)}
              >
                <span className="truncate flex-1">{doc.original_filename}</span>
                <span className="text-gray-400 shrink-0">{doc.page_count || '?'}p</span>
                <span className={`text-gray-400 shrink-0 ${!doc.is_included ? 'line-through' : ''}`}>
                  {doc.category.replace(/_/g, ' ')}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Excluded & Error panels */}
        {!filteredDocs && (
          <>
            <ExcludedPanel documents={excludedDocs} reportId={reportId} onToggleInclude={handleToggleInclude} onReclassify={handleReclassify} />
            <ErrorPanel documents={errorDocs} onRetryAll={handleRetryAll} />
          </>
        )}
      </div>

      {/* Batch action bar — sticky bottom */}
      {selectedDocIds.size > 0 && (
        <BatchActionBar
          reportId={reportId}
          selectedIds={selectedDocIds}
          onClear={clearSelection}
          onDocChanged={onDocChanged}
        />
      )}
    </div>
  );
}
