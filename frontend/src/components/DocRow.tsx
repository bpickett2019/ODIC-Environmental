import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Eye, EyeOff, ChevronUp, ChevronDown, Pencil } from 'lucide-react';
import type { Document as DocType } from '../types';
import { SectionCategory, SECTION_DISPLAY } from '../types';

const APPENDIX_D_SUBCATEGORIES = [
  { value: '', label: '(none)' },
  { value: 'sanborn', label: 'Sanborn' },
  { value: 'aerials', label: 'Aerials' },
  { value: 'topos', label: 'Topos' },
  { value: 'city_directory', label: 'City Dir' },
];

interface Props {
  doc: DocType;
  onPreview: (docId: number) => void;
  onReclassify: (docId: number, category: SectionCategory, subcategory?: string) => void;
  onToggleInclude: (docId: number, included: boolean) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onEdit?: (docId: number) => void;
  isFirst?: boolean;
  isLast?: boolean;
  isSelected?: boolean;
  anySelected?: boolean;
  onSelect?: (docId: number, shiftKey: boolean) => void;
}

export function DocRow({
  doc,
  onPreview,
  onReclassify,
  onToggleInclude,
  onMoveUp,
  onMoveDown,
  onEdit,
  isFirst,
  isLast,
  isSelected,
  anySelected,
  onSelect,
}: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: doc.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isManual = doc.confidence === 1.0 && doc.reasoning === 'Manually classified by user';
  const confidenceDot = isManual
    ? 'bg-blue-500'
    : doc.confidence === null
      ? 'bg-gray-300'
      : doc.confidence >= 0.85
        ? 'bg-green-500'
        : doc.confidence >= 0.6
          ? 'bg-amber-500'
          : 'bg-red-500';

  const confidenceTitle = isManual
    ? 'Manual'
    : doc.confidence !== null
      ? `${Math.round(doc.confidence * 100)}%`
      : '?';

  const reasoningText = doc.reasoning
    ? doc.reasoning.length > 55 ? doc.reasoning.slice(0, 52) + '...' : doc.reasoning
    : 'Not classified';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative flex items-start gap-1.5 px-2 py-1.5 rounded text-sm hover:bg-blue-50/50 transition ${
        !doc.is_included ? 'opacity-40' : ''
      } ${isSelected ? 'bg-blue-50 border-l-2 border-blue-500' : ''}`}
    >
      {/* Selection checkbox — visible on hover or when any doc selected */}
      {onSelect && (
        <input
          type="checkbox"
          checked={isSelected || false}
          onChange={() => {}}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(doc.id, e.shiftKey);
          }}
          className={`mt-1 shrink-0 rounded border-gray-300 text-blue-600 cursor-pointer ${
            anySelected ? '' : 'opacity-0 group-hover:opacity-100'
          } transition`}
        />
      )}

      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-gray-300 hover:text-gray-500 mt-0.5 shrink-0"
      >
        <GripVertical size={14} />
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onPreview(doc.id)}
            className="truncate text-gray-700 hover:text-blue-600 text-left min-w-0 flex-1"
            title={doc.original_filename}
          >
            {doc.original_filename}
          </button>

          {doc.has_docx_source && onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(doc.id); }}
              className="text-purple-400 hover:text-purple-600 shrink-0 transition"
              title="Edit DOCX"
            >
              <Pencil size={10} />
            </button>
          )}
          {doc.has_docx_source && !onEdit && (
            <div className="text-purple-400 shrink-0" title="Editable DOCX">
              <Pencil size={10} />
            </div>
          )}

          {doc.page_count != null && doc.page_count > 0 && (
            <span className="text-xs text-gray-400 shrink-0">{doc.page_count}p</span>
          )}

          <span
            className={`w-2 h-2 rounded-full shrink-0 ${confidenceDot}`}
            title={`${confidenceTitle} — ${doc.reasoning || ''}`}
          />
        </div>

        <p className="text-xs text-gray-400 truncate mt-0.5" title={doc.reasoning || ''}>
          {reasoningText}
        </p>
      </div>

      {/* Actions on hover — positioned as overlay on right */}
      <div className="hidden group-hover:flex items-center gap-0.5 absolute right-1 top-1 bg-white/95 backdrop-blur-sm shadow-sm border border-gray-100 rounded px-1 py-0.5 z-10">
        <select
          value={doc.category}
          onChange={e => onReclassify(doc.id, e.target.value as SectionCategory)}
          className="text-[11px] border border-gray-200 rounded px-1 py-0.5 bg-white max-w-[130px]"
          onClick={e => e.stopPropagation()}
        >
          {Object.values(SectionCategory).map(cat => (
            <option key={cat} value={cat}>{SECTION_DISPLAY[cat]}</option>
          ))}
        </select>

        {doc.category === SectionCategory.APPENDIX_D && (
          <select
            value={doc.subcategory || ''}
            onChange={e => onReclassify(doc.id, doc.category as SectionCategory, e.target.value || undefined)}
            className="text-[11px] border border-gray-200 rounded px-1 py-0.5 bg-white"
            onClick={e => e.stopPropagation()}
          >
            {APPENDIX_D_SUBCATEGORIES.map(sub => (
              <option key={sub.value} value={sub.value}>{sub.label}</option>
            ))}
          </select>
        )}

        <button
          onClick={() => onToggleInclude(doc.id, !doc.is_included)}
          className="p-0.5 text-gray-400 hover:text-gray-600"
          title={doc.is_included ? 'Exclude from report' : 'Include in report'}
        >
          {doc.is_included ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>

        {!isFirst && onMoveUp && (
          <button onClick={onMoveUp} className="p-0.5 text-gray-400 hover:text-gray-600" title="Move up">
            <ChevronUp size={14} />
          </button>
        )}
        {!isLast && onMoveDown && (
          <button onClick={onMoveDown} className="p-0.5 text-gray-400 hover:text-gray-600" title="Move down">
            <ChevronDown size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
