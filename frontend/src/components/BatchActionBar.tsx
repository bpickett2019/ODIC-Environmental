import { useState } from 'react';
import { X, ArrowRight, EyeOff, Eye, CheckSquare } from 'lucide-react';
import { useReportStore } from '../stores/reportStore';
import * as api from '../api/client';
import { SectionCategory, SECTION_SHORT } from '../types';

interface Props {
  reportId: number;
  selectedIds: Set<number>;
  onClear: () => void;
  onDocChanged: () => void;
}

export function BatchActionBar({ reportId, selectedIds, onClear, onDocChanged }: Props) {
  const [targetSection, setTargetSection] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const { fetchDocuments, documents } = useReportStore();

  if (selectedIds.size === 0) return null;

  // Check if any selected docs are excluded (for re-include button)
  const hasExcluded = Array.from(selectedIds).some(id => {
    const doc = documents.find(d => d.id === id);
    return doc && !doc.is_included;
  });

  // Count docs per section for dropdown labels
  const sectionCounts: Record<string, number> = {};
  for (const doc of documents.filter(d => d.is_included)) {
    sectionCounts[doc.category] = (sectionCounts[doc.category] || 0) + 1;
  }

  const handleMove = async () => {
    if (!targetSection) return;
    setLoading(true);
    try {
      await api.batchUpdateDocuments(reportId, {
        document_ids: Array.from(selectedIds),
        category: targetSection as SectionCategory,
      });
      await fetchDocuments(reportId);
      onDocChanged();
      onClear();
    } catch (e) {
      console.error('Batch move failed:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleExclude = async () => {
    setLoading(true);
    try {
      await api.batchUpdateDocuments(reportId, {
        document_ids: Array.from(selectedIds),
        is_included: false,
      });
      await fetchDocuments(reportId);
      onDocChanged();
      onClear();
    } catch (e) {
      console.error('Batch exclude failed:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleInclude = async () => {
    setLoading(true);
    try {
      await api.batchUpdateDocuments(reportId, {
        document_ids: Array.from(selectedIds),
        is_included: true,
      });
      await fetchDocuments(reportId);
      onDocChanged();
      onClear();
    } catch (e) {
      console.error('Batch include failed:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectAll = () => {
    const allIncluded = documents.filter(d => d.is_included);
    allIncluded.forEach(d => {
      if (!selectedIds.has(d.id)) {
        useReportStore.getState().toggleSelectDoc(d.id);
      }
    });
  };

  return (
    <div className="sticky bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] px-3 py-2 flex items-center gap-2 z-20">
      <span className="text-xs font-medium text-blue-600 shrink-0">
        {selectedIds.size} selected
      </span>

      <div className="flex items-center gap-1.5 flex-1 flex-wrap">
        <select
          value={targetSection}
          onChange={e => setTargetSection(e.target.value)}
          className="text-xs border border-gray-200 rounded px-2 py-1 bg-white"
        >
          <option value="">Move to...</option>
          {Object.values(SectionCategory).filter(c => c !== 'UNCLASSIFIED').map(cat => (
            <option key={cat} value={cat}>
              {SECTION_SHORT[cat]}{sectionCounts[cat] ? ` (${sectionCounts[cat]})` : ''}
            </option>
          ))}
        </select>

        <button
          onClick={handleMove}
          disabled={!targetSection || loading}
          className="flex items-center gap-1 text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700 disabled:opacity-50 transition"
        >
          <ArrowRight size={12} /> Move
        </button>

        <button
          onClick={handleExclude}
          disabled={loading}
          className="flex items-center gap-1 text-xs bg-red-500 text-white px-2 py-1 rounded hover:bg-red-600 disabled:opacity-50 transition"
        >
          <EyeOff size={12} /> Exclude
        </button>

        {hasExcluded && (
          <button
            onClick={handleInclude}
            disabled={loading}
            className="flex items-center gap-1 text-xs bg-green-500 text-white px-2 py-1 rounded hover:bg-green-600 disabled:opacity-50 transition"
          >
            <Eye size={12} /> Include
          </button>
        )}

        <button
          onClick={handleSelectAll}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 px-1.5 py-1 rounded hover:bg-gray-100 transition"
          title="Select all documents"
        >
          <CheckSquare size={12} /> All
        </button>
      </div>

      <button
        onClick={onClear}
        className="p-1 text-gray-400 hover:text-gray-600 transition shrink-0"
        title="Clear selection"
      >
        <X size={14} />
      </button>
    </div>
  );
}
