// src/client/src/components/MemoryCard.tsx
import type { MemoryRow } from '../api.js';

export function MemoryCard({ memory }: { memory: MemoryRow }) {
  const date = new Date(memory.created_at).toLocaleString();
  return (
    <div className="p-4 border border-zinc-800 rounded-lg hover:bg-zinc-900 cursor-pointer">
      <div className="flex justify-between text-xs text-zinc-500 mb-1">
        <span className="uppercase">{memory.type}</span>
        <span>{date}</span>
      </div>
      {memory.properties.title && (
        <h3 className="font-medium mb-1">{memory.properties.title}</h3>
      )}
      <p className="text-sm text-zinc-300">{memory.content_preview}</p>
      {memory.properties.tags && memory.properties.tags.length > 0 && (
        <div className="mt-2 flex gap-1 flex-wrap">
          {memory.properties.tags.map((t) => (
            <span key={t} className="text-xs px-2 py-0.5 bg-zinc-800 rounded">
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
