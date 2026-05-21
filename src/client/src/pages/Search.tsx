// src/client/src/pages/Search.tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';

export default function Search() {
  const [q, setQ] = useState('');
  const [type, setType] = useState<string>('');
  const results = useQuery({
    queryKey: ['search', q, type],
    queryFn: () => api.searchMemories(q, type || undefined, 25),
    enabled: q.length > 0,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Search</h1>
      <div className="flex gap-2">
        <input
          autoFocus
          className="flex-1 px-4 py-2 bg-zinc-900 border border-zinc-800 rounded"
          placeholder="Search across all memories…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <input
          className="w-40 px-3 py-2 bg-zinc-900 border border-zinc-800 rounded"
          placeholder="Filter type (optional)"
          value={type}
          onChange={(e) => setType(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        {results.data?.map((r) => (
          <div key={r.id} className="p-4 border border-zinc-800 rounded">
            <div className="flex justify-between text-xs text-zinc-500">
              <span>{r.type}</span>
              <span>score: {r.score.toFixed(2)}</span>
            </div>
            {r.title && <h3 className="font-medium">{r.title}</h3>}
            <p className="text-sm text-zinc-300">{r.snippet}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
