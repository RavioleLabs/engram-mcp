// src/webapp/api/types.ts
import { Router } from 'express';
import { moduleRegistry } from '../../memory/core/module-registry.js';
import { listCustomTypes } from '../../memory/modules/_custom/persistence.js';

export function typesApi(): Router {
  const r = Router();
  r.get('/', (_req, res) => {
    const builtins = moduleRegistry.list()
      .filter((m) => !m.isCustom)
      .map((m) => ({ id: m.id, display_name: m.displayName, is_custom: false }));
    const customs = listCustomTypes().map((d) => ({
      id: d.type_name,
      display_name: d.display_name,
      is_custom: true,
    }));
    res.json([...builtins, ...customs]);
  });
  return r;
}
