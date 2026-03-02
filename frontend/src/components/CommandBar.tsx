import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2, Undo2, ChevronDown, ChevronUp } from 'lucide-react';
import { useReportStore } from '../stores/reportStore';
import * as api from '../api/client';
import type { ChatResponse } from '../types';

interface Props {
  reportId: number;
  onDocChanged: () => void;
}

export function CommandBar({ reportId, onDocChanged }: Props) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastResponse, setLastResponse] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<{ role: string; content: string }[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<{ response: ChatResponse; message: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { fetchDocuments, assembleReport, compressReport } = useReportStore();

  // Cmd+K / Ctrl+K focus shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Load suggestions on mount and after actions
  const loadSuggestions = useCallback(async () => {
    try {
      const result = await api.getChatSuggestions(reportId);
      setSuggestions(result.suggestions || []);
    } catch {
      // Non-critical
    }
  }, [reportId]);

  useEffect(() => {
    loadSuggestions();
  }, [loadSuggestions]);

  const handleSend = async (message?: string) => {
    const msg = message || input.trim();
    if (!msg || loading) return;

    setInput('');
    setLoading(true);
    setConfirmation(null);

    try {
      const response = await api.sendChatMessage(reportId, msg, history);

      // Update history
      setHistory(prev => [
        ...prev,
        { role: 'user', content: msg },
        { role: 'assistant', content: response.message },
      ]);

      setLastResponse(response.message);

      if (response.needs_confirmation) {
        setConfirmation({ response, message: msg });
        setLoading(false);
        return;
      }

      // Handle deferred actions
      for (const result of response.results) {
        if (result.deferred) {
          if (result.action === 'assemble') {
            await assembleReport(reportId);
          } else if (result.action === 'compress') {
            const quality = (result.params as any)?.quality || 'standard';
            await compressReport(reportId, quality);
          }
        }
      }

      // Refresh documents after mutation actions
      const hasMutations = response.actions.some(a =>
        ['move', 'exclude', 'include'].includes(a.action)
      );
      if (hasMutations) {
        await fetchDocuments(reportId);
        onDocChanged();
      }

      loadSuggestions();
    } catch (e: any) {
      setLastResponse(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!confirmation) return;
    setLoading(true);
    setConfirmation(null);

    try {
      // Re-send with confirmation flag (the backend will execute this time)
      const response = await api.sendChatMessage(
        reportId,
        `CONFIRMED: ${confirmation.message}`,
        history,
      );
      setLastResponse(response.message);
      await fetchDocuments(reportId);
      onDocChanged();
      loadSuggestions();
    } catch (e: any) {
      setLastResponse(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleUndo = async () => {
    setLoading(true);
    try {
      const result = await api.undoChatAction(reportId);
      setLastResponse(
        result.status === 'ok'
          ? `Undone — restored ${result.restored} documents`
          : 'Nothing to undo',
      );
      await fetchDocuments(reportId);
      onDocChanged();
      loadSuggestions();
    } catch (e: any) {
      setLastResponse(`Undo failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="bg-white border-b border-gray-200 px-4 py-2 shrink-0">
      {/* Last response */}
      {lastResponse && (
        <div className="mb-1.5">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 w-full text-left"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <span className={expanded ? '' : 'truncate'}>{lastResponse}</span>
          </button>
          {expanded && history.length > 2 && (
            <div className="mt-1 max-h-32 overflow-y-auto text-xs text-gray-400 space-y-1 pl-4">
              {history.slice(0, -2).map((msg, i) => (
                <div key={i} className={msg.role === 'user' ? 'text-blue-500' : 'text-gray-500'}>
                  {msg.role === 'user' ? '> ' : ''}{msg.content}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Confirmation dialog */}
      {confirmation && (
        <div className="mb-2 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 flex items-center justify-between">
          <span className="text-xs text-amber-700">
            This will affect {confirmation.response.affected_count} documents. Continue?
          </span>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              className="text-xs bg-amber-600 text-white px-2 py-1 rounded hover:bg-amber-700"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmation(null)}
              className="text-xs text-amber-600 hover:text-amber-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleUndo}
          disabled={loading}
          className="p-1.5 text-gray-400 hover:text-gray-600 disabled:opacity-50 transition shrink-0"
          title="Undo last action"
        >
          <Undo2 size={16} />
        </button>

        <div className="flex-1 relative">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Tell me what to do... (⌘K)"
            disabled={loading}
            className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none disabled:bg-gray-50 pr-10"
          />
          {loading && (
            <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-blue-500" />
          )}
        </div>

        <button
          onClick={() => handleSend()}
          disabled={loading || !input.trim()}
          className="bg-blue-600 text-white p-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition shrink-0"
        >
          <Send size={16} />
        </button>
      </div>

      {/* Suggestion chips */}
      {suggestions.length > 0 && !loading && (
        <div className="flex gap-1.5 mt-1.5 flex-wrap">
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => handleSend(s)}
              className="text-[11px] px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full hover:bg-blue-50 hover:text-blue-600 transition"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
