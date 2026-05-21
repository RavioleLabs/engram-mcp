// src/client/src/components/NodePreviewPanel.tsx
import type { GraphNode } from '../pages/Graph.js';

interface Props {
  node: GraphNode | null;
  onClose: () => void;
  onSearch: (query: string) => void;
}

export function NodePreviewPanel({ node, onClose, onSearch }: Props) {
  if (!node) return null;

  const date = new Date(node.createdAt).toLocaleDateString();

  return (
    <aside className="w-72 flex-shrink-0 bg-zinc-900 border-l border-zinc-800 p-4 space-y-3 overflow-y-auto">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
          {node.type}
        </span>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-sm">
          ✕
        </button>
      </div>
      <h3 className="font-semibold text-sm text-white leading-snug">{node.title}</h3>
      <p className="text-xs text-zinc-400 leading-relaxed">{node.snippet}</p>
      {node.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {node.tags.map((t) => (
            <span key={t} className="text-xs bg-zinc-800 text-zinc-300 px-1.5 py-0.5 rounded">
              {t}
            </span>
          ))}
        </div>
      )}
      <p className="text-xs text-zinc-600">{date}</p>
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onSearch(node.title)}
          className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded"
        >
          Search related
        </button>
      </div>
    </aside>
  );
}
