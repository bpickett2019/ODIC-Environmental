import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageCircle, Send, Loader2, Undo2, X, Minus } from 'lucide-react';
import { useReportStore } from '../stores/reportStore';
import * as api from '../api/client';
import type { ChatResponse } from '../types';

interface Props {
  reportId: number;
  onDocChanged: () => void;
}

interface Message {
  role: 'user' | 'assistant' | 'thinking';
  content: string;
}

export function ChatBubble({ reportId, onDocChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<{ response: ChatResponse; message: string } | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { fetchDocuments, assembleReport, compressReport } = useReportStore();

  // Cmd+K opens panel + focuses input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(true);
        setUnreadCount(0);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Load history on first open
  useEffect(() => {
    if (!open || historyLoaded) return;
    setHistoryLoaded(true);
    api.getChatHistory(reportId).then(history => {
      if (history.length > 0) {
        const loaded: Message[] = history.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
        setMessages(loaded);
      }
    }).catch(() => {});
  }, [open, historyLoaded, reportId]);

  // Reset history when reportId changes
  useEffect(() => {
    setMessages([]);
    setHistoryLoaded(false);
    setConfirmation(null);
    setSuggestions([]);
    setUnreadCount(0);
  }, [reportId]);

  // Load suggestions
  const loadSuggestions = useCallback(async () => {
    try {
      const result = await api.getChatSuggestions(reportId);
      setSuggestions(result.suggestions || []);
    } catch {}
  }, [reportId]);

  useEffect(() => {
    loadSuggestions();
  }, [loadSuggestions]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, confirmation]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setUnreadCount(0);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const handleSend = async (message?: string) => {
    const msg = message || input.trim();
    if (!msg || loading) return;

    setInput('');
    setLoading(true);
    setConfirmation(null);

    // Add user message + thinking indicator
    setMessages(prev => [...prev, { role: 'user', content: msg }, { role: 'thinking', content: '' }]);

    // Build history for API (exclude thinking messages)
    const apiHistory = messages
      .filter(m => m.role !== 'thinking')
      .map(m => ({ role: m.role, content: m.content }));

    try {
      const response = await api.sendChatMessage(reportId, msg, apiHistory);

      // Replace thinking with actual response
      setMessages(prev => [
        ...prev.filter(m => m.role !== 'thinking'),
        { role: 'assistant', content: response.message },
      ]);

      if (!open) setUnreadCount(c => c + 1);

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
      setMessages(prev => [
        ...prev.filter(m => m.role !== 'thinking'),
        { role: 'assistant', content: `Error: ${e.message}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!confirmation) return;
    setLoading(true);
    setConfirmation(null);
    setMessages(prev => [...prev, { role: 'thinking', content: '' }]);

    try {
      const response = await api.sendChatMessage(
        reportId,
        `CONFIRMED: ${confirmation.message}`,
        messages.filter(m => m.role !== 'thinking').map(m => ({ role: m.role, content: m.content })),
      );
      setMessages(prev => [
        ...prev.filter(m => m.role !== 'thinking'),
        { role: 'assistant', content: response.message },
      ]);
      await fetchDocuments(reportId);
      onDocChanged();
      loadSuggestions();
    } catch (e: any) {
      setMessages(prev => [
        ...prev.filter(m => m.role !== 'thinking'),
        { role: 'assistant', content: `Error: ${e.message}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleUndo = async () => {
    setLoading(true);
    try {
      const result = await api.undoChatAction(reportId);
      const msg = result.status === 'ok'
        ? `Undone — restored ${result.restored} documents`
        : 'Nothing to undo';
      setMessages(prev => [...prev, { role: 'assistant', content: msg }]);
      await fetchDocuments(reportId);
      onDocChanged();
      loadSuggestions();
    } catch (e: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Undo failed: ${e.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  // Collapsed: floating button
  if (!open) {
    return (
      <div className="fixed bottom-6 right-6 z-50">
        <button
          onClick={() => setOpen(true)}
          className="w-14 h-14 rounded-full bg-blue-600 text-white shadow-lg hover:bg-blue-700 hover:shadow-xl transition-all flex items-center justify-center"
          title="Report Assistant (Cmd+K)"
        >
          <MessageCircle size={24} />
        </button>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
            {unreadCount}
          </span>
        )}
      </div>
    );
  }

  // Expanded: chat panel
  return (
    <div
      className="fixed bottom-6 right-6 z-50 w-[400px] h-[520px] max-h-[80vh] flex flex-col bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200"
    >
      {/* Header */}
      <div className="bg-blue-600 text-white px-4 py-3 flex items-center justify-between shrink-0">
        <span className="font-semibold text-sm">Report Assistant</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setOpen(false)}
            className="p-1 hover:bg-blue-500 rounded transition"
            title="Minimize"
          >
            <Minus size={16} />
          </button>
          <button
            onClick={() => setOpen(false)}
            className="p-1 hover:bg-blue-500 rounded transition"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-gray-50">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 text-sm mt-8">
            <MessageCircle size={32} className="mx-auto mb-2 text-gray-300" />
            <p>Ask me to organize, classify, or assemble your report.</p>
            <p className="text-xs mt-1 text-gray-300">Try "assemble report" or "exclude duplicates"</p>
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.role === 'thinking') {
            return (
              <div key={i} className="flex justify-start">
                <div className="bg-gray-200 text-gray-500 px-3 py-2 rounded-2xl rounded-bl-sm max-w-[85%]">
                  <div className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            );
          }

          if (msg.role === 'user') {
            return (
              <div key={i} className="flex justify-end">
                <div className="bg-blue-600 text-white px-3 py-2 rounded-2xl rounded-br-sm max-w-[85%] text-sm">
                  {msg.content}
                </div>
              </div>
            );
          }

          return (
            <div key={i} className="flex justify-start">
              <div className="bg-white border border-gray-200 text-gray-700 px-3 py-2 rounded-2xl rounded-bl-sm max-w-[85%] text-sm shadow-sm">
                {msg.content}
              </div>
            </div>
          );
        })}

        {/* Inline confirmation card */}
        {confirmation && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
            <p className="text-xs text-amber-700 mb-2">
              This will affect {confirmation.response.affected_count} documents. Continue?
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleConfirm}
                className="text-xs bg-amber-600 text-white px-3 py-1 rounded-lg hover:bg-amber-700 transition"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmation(null)}
                className="text-xs text-amber-600 hover:text-amber-800 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && !loading && (
        <div className="px-3 py-1.5 border-t border-gray-100 bg-white flex gap-1.5 overflow-x-auto shrink-0">
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => handleSend(s)}
              className="text-[11px] px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full hover:bg-blue-50 hover:text-blue-600 transition whitespace-nowrap shrink-0"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="px-3 py-2.5 border-t border-gray-200 bg-white shrink-0">
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
              placeholder="Tell me what to do..."
              disabled={loading}
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none disabled:bg-gray-50 pr-10"
            />
            {loading && (
              <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-blue-500" />
            )}
          </div>

          <button
            onClick={() => handleSend()}
            disabled={loading || !input.trim()}
            className="bg-blue-600 text-white p-2 rounded-xl hover:bg-blue-700 disabled:opacity-50 transition shrink-0"
          >
            <Send size={16} />
          </button>
        </div>
        <p className="text-[10px] text-gray-300 mt-1 text-center">Enter to send · Esc to close · Cmd+K to open</p>
      </div>
    </div>
  );
}
