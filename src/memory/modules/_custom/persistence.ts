// src/memory/modules/_custom/persistence.ts
import { getDb } from '../../../db/index.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('custom:persistence');

export interface CustomTypeDefinition {
  type_name: string; // e.g. 'recipes' (lowercase, snake_case)
  display_name: string; // e.g. 'Recipes'
  schema_json: string | null; // optional Zod-like JSON schema for properties.custom
  created_at: number;
}

const TYPE_NAME_RE = /^[a-z][a-z0-9_]{0,30}$/;

const RESERVED_NAMES = [
  'notes',
  'conversations',
  'drive',
  'notion',
  'youtube',
  'audio',
  'obsidian',
];

export function validateTypeName(name: string): void {
  if (!TYPE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid type name "${name}". Must be lowercase, start with a letter, max 31 chars, [a-z0-9_].`,
    );
  }
  if (RESERVED_NAMES.includes(name)) {
    throw new Error(`Type name "${name}" is reserved.`);
  }
}

export function createCustomType(input: {
  type_name: string;
  display_name: string;
  schema?: object;
}): CustomTypeDefinition {
  validateTypeName(input.type_name);
  const def: CustomTypeDefinition = {
    type_name: input.type_name,
    display_name: input.display_name,
    schema_json: input.schema ? JSON.stringify(input.schema) : null,
    created_at: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO custom_types (type_name, display_name, schema_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(def.type_name, def.display_name, def.schema_json, def.created_at);
  log.info(`Registered custom type: ${def.type_name}`);
  return def;
}

export function listCustomTypes(): CustomTypeDefinition[] {
  return getDb()
    .prepare(
      `SELECT type_name, display_name, schema_json, created_at FROM custom_types ORDER BY type_name`,
    )
    .all() as CustomTypeDefinition[];
}

export function deleteCustomType(typeName: string): void {
  getDb().prepare('DELETE FROM custom_types WHERE type_name = ?').run(typeName);
  log.info(`Deleted custom type: ${typeName}`);
}
