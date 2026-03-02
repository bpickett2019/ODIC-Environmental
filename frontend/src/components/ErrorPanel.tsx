import { useState } from 'react';
import { ChevronDown, Loader2, Wrench } from 'lucide-react';
import type { Document as DocType } from '../types';

interface Props {
  documents: DocType[];
  onRetryAll: () => Promise<void>;
}

export function ErrorPanel({ documents, onRetryAll }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);

  if (documents.length === 0) return null;

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await onRetryAll();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="border border-red-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2 bg-red-50 hover:bg-red-100 transition text-left"
      >
        <div className="flex items-center gap-2">
          <ChevronDown
            size={16}
            className={`text-red-400 transition-transform ${expanded ? '' : '-rotate-90'}`}
          />
          <span className="text-sm font-medium text-red-800">
            Errors ({documents.length})
          </span>
        </div>
        <button
          onClick={e => { e.stopPropagation(); handleRetry(); }}
          disabled={retrying}
          className="flex items-center gap-1 text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700 disabled:opacity-50 transition"
        >
          {retrying ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
          Retry All
        </button>
      </button>

      {expanded && (
        <div className="p-2 space-y-1 bg-red-50/30">
          {documents.map(doc => (
            <div
              key={doc.id}
              className="px-2 py-1.5 text-sm"
            >
              <p className="text-gray-600 truncate" title={doc.original_filename}>
                {doc.original_filename}
              </p>
              {doc.reasoning && (
                <p className="text-xs text-red-500 truncate mt-0.5" title={doc.reasoning}>
                  {doc.reasoning}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
