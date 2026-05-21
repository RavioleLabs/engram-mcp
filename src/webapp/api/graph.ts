// src/webapp/api/graph.ts
import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { createLogger } from '../../logger.js';
import type { MemoryStore } from '../../memory/core/store.js';

const log = createLogger('api:graph');

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

/**
 * @param store Optional — when provided, enables private semantic-edge augmentation
 *              if `store.algorithms.graphSemanticEdges` is loaded.
 */
export function graphApi(store?: MemoryStore): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    try {
      const typeFilter = typeof req.query.type === 'string' ? req.query.type : null;
      const limit = Math.min(
        Number(req.query.limit) || 300,
        500, // hard cap — graph becomes unusable beyond this
      );

      const db = getDb();

      // 1. Fetch memories
      const rows = (
        typeFilter
          ? db
              .prepare(
                `SELECT id, type, content, properties_json, wikilinks_json, created_at
                 FROM memories WHERE type = ? ORDER BY created_at DESC LIMIT ?`,
              )
              .all(typeFilter, limit)
          : db
              .prepare(
                `SELECT id, type, content, properties_json, wikilinks_json, created_at
                 FROM memories ORDER BY created_at DESC LIMIT ?`,
              )
              .all(limit)
      ) as Array<{
        id: string;
        type: string;
        content: string;
        properties_json: string;
        wikilinks_json: string;
        created_at: number;
      }>;

      const idSet = new Set(rows.map((r) => r.id));

      // 2. Build nodes
      const nodes: GraphNode[] = rows.map((row) => {
        const props = JSON.parse(row.properties_json || '{}') as {
          title?: string;
          tags?: string[];
        };
        const snippet = row.content.slice(0, 180).replace(/\n/g, ' ');
        return {
          id: row.id,
          type: row.type,
          title: props.title ?? snippet.slice(0, 60),
          snippet,
          createdAt: row.created_at,
          tags: props.tags ?? [],
        };
      });

      // 3. Wikilink edges (OSS basic)
      const edges: GraphEdge[] = [];
      for (const row of rows) {
        let wikilinks: string[] = [];
        try {
          wikilinks = JSON.parse(row.wikilinks_json || '[]') as string[];
        } catch {
          // malformed — skip
        }
        for (const targetId of wikilinks) {
          if (idSet.has(targetId) && targetId !== row.id) {
            edges.push({ source: row.id, target: targetId, label: 'wikilink', weight: 1 });
          }
        }
      }

      // 4. Semantic edges — private smart version if loaded
      // OSS basic: wikilinks only (see comment above).
      // Private: computes pairwise cosine similarity for up to 50 nodes, adds edges with cosine > 0.7.
      if (store?.algorithms.graphSemanticEdges) {
        try {
          const nodeIds = nodes.slice(0, 50).map((n) => n.id);
          const semanticEdges = await store.algorithms.graphSemanticEdges(store, nodeIds);
          edges.push(...semanticEdges);
        } catch (e) {
          log.warn(`graphSemanticEdges failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const data: GraphData = { nodes, edges };
      res.json(data);
    } catch (e) {
      log.error(`GET /api/graph error: ${e instanceof Error ? e.message : String(e)}`);
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  return r;
}
