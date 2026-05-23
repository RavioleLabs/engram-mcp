// src/client/src/components/CommandPalette.tsx
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'capture' | 'search'>('capture');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      if (mode === 'capture') {
        await api.callMcpTool('add_note', { content: text });
        qc.invalidateQueries({ queryKey: ['recent'] });
        qc.invalidateQueries({ queryKey: ['memories'] });
      } else {
        // Navigate to /search with q param
        window.location.href = `/search?q=${encodeURIComponent(text)}`;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center pt-32 z-50"
      onClick={onClose}
    >
      <div
        className="w-2/3 max-w-2xl bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-2 mb-3">
          <button
            className={`px-3 py-1 rounded text-sm ${
              mode === 'capture' ? 'bg-blue-500 text-white' : 'bg-zinc-800'
            }`}
            onClick={() => setMode('capture')}
          >
            Quick capture (Note)
          </button>
          <button
            className={`px-3 py-1 rounded text-sm ${
              mode === 'search' ? 'bg-blue-500 text-white' : 'bg-zinc-800'
            }`}
            onClick={() => setMode('search')}
          >
            Search
          </button>
        </div>
        <textarea
          autoFocus
          rows={mode === 'capture' ? 4 : 1}
          className="w-full bg-zinc-950 border border-zinc-800 rounded p-3 text-sm"
          placeholder={mode === 'capture' ? 'Capture a thought… (Cmd+Enter to save)' : 'Search…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
          }}
        />
        <div className="flex justify-end mt-3 gap-2">
          <button className="text-sm text-zinc-400" onClick={onClose}>
            Cancel (Esc)
          </button>
          <button
            className="px-4 py-2 bg-blue-500 text-white rounded text-sm disabled:opacity-50"
            disabled={busy || !text.trim()}
            onClick={() => void submit()}
          >
            {mode === 'capture' ? 'Save (⌘↵)' : 'Search'}
          </button>
        </div>
      </div>
    </div>
  );
}
