import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Save, Loader2, Bold, Italic } from 'lucide-react';
import * as api from '../api/client';
import type { DocxParagraph, DocxRun } from '../types';

interface Props {
  reportId: number;
  docId: number;
  filename: string;
  onSaved: () => void;
  onClose: () => void;
}

export function DocxEditor({ reportId, docId, filename, onSaved, onClose }: Props) {
  const [paragraphs, setParagraphs] = useState<DocxParagraph[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const content = await api.getDocxContent(reportId, docId);
        if (cancelled) return;
        if (!content.is_docx) {
          setError('This document is not a DOCX file');
          setLoading(false);
          return;
        }
        setParagraphs(content.paragraphs);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reportId, docId]);

  const handleSave = useCallback(async () => {
    if (!editorRef.current) return;

    // Collect text from contentEditable divs
    const paraElements = editorRef.current.querySelectorAll('[data-para-idx]');
    const updated: DocxParagraph[] = paragraphs.map((p, i) => {
      const el = paraElements[i];
      if (!el) return p;

      const runEls = el.querySelectorAll('[data-run-idx]');
      if (runEls.length > 0 && runEls.length === p.runs.length) {
        const newRuns: DocxRun[] = p.runs.map((r, j) => ({
          ...r,
          text: runEls[j]?.textContent || '',
        }));
        return { ...p, text: newRuns.map(r => r.text).join(''), runs: newRuns };
      } else {
        // Single-run fallback
        const text = el.textContent || '';
        return { ...p, text, runs: [{ text, bold: null, italic: null }] };
      }
    });

    setSaving(true);
    setError(null);
    try {
      await api.saveDocxContent(reportId, docId, updated);
      setDirty(false);
      onSaved();
    } catch (e: any) {
      setError(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }, [reportId, docId, paragraphs, onSaved]);

  const handleInput = () => {
    if (!dirty) setDirty(true);
  };

  const execCommand = (cmd: string) => {
    document.execCommand(cmd);
    if (!dirty) setDirty(true);
  };

  if (loading) {
    return (
      <div className="absolute inset-0 bg-white z-30 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
        <span className="ml-2 text-sm text-gray-500">Loading document...</span>
      </div>
    );
  }

  if (error && paragraphs.length === 0) {
    return (
      <div className="absolute inset-0 bg-white z-30 flex flex-col items-center justify-center">
        <p className="text-red-500 text-sm mb-3">{error}</p>
        <button onClick={onClose} className="text-sm text-blue-600 hover:text-blue-800">Close</button>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 bg-white z-30 flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50 shrink-0">
        <span className="text-sm font-medium text-gray-700 truncate flex-1" title={filename}>
          Editing: {filename}
        </span>

        <button
          onClick={() => execCommand('bold')}
          className="p-1.5 rounded hover:bg-gray-200 text-gray-600 transition"
          title="Bold"
        >
          <Bold size={14} />
        </button>
        <button
          onClick={() => execCommand('italic')}
          className="p-1.5 rounded hover:bg-gray-200 text-gray-600 transition"
          title="Italic"
        >
          <Italic size={14} />
        </button>

        <span className="text-gray-300 mx-1">|</span>

        {error && <span className="text-xs text-red-500 mr-2">{error}</span>}

        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving...' : 'Save'}
        </button>

        <button
          onClick={onClose}
          className="p-1.5 rounded hover:bg-gray-200 text-gray-500 transition"
          title="Close editor"
        >
          <X size={16} />
        </button>
      </div>

      {/* Editor area */}
      <div className="flex-1 overflow-auto p-6">
        <div
          ref={editorRef}
          className="max-w-3xl mx-auto bg-white"
          onInput={handleInput}
        >
          {paragraphs.map((para, i) => {
            const isHeading = para.style?.startsWith('Heading');
            const baseClass = isHeading
              ? 'font-semibold text-lg mb-3'
              : 'mb-2 leading-relaxed';

            return (
              <div
                key={i}
                data-para-idx={i}
                contentEditable
                suppressContentEditableWarning
                className={`outline-none focus:bg-blue-50/30 rounded px-1 -mx-1 ${baseClass}`}
              >
                {para.runs.length > 0 ? (
                  para.runs.map((run, j) => (
                    <span
                      key={j}
                      data-run-idx={j}
                      className={`${run.bold ? 'font-bold' : ''} ${run.italic ? 'italic' : ''}`}
                    >
                      {run.text}
                    </span>
                  ))
                ) : (
                  <span>{para.text || '\u00A0'}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Status bar */}
      {saving && (
        <div className="shrink-0 px-4 py-2 bg-blue-50 border-t border-blue-100 text-xs text-blue-600 flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />
          Converting to PDF... this may take a few seconds
        </div>
      )}
    </div>
  );
}
