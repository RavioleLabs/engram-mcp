// src/tests/hybrid-recall.test.ts
// Validates the hybrid (semantic + FTS5) recall path against the stress-test
// failure mode: 5 structurally-identical devis with only the client name as
// differentiator. Before hybrid, recall@1 on this corpus was ~8% — the
// entity tokens carry near-zero embedding weight.
//
// Uses real Ollama (no mocks per project policy). Test will fail if Ollama is
// not running on localhost:11434 — install Ollama and pull `nomic-embed-text`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ulid } from 'ulid';
import { initDb, closeDb } from '../db/index.js';
import { initVectorStore } from '../vector/store.js';
import { MemoryStore } from '../memory/core/store.js';
import type { MemoryItem } from '../types.js';

const embeddingsConfig = {
  provider: 'ollama' as const,
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
};

function devisItem(client: string, prestation: string, montant: number): MemoryItem {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    type: 'test_devis',
    source_id: `manual:${client}`,
    content: [
      'DEVIS',
      '',
      'Société : Raviole Labs SARL',
      `Client : ${client}`,
      'Date : 2026-01-15',
      '',
      'Prestation | Quantité | Prix unitaire | Total',
      `${prestation} | 1 | ${montant}€ | ${montant}€`,
      '',
      `Total HT : ${montant}€`,
      `TVA 20% : ${(montant * 0.2).toFixed(2)}€`,
      `Total TTC : ${(montant * 1.2).toFixed(2)}€`,
      '',
      'Règlement à 30 jours.',
    ].join('\n'),
    content_hash: `hash-${client}`,
    properties: {
      created_at: now,
      ingested_at: now,
      title: `Devis ${client} — ${prestation}`,
      tags: [client.toLowerCase().replace(/\s+/g, '-'), 'devis'],
    },
    wikilinks: [],
    related_ids: [],
    embedding_model: 'nomic-embed-text',
  };
}

describe('hybrid recall (semantic + FTS5)', () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-hybrid-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({ embeddings: embeddingsConfig });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds the right devis by client name even when all docs share template', async () => {
    // 5 structurally-identical devis — same template, only client + prestation
    // + amount differ. This is the exact failure mode the stress-test surfaced.
    const fontaine = devisItem('Boulangerie Fontaine', 'Site web', 1850);
    const deschamps = devisItem('Cabinet Deschamps', 'Audit SEO', 2400);
    const morel = devisItem('Atelier Morel', 'Identité visuelle', 4200);
    const berthelot = devisItem('Pharmacie Berthelot', 'Mise en conformité RGPD', 890);
    const lemaire = devisItem('Restaurant Lemaire', 'Refonte carte menu', 1100);

    for (const d of [fontaine, deschamps, morel, berthelot, lemaire]) {
      await store.insert(d);
    }

    // Query by client name — the most discriminating signal. Pre-hybrid this
    // returned random devis because the embedding model's signal was dominated
    // by the template shape. With FTS5 in the path, "Fontaine" is an exact
    // token hit and surfaces fontaine first.
    const hits = await store.search('test_devis', 'Boulangerie Fontaine', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].memory.id).toBe(fontaine.id);

    // Also: keyword bag in stress-test format.
    const hits2 = await store.search('test_devis', 'Pharmacie Berthelot RGPD 890', 5);
    expect(hits2[0].memory.id).toBe(berthelot.id);
  }, 60_000);

  it('exposes `match` and `weak` flags on each hit', async () => {
    await store.insert(devisItem('Atelier Morel', 'Identité visuelle', 4200));

    // Strong entity hit — should be "both" (semantic via prefix-boosted embedding
    // + FTS5 keyword match) or at least "keyword".
    const strong = await store.search('test_devis', 'Atelier Morel', 5);
    expect(strong.length).toBeGreaterThan(0);
    expect(['both', 'keyword', 'semantic']).toContain(strong[0].match);
    expect(strong[0]).toHaveProperty('weak');

    // Nonsense query — at minimum, the `weak` field is exposed and any returned
    // semantic-only hit is flagged accordingly.
    const noise = await store.search('test_devis', 'quantum chromodynamics', 5);
    for (const h of noise) {
      if (h.match === 'semantic' && h.score < 0.3) {
        expect(h.weak).toBe(true);
      }
    }
  }, 60_000);
});
