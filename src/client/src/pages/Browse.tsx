// src/client/src/pages/Browse.tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { MemoryCard } from '../components/MemoryCard.js';

export default function Browse() {
  const types = useQuery({ queryKey: ['types'], queryFn: () => api.listTypes() });
  const [type, setType] = useState<string | undefined>(undefined);
  const memories = useQuery({
    queryKey: ['memories', type],
    queryFn: () => api.listMemories({ type, limit: 100 }),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Browse</h1>
      <div className="flex gap-2 flex-wrap">
        <button
          className={pill(type === undefined)}
          onClick={() => setType(undefined)}
        >
          All
        </button>
        {types.data?.map((t) => (
          <button key={t.id} className={pill(type === t.id)} onClick={() => setType(t.id)}>
            {t.display_name}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {memories.data?.map((m) => <MemoryCard key={m.id} memory={m} />)}
      </div>
    </div>
  );
}

function pill(active: boolean): string {
  return `px-3 py-1 rounded ${active ? 'bg-blue-500 text-white' : 'bg-zinc-800 text-zinc-300'}`;
}
