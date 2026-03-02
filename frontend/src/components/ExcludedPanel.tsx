import { useState, useMemo } from 'react';
import { ChevronDown, Eye, X, RotateCcw } from 'lucide-react';
import type { Document as DocType } from '../types';
import { SectionCategory, SECTION_SHORT, SECTION_ORDER } from '../types';
import { getDocumentPreviewUrl } from '../api/client';

interface Props {
  documents: DocType[];
  reportId: number;
  onToggleInclude: (docId: number, included: boolean) => void;
  onReclassify: (docId: number, category: SectionCategory, subcategory?: string) => void;
}

type ExclusionGroup = 'compiled' | 'superseded' | 'manual' | 'other';

function categorizeReason(reasoning: string | null): ExclusionGroup {
  if (!reasoning) return 'other';
  const r = reasoning.toLowerCase();
  if (r.includes('compiled') || r.includes('appendix marker')) return 'compiled';
  if (r.includes('superseded') || r.includes('newer version')) return 'superseded';
  if (r.includes('manually')) return 'manual';
  return 'other';
}

const GROUP_LABELS: Record<ExclusionGroup, string> = {
  compiled: 'Compiled Reports',
  superseded: 'Older Versions',
  manual: 'Manually Excluded',
  other: 'Other',
};

export function ExcludedPanel({ documents, reportId, onToggleInclude, onReclassify }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<DocType | null>(null);
  const [reincludeSection, setReincludeSection] = useState<SectionCategory>(SectionCategory.UNCLASSIFIED);

  const groups = useMemo(() => {
    const result: Record<ExclusionGroup, DocType[]> = {
      compiled: [], superseded: [], manual: [], other: [],
    };
    for (const doc of documents) {
      result[categorizeReason(doc.reasoning)].push(doc);
    }
    return result;
  }, [documents]);

  if (documents.length === 0) return null;

  const nonEmptyGroups = (Object.entries(groups) as [ExclusionGroup, DocType[]][])
    .filter(([, docs]) => docs.length > 0);

  return (
    <>
      <div className="border border-amber-200 rounded-lg overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-between px-4 py-2 bg-amber-50 hover:bg-amber-100 transition text-left"
        >
          <div className="flex items-center gap-2">
            <ChevronDown
              size={16}
              className={`text-amber-400 transition-transform ${expanded ? '' : '-rotate-90'}`}
            />
            <span className="text-sm font-medium text-amber-800">
              Excluded ({documents.length})
            </span>
          </div>
        </button>

        {expanded && (
          <div className="p-2 space-y-2 bg-amber-50/30">
            {nonEmptyGroups.map(([group, docs]) => (
              <div key={group}>
                <div className="text-[11px] font-medium text-amber-600 uppercase tracking-wide px-2 py-1">
                  {GROUP_LABELS[group]} ({docs.length})
                </div>
                <div className="space-y-0.5">
                  {docs.map(doc => (
                    <div
                      key={doc.id}
                      className="flex items-start gap-2 px-2 py-1.5 rounded text-sm hover:bg-amber-50 transition"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-gray-600 truncate" title={doc.original_filename}>
                          {doc.original_filename}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {doc.reasoning && (
                            <p className="text-xs text-amber-600 truncate" title={doc.reasoning}>
                              {doc.reasoning}
                            </p>
                          )}
                          {doc.page_count != null && (
                            <span className="text-[10px] text-gray-400 shrink-0">{doc.page_count}p</span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center gap-1">
                        <button
                          onClick={() => {
                            setPreviewDoc(doc);
                            setReincludeSection(doc.category as SectionCategory || SectionCategory.UNCLASSIFIED);
                          }}
                          className="p-1 text-amber-500 hover:text-amber-700 hover:bg-amber-100 rounded transition"
                          title="Preview document"
                        >
                          <Eye size={13} />
                        </button>
                        <button
                          onClick={() => onToggleInclude(doc.id, true)}
                          className="flex items-center gap-1 text-xs text-amber-700 hover:text-amber-900 bg-amber-100 hover:bg-amber-200 px-2 py-1 rounded transition"
                        >
                          <RotateCcw size={10} /> Include
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Preview Modal */}
      {previewDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl flex flex-col w-[90vw] h-[85vh] max-w-5xl overflow-hidden">
            {/* Modal header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-gray-50 shrink-0">
              <div className="min-w-0">
                <p className="font-medium text-gray-800 truncate text-sm" title={previewDoc.original_filename}>
                  {previewDoc.original_filename}
                </p>
                {previewDoc.reasoning && (
                  <p className="text-xs text-amber-600 truncate mt-0.5">{previewDoc.reasoning}</p>
                )}
              </div>
              <button
                onClick={() => setPreviewDoc(null)}
                className="p-1.5 hover:bg-gray-200 rounded transition shrink-0 ml-3"
              >
                <X size={18} className="text-gray-500" />
              </button>
            </div>

            {/* PDF iframe */}
            <iframe
              src={getDocumentPreviewUrl(reportId, previewDoc.id)}
              className="w-full flex-1 border-0"
              title={`Preview: ${previewDoc.original_filename}`}
            />

            {/* Modal footer */}
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-gray-200 bg-gray-50 shrink-0">
              <button
                onClick={() => setPreviewDoc(null)}
                className="text-sm text-gray-600 hover:text-gray-800 px-3 py-1.5 rounded hover:bg-gray-100 transition"
              >
                Keep excluded
              </button>

              <div className="flex items-center gap-2">
                <select
                  value={reincludeSection}
                  onChange={e => setReincludeSection(e.target.value as SectionCategory)}
                  className="text-xs border border-gray-300 rounded px-2 py-1.5 bg-white"
                >
                  {SECTION_ORDER.filter(s => s !== SectionCategory.UNCLASSIFIED).map(cat => (
                    <option key={cat} value={cat}>{SECTION_SHORT[cat]}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    if (reincludeSection !== previewDoc.category) {
                      onReclassify(previewDoc.id, reincludeSection);
                    }
                    onToggleInclude(previewDoc.id, true);
                    setPreviewDoc(null);
                  }}
                  className="flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-700 transition font-medium"
                >
                  <RotateCcw size={13} /> Re-include
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
