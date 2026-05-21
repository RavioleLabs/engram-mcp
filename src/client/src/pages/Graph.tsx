// src/client/src/pages/Graph.tsx
import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { GraphCanvas } from '../components/GraphCanvas.js';
import { NodePreviewPanel } from '../components/NodePreviewPanel.js';

// GraphNode and GraphEdge are defined here and re-exported so components can import from this file
export interface GraphNode {
  id: string;
  type: string;
  title: string;
  snippet: string;
  createdAt: number;
  tags: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  label: 'wikilink' | 'semantic';
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const VIEWS_KEY = 'engram-graph-positions';

function loadSavedPositions(): Record<string, { x: number; y: number }> | undefined {
  try {
    const raw = localStorage.getItem(VIEWS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, { x: number; y: number }>) : undefined;
  } catch {
    return undefined;
  }
}

function savePositions(positions: Record<string, { x: number; y: number }>) {
  try {
    localStorage.setItem(VIEWS_KEY, JSON.stringify(positions));
  } catch {
    // storage quota — ignore
  }
}

export default function Graph() {
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }> | undefined
  >(loadSavedPositions);

  const { data, isLoading, error } = useQuery<GraphData>({
    queryKey: ['graph', typeFilter],
    queryFn: () => api.graph(typeFilter ? { type: typeFilter } : {}) as Promise<GraphData>,
    staleTime: 60_000,
  });

  const handlePositionsChange = useCallback(
    (p: Record<string, { x: number; y: number }>) => {
      setPositions(p);
      savePositions(p);
    },
    [],
  );

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, []);

  const handleSearch = useCallback((query: string) => {
    // navigate to /search with query pre-filled
    window.location.href = `/search?q=${encodeURIComponent(query)}`;
  }, []);

  const types = data
    ? [...new Set(data.nodes.map((n) => n.type))].sort()
    : [];

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 flex-shrink-0">
        <h1 className="font-semibold text-sm text-white">Graph</h1>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="text-xs bg-zinc-800 text-zinc-300 rounded px-2 py-1 border border-zinc-700"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {data && (
          <span className="text-xs text-zinc-500 ml-auto">
            {data.nodes.length} nodes · {data.edges.length} edges
          </span>
        )}
        <button
          onClick={() => {
            localStorage.removeItem(VIEWS_KEY);
            setPositions(undefined);
            window.location.reload();
          }}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          Reset layout
        </button>
      </div>

      {/* Canvas + Panel */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 relative">
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm">
              Loading graph…
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-red-400 text-sm">
              Failed to load graph data.
            </div>
          )}
          {data && (
            <GraphCanvas
              data={data}
              onNodeClick={handleNodeClick}
              savedPositions={positions}
              onPositionsChange={handlePositionsChange}
            />
          )}
        </div>
        <NodePreviewPanel
          node={selectedNode}
          onClose={() => setSelectedNode(null)}
          onSearch={handleSearch}
        />
      </div>
    </div>
  );
}
