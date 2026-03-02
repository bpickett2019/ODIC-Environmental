import { ChevronRight } from 'lucide-react';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { Document as DocType } from '../types';
import { SectionCategory, SECTION_DISPLAY, SECTION_SHORT } from '../types';
import { DocRow } from './DocRow';

interface Props {
  section: SectionCategory;
  documents: DocType[];
  isExpanded: boolean;
  onToggleExpand: () => void;
  onPreview: (docId: number) => void;
  onReclassify: (docId: number, category: SectionCategory, subcategory?: string) => void;
  onToggleInclude: (docId: number, included: boolean) => void;
  onReorder: (docId: number, direction: 'up' | 'down') => void;
  onEditDoc?: (docId: number) => void;
  selectedDocIds?: Set<number>;
  onSelectDoc?: (docId: number, shiftKey: boolean) => void;
  onSelectAllInSection?: (docIds: number[]) => void;
  onDeselectAllInSection?: (docIds: number[]) => void;
}

export function SidebarSection({
  section,
  documents,
  isExpanded,
  onToggleExpand,
  onPreview,
  onReclassify,
  onToggleInclude,
  onReorder,
  onEditDoc,
  selectedDocIds,
  onSelectDoc,
  onSelectAllInSection,
  onDeselectAllInSection,
}: Props) {
  const includedDocs = documents.filter(d => d.is_included);
  const totalPages = includedDocs.reduce((sum, d) => sum + (d.page_count || 0), 0);
  const errorCount = documents.filter(d => d.status === 'error').length;
  const hasDocs = documents.length > 0;

  const statusDot = errorCount > 0
    ? 'bg-red-500'
    : hasDocs
      ? 'bg-green-500'
      : 'bg-gray-300';

  const allSelected = hasDocs && selectedDocIds && documents.every(d => selectedDocIds.has(d.id));
  const someSelected = hasDocs && selectedDocIds && documents.some(d => selectedDocIds.has(d.id)) && !allSelected;

  const handleSelectAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    const docIds = documents.map(d => d.id);
    if (allSelected) {
      onDeselectAllInSection?.(docIds);
    } else {
      onSelectAllInSection?.(docIds);
    }
  };

  return (
    <div className={`rounded-lg overflow-hidden ${hasDocs ? 'border border-gray-200' : ''}`}>
      <div
        className={`w-full flex items-center gap-2 px-3 text-left transition cursor-pointer ${
          hasDocs
            ? 'py-2 bg-gray-50 hover:bg-gray-100'
            : 'py-1.5 hover:bg-gray-50'
        }`}
        onClick={onToggleExpand}
      >
        {hasDocs && onSelectDoc && (
          <input
            type="checkbox"
            checked={allSelected || false}
            ref={el => { if (el) el.indeterminate = someSelected || false; }}
            onChange={() => {}}
            onClick={handleSelectAll}
            className="shrink-0 rounded border-gray-300 text-blue-600 cursor-pointer"
          />
        )}
        <ChevronRight
          size={12}
          className={`text-gray-400 transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
        />
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
        <span
          className={`text-xs truncate min-w-0 ${hasDocs ? 'font-medium text-gray-800' : 'text-gray-500'}`}
          title={SECTION_DISPLAY[section]}
        >
          {SECTION_SHORT[section]}
        </span>
        {hasDocs && (
          <span className="text-[11px] text-gray-400 shrink-0 ml-auto">
            {includedDocs.length} doc{includedDocs.length !== 1 ? 's' : ''}
            {totalPages > 0 && ` \u00b7 ${totalPages.toLocaleString()}p`}
          </span>
        )}
      </div>

      {isExpanded && hasDocs && (
        <SortableContext items={documents.map(d => d.id)} strategy={verticalListSortingStrategy}>
          <div className="p-1 space-y-0.5">
            {documents.map((doc, idx) => (
              <DocRow
                key={doc.id}
                doc={doc}
                onPreview={onPreview}
                onReclassify={onReclassify}
                onToggleInclude={onToggleInclude}
                onMoveUp={() => onReorder(doc.id, 'up')}
                onMoveDown={() => onReorder(doc.id, 'down')}
                onEdit={onEditDoc}
                isFirst={idx === 0}
                isLast={idx === documents.length - 1}
                isSelected={selectedDocIds?.has(doc.id)}
                anySelected={selectedDocIds ? selectedDocIds.size > 0 : false}
                onSelect={onSelectDoc}
              />
            ))}
          </div>
        </SortableContext>
      )}
    </div>
  );
}
