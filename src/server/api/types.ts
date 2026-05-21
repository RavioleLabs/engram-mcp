// src/webapp/api/types.ts
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { moduleRegistry } from '../../memory/core/module-registry.js';
import { listCustomTypes } from '../../memory/modules/_custom/persistence.js';
import { getDb } from '../../db/index.js';

// ── Disabled types persistence (uses the existing `settings` table) ──────────
//
// Key: 'disabled_types' → JSON array of type names that are hidden from default
// recall/list operations. Disabling a type does NOT delete its memories — they
// stay in the store, just grayed out in the visualization and excluded from
// `recall()` calls unless `include_disabled=true` is passed.

const DISABLED_TYPES_KEY = 'disabled_types';

function loadDisabledTypes(): Set<string> {
  const row = getDb()
    .prepare('SELECT value_json FROM settings WHERE key = ?')
    .get(DISABLED_TYPES_KEY) as { value_json: string } | undefined;
  if (!row) return new Set();
  try {
    const parsed = JSON.parse(row.value_json) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    /* fall through */
  }
  return new Set();
}

function saveDisabledTypes(disabled: Set<string>): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)',
    )
    .run(DISABLED_TYPES_KEY, JSON.stringify([...disabled]), Date.now());
}

function countMemoriesByType(): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT type, COUNT(*) as cnt FROM memories GROUP BY type')
    .all() as Array<{ type: string; cnt: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.type] = r.cnt;
  return out;
}

const PatchTypeBody = z.object({ disabled: z.boolean() });

export function typesApi(): Router {
  const r = Router();

  // GET /api/types — list every known type with counts + disabled flag
  r.get('/', (_req: Request, res: Response) => {
    const disabled = loadDisabledTypes();
    const counts = countMemoriesByType();

    const builtins = moduleRegistry
      .list()
      .filter((m) => !m.isCustom)
      .map((m) => ({
        id: m.id,
        display_name: m.displayName,
        is_custom: false,
        count: counts[m.id] ?? 0,
        disabled: disabled.has(m.id),
      }));

    const customs = listCustomTypes().map((d) => ({
      id: d.type_name,
      display_name: d.display_name,
      is_custom: true,
      count: counts[d.type_name] ?? 0,
      disabled: disabled.has(d.type_name),
    }));

    res.json([...builtins, ...customs]);
  });

  // GET /api/types/disabled — convenience: just the list of disabled type ids
  r.get('/disabled', (_req: Request, res: Response) => {
    res.json({ disabled: [...loadDisabledTypes()] });
  });

  // PATCH /api/types/:typeName  body: { disabled: boolean }
  //   Toggle a type's visibility in the dashboard / brain viz.
  //   No memories are deleted — the toggle is purely a UI/recall filter.
  r.patch('/:typeName', (req: Request, res: Response) => {
    const parsed = PatchTypeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
      return;
    }
    const typeNameParam = req.params.typeName;
    const typeName = Array.isArray(typeNameParam) ? typeNameParam[0] : typeNameParam;
    if (!typeName || typeof typeName !== 'string') {
      res.status(400).json({ error: 'type_name_required' });
      return;
    }
    const disabled = loadDisabledTypes();
    if (parsed.data.disabled) {
      disabled.add(typeName);
    } else {
      disabled.delete(typeName);
    }
    saveDisabledTypes(disabled);
    res.json({ id: typeName, disabled: parsed.data.disabled });
  });

  return r;
}

/**
 * Helper exported for `recall` and `list` callers — returns the set of type ids
 * the user wants HIDDEN from default queries.
 */
export function getDisabledTypes(): Set<string> {
  return loadDisabledTypes();
}
