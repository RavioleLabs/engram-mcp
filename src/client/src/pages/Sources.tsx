// src/client/src/pages/Sources.tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

export default function Sources() {
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.listSources() });

  const connect = (tool: 'connect_drive' | 'connect_notion') =>
    api.callMcpTool(tool, {}).then((r) => {
      if ((r as { auth_url?: string }).auth_url)
        window.open((r as { auth_url: string }).auth_url, '_blank');
      qc.invalidateQueries({ queryKey: ['sources'] });
    });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeSource(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources'] }),
  });

  // YouTube playlist import state
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(
    null,
  );

  async function handleImportPlaylist() {
    setImporting(true);
    setImportResult(null);
    try {
      const r = await fetch('/api/sources/youtube/import-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlistUrl }),
      });
      const result = (await r.json()) as { imported: number; skipped: number };
      setImportResult(result);
      setPlaylistUrl('');
    } catch (e) {
      alert(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Sources</h1>

      <div className="flex gap-2">
        <button
          className="px-4 py-2 bg-blue-500 text-white rounded"
          onClick={() => connect('connect_drive')}
        >
          Connect Google Drive
        </button>
        <button
          className="px-4 py-2 bg-blue-500 text-white rounded"
          onClick={() => connect('connect_notion')}
        >
          Connect Notion
        </button>
      </div>

      <table className="w-full text-sm">
        <thead className="text-xs text-zinc-500 uppercase">
          <tr>
            <th className="text-left p-2">Module</th>
            <th className="text-left p-2">Name</th>
            <th className="text-left p-2">Last sync</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sources.data?.map((s) => (
            <tr key={s.id} className="border-t border-zinc-800">
              <td className="p-2">{s.module_id}</td>
              <td className="p-2">{s.display_name}</td>
              <td className="p-2 text-zinc-500">
                {s.last_synced_at ? new Date(s.last_synced_at).toLocaleString() : 'never'}
              </td>
              <td className="p-2 text-right">
                <button
                  className="text-xs text-red-400 hover:text-red-300"
                  onClick={() => remove.mutate(s.id)}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* YouTube — Playlist Import */}
      <section className="border border-zinc-800 rounded-lg p-4 space-y-3">
        <h2 className="font-semibold text-sm text-white">YouTube — Import Playlist</h2>
        <p className="text-xs text-zinc-400">
          Paste a public YouTube playlist URL (e.g. Watch Later — must be set to Public
          temporarily). Videos already ingested will be skipped.
        </p>
        <div className="flex gap-2">
          <input
            type="url"
            placeholder="https://www.youtube.com/playlist?list=..."
            value={playlistUrl}
            onChange={(e) => setPlaylistUrl(e.target.value)}
            className="flex-1 text-xs bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 placeholder-zinc-600"
          />
          <button
            onClick={() => { void handleImportPlaylist(); }}
            disabled={!playlistUrl || importing}
            className="text-xs px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white rounded"
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
        {importResult && (
          <p className="text-xs text-zinc-400">
            Imported {importResult.imported} videos. {importResult.skipped} skipped.
          </p>
        )}
      </section>
    </div>
  );
}
