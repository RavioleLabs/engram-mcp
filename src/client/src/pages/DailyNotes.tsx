// src/client/src/pages/DailyNotes.tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { MemoryCard } from '../components/MemoryCard.js';

export default function DailyNotes() {
  const [day, setDay] = useState<string | null>(null);
  const buckets = useQuery({ queryKey: ['daily', 30], queryFn: () => api.dailyBuckets(30) });
  const items = useQuery({
    queryKey: ['daily-items', day],
    queryFn: () => (day ? api.dailyItems(day) : Promise.resolve([])),
    enabled: !!day,
  });

  const byDay = new Map<string, Array<{ type: string; count: number }>>();
  for (const b of buckets.data ?? []) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day)!.push({ type: b.type, count: b.count });
  }

  return (
    <div className="grid grid-cols-3 gap-6">
      <aside className="space-y-1">
        <h2 className="font-medium mb-2">Last 30 days</h2>
        {[...byDay.entries()].map(([d, types]) => (
          <button
            key={d}
            onClick={() => setDay(d)}
            className={`block w-full text-left px-3 py-2 rounded ${day === d ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}
          >
            <div className="text-sm">{d}</div>
            <div className="text-xs text-zinc-500">
              {types.map((t) => `${t.type}:${t.count}`).join(' · ')}
            </div>
          </button>
        ))}
      </aside>
      <section className="col-span-2 space-y-2">
        {day ? (
          <>
            <h1 className="text-xl font-semibold">{day}</h1>
            {items.data?.map((m) => <MemoryCard key={m.id} memory={m} />)}
          </>
        ) : (
          <p className="text-zinc-500">Select a day to view its memories.</p>
        )}
      </section>
    </div>
  );
}
