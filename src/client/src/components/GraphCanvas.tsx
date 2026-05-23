// src/client/src/components/GraphCanvas.tsx
import { useEffect, useRef } from 'react';
import cytoscape from 'cytoscape';
// @ts-expect-error — fcose has no own type declaration; types come from @types/cytoscape extensions
import fcose from 'cytoscape-fcose';
import type { GraphNode, GraphEdge } from '../pages/Graph.js';

cytoscape.use(fcose);

const TYPE_COLORS: Record<string, string> = {
  notes: '#6366f1',
  conversations: '#10b981',
  youtube: '#ef4444',
  drive: '#3b82f6',
  notion: '#f97316',
  audio: '#8b5cf6',
  default: '#71717a',
};

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface Props {
  data: GraphData;
  onNodeClick: (node: GraphNode) => void;
  savedPositions?: Record<string, { x: number; y: number }>;
  onPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void;
}

export function GraphCanvas({ data, onNodeClick, savedPositions, onPositionsChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const elements: cytoscape.ElementDefinition[] = [
      ...data.nodes.map((n) => ({
        data: {
          id: n.id,
          label: n.title.slice(0, 30),
          type: n.type,
          payload: n,
        },
        position: savedPositions?.[n.id],
      })),
      ...data.edges.map((e, i) => ({
        data: {
          id: `e-${i}`,
          source: e.source,
          target: e.target,
          label: e.label,
          weight: e.weight,
        },
      })),
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': (ele: cytoscape.NodeSingular) =>
              (TYPE_COLORS[ele.data('type') as string] ?? TYPE_COLORS.default) as string,
            label: 'data(label)',
            'font-size': '10px',
            color: '#e4e4e7',
            'text-valign': 'bottom',
            'text-margin-y': 4,
            width: 28,
            height: 28,
          },
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 3,
            'border-color': '#fbbf24',
          },
        },
        {
          selector: 'edge[label = "wikilink"]',
          style: {
            'line-color': '#6366f1',
            'target-arrow-color': '#6366f1',
            'target-arrow-shape': 'triangle',
            width: 2,
            'curve-style': 'bezier',
          },
        },
        {
          selector: 'edge[label = "semantic"]',
          style: {
            'line-color': '#52525b',
            'line-style': 'dashed',
            width: 1,
            'curve-style': 'bezier',
          },
        },
      ],
      layout: savedPositions
        ? { name: 'preset' }
        : ({
            name: 'fcose',
            animate: true,
            animationDuration: 600,
            randomize: false,
            nodeRepulsion: 4500,
            idealEdgeLength: 100,
          } as cytoscape.LayoutOptions),
    });

    // Node click → preview panel
    cy.on('tap', 'node', (evt) => {
      const node = evt.target.data('payload') as GraphNode;
      onNodeClick(node);
    });

    // Persist layout positions on drag (debounced 2s)
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    cy.on('dragfree', 'node', () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!onPositionsChange) return;
        const positions: Record<string, { x: number; y: number }> = {};
        cy.nodes().forEach((n) => {
          positions[n.id()] = n.position();
        });
        onPositionsChange(positions);
      }, 2000);
    });

    cyRef.current = cy;
    return () => {
      if (saveTimer) clearTimeout(saveTimer);
      cy.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return <div ref={containerRef} className="w-full h-full bg-zinc-950 rounded-lg" />;
}
