// src/tests/fts.test.ts
// Unit tests for the FTS5 keyword path. No Ollama / LanceDB dependency.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb, getDb } from '../db/index.js';
import { buildFtsMatch, ftsSearchByType, ftsSearchAll } from '../memory/core/fts.js';

describe('fts.buildFtsMatch', () => {
  it('produces an OR-of-prefix expression for normal queries', () => {
    expect(buildFtsMatch('boulangerie fontaine 1850')).toBe(
      '"boulangerie"* OR "fontaine"* OR "1850"*',
    );
  });

  it('strips FTS5 special characters', () => {
    // " ( ) * : - + ^ are all reserved or have special meaning
    expect(buildFtsMatch('"hello" (world) *foo*')).toBe('"hello"* OR "world"* OR "foo"*');
  });

  it('drops 1-char tokens and FTS5 keywords', () => {
    expect(buildFtsMatch('a OR b AND foo NEAR not')).toBe('"foo"*');
  });

  it('returns null for empty / fully-stripped input', () => {
    expect(buildFtsMatch('')).toBeNull();
    expect(buildFtsMatch('   ')).toBeNull();
    expect(buildFtsMatch('()*"')).toBeNull();
  });

  it('preserves unicode tokens (accented French)', () => {
    expect(buildFtsMatch('réunion équipe')).toBe('"réunion"* OR "équipe"*');
  });
});

describe('fts.ftsSearchByType + ftsSearchAll', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-fts-'));
    initDb(tmpDir);

    // Insert a handful of memories + FTS rows directly (skip vector store).
    const db = getDb();
    const rows = [
      {
        id: 'mem-1',
        type: 'devis',
        content: 'Devis pour Boulangerie Fontaine — site web 1850 euros',
        title: 'Devis Fontaine site web',
        tags: 'boulangerie web',
      },
      {
        id: 'mem-2',
        type: 'devis',
        content: 'Devis Cabinet Deschamps SEO 2400 euros',
        title: 'Devis Deschamps SEO',
        tags: 'cabinet seo',
      },
      {
        id: 'mem-3',
        type: 'releve_bancaire',
        content: 'Relevé BNP Mathieu Lefèvre janvier 2024',
        title: 'Relevé BNP Lefèvre 2024-01',
        tags: 'bnp 2024',
      },
    ];
    const insMem = db.prepare(
      `INSERT INTO memories (id, type, source_id, content, content_hash, properties_json,
         wikilinks_json, related_ids_json, embedding_model, created_at, scope,
         intent, importance, pinned, confidence)
       VALUES (?, ?, ?, ?, ?, '{}', '[]', '[]', 'test', ?, 'personal', 'other', 'medium', 0, 1.0)`,
    );
    const insFts = db.prepare(
      `INSERT INTO memories_fts (id, content, title, tags) VALUES (?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const r of rows) {
      insMem.run(r.id, r.type, `src-${r.id}`, r.content, `hash-${r.id}`, now);
      insFts.run(r.id, r.content, r.title, r.tags);
    }
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds the right doc by unique entity name', () => {
    const hits = ftsSearchByType('devis', 'Fontaine', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('mem-1');
  });

  it('respects the type filter — same query, different type returns nothing', () => {
    expect(ftsSearchByType('releve_bancaire', 'Fontaine', 10)).toHaveLength(0);
    expect(ftsSearchByType('devis', 'BNP', 10)).toHaveLength(0);
  });

  it('returns BM25 rank ordered (best first)', () => {
    const hits = ftsSearchByType('devis', 'Deschamps SEO', 10);
    expect(hits[0].id).toBe('mem-2');
    // BM25 ranks are negative in SQLite — smaller (more negative) = better
    if (hits.length > 1) {
      expect(hits[0].bm25).toBeLessThanOrEqual(hits[1].bm25);
    }
  });

  it('searches across all types when no filter is given', () => {
    const hits = ftsSearchAll('Lefèvre', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('mem-3');
    expect(hits[0].type).toBe('releve_bancaire');
  });

  it('returns [] for empty / no-match queries (no throw)', () => {
    expect(ftsSearchByType('devis', '', 10)).toEqual([]);
    expect(ftsSearchByType('devis', 'inexistantxyz', 10)).toEqual([]);
  });
});
