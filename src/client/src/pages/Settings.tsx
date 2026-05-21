// src/client/src/pages/Settings.tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { api } from '../api.js';

export default function Settings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.getSettings() });
  const [theme, setTheme] = useState<string>('dark');

  useEffect(() => {
    if (settings.data?.theme) setTheme(settings.data.theme as string);
  }, [settings.data?.theme]);

  const save = useMutation({
    mutationFn: (kv: { key: string; value: unknown }) => api.setSetting(kv.key, kv.value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  return (
    <div className="space-y-6 max-w-xl">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="space-y-2">
        <label className="block text-sm">Theme</label>
        <select
          className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded"
          value={theme}
          onChange={(e) => {
            setTheme(e.target.value);
            save.mutate({ key: 'theme', value: e.target.value });
          }}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>
      <div>
        <pre className="text-xs text-zinc-500 bg-zinc-900 p-3 rounded">
          {JSON.stringify(settings.data ?? {}, null, 2)}
        </pre>
      </div>
      <section className="space-y-2 border-t border-zinc-800 pt-4">
        <h2 className="text-lg">Reindex</h2>
        <p className="text-sm text-zinc-500">
          If you changed the embedding provider/model, click this to rebuild the vector index for all stored memories. This may take several minutes for large memory stores.
        </p>
        <button
          className="px-4 py-2 bg-orange-500 text-white rounded"
          onClick={async () => {
            const ok = window.confirm('Reindex all memories now? This rebuilds the vector store.');
            if (!ok) return;
            const r = await api.reindex();
            alert(`Reindexed ${r.total} memories across ${r.types?.length} types.`);
          }}
        >
          Reindex all memories
        </button>
      </section>
    </div>
  );
}
