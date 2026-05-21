/**
 * src/tests/cloud-integration.test.ts
 *
 * End-to-end integration test for Plan K:
 * - Pairing flow (simulated callback)
 * - Crypto key derivation
 * - Transit poll → decrypt → ingest → ack
 *
 * Uses real SQLite + real LanceDB + real Ollama embeddings.
 * Uses mock HTTP servers for Plan I/J endpoints.
 * No real cloud needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { ulid } from 'ulid';
import { initDb, closeDb, getDb } from '../db/index.js';
import { initVectorStore } from '../vector/store.js';
import { MemoryStore } from '../memory/core/store.js';
import { saveTokens, loadTokens, isPaired } from '../cloud/auth.js';
import {
  generateMasterKeySalt,
  deriveMasterKey,
  encryptBlob,
} from '../cloud/crypto.js';
import { pollOnce } from '../cloud/transit-poller.js';
import type { EngramConfig } from '../config/schema.js';
import type { TransitItem } from '../cloud/transit-poller.js';

// ---------------------------------------------------------------------------
// Mock Plan J transit server
// ---------------------------------------------------------------------------

interface MockState {
  inbox: TransitItem[];
  ackedIds: string[];
  blobs: Map<string, Uint8Array>;
}

function buildMockServer(state: MockState): Promise<{ server: http.Server; url: string }> {
  return new Promise((res) => {
    const server = http.createServer((req, resp) => {
      const u = new URL(req.url!, 'http://localhost');
      if (req.method === 'GET' && u.pathname === '/transit/inbox') {
        const since = u.searchParams.get('since') ?? '';
        resp.writeHead(200, { 'Content-Type': 'application/json' });
        resp.end(JSON.stringify({ items: state.inbox.filter((i) => i.createdAt > since) }));
        return;
      }
      if (req.method === 'GET' && u.pathname.startsWith('/blob/')) {
        const id = u.pathname.slice(6);
        const blob = state.blobs.get(id);
        if (!blob) {
          resp.writeHead(404);
          resp.end();
          return;
        }
        resp.writeHead(200);
        resp.end(Buffer.from(blob));
        return;
      }
      if (req.method === 'POST' && u.pathname === '/transit/ack') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          const { id } = JSON.parse(body) as { id: string };
          state.ackedIds.push(id);
          state.inbox = state.inbox.filter((i) => i.id !== id);
          resp.writeHead(200);
          resp.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      resp.writeHead(404);
      resp.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      res({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function fakeJwt(expSec: number): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: 'u', exp: expSec })).toString('base64url');
  return `${h}.${p}.sig`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Plan K integration — pairing + transit cycle', () => {
  let tmpDir: string;
  let store: MemoryStore;
  let state: MockState;
  let server: http.Server;
  let baseUrl: string;

  const passphrase = 'integration-test-passphrase-secure-enough';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-k-integ-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);
    store = new MemoryStore({
      embeddings: {
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 768,
      },
    });
    state = { inbox: [], ackedIds: [], blobs: new Map() };
    const started = await buildMockServer(state);
    server = started.server;
    baseUrl = started.url;
  });

  afterEach(() => {
    closeDb();
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('simulated pairing stores tokens in oauth_tokens', () => {
    // Simulate what startPairing() + saveTokens() does after receiving callback
    expect(isPaired()).toBe(false);

    const expSec = Math.floor(Date.now() / 1000) + 3600;
    saveTokens({
      jwt: fakeJwt(expSec),
      refreshToken: 'refresh-abc',
      apiKey: 'api-key-xyz',
      expiresAt: expSec * 1000,
    });

    expect(isPaired()).toBe(true);
    const tokens = loadTokens()!;
    expect(tokens.apiKey).toBe('api-key-xyz');
    expect(tokens.refreshToken).toBe('refresh-abc');
  });

  it('full cycle: pair → derive key → encrypt on mobile → poll → decrypt → ingest → ack', async () => {
    // --- Simulate pairing ---
    const saltHex = await generateMasterKeySalt();
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    saveTokens({
      jwt: fakeJwt(expSec),
      refreshToken: 'rt',
      apiKey: 'ak',
      expiresAt: expSec * 1000,
    });

    // --- Simulate mobile: derive same key and encrypt a note ---
    const masterKey = await deriveMasterKey(passphrase, saltHex);
    const plaintext = new TextEncoder().encode(
      'Met with the team today. Key decision: ship Plan K by end of sprint.',
    );
    const encrypted = await encryptBlob(plaintext, masterKey);

    // --- Populate mock transit inbox ---
    const itemId = ulid();
    state.blobs.set(itemId, encrypted);
    state.inbox.push({
      id: itemId,
      type: 'text',
      downloadUrl: `${baseUrl}/blob/${itemId}`,
      createdAt: new Date().toISOString(),
      mimeType: 'text/plain',
      filename: 'meeting-note.txt',
      sizeBytes: encrypted.length,
    });

    // --- PC polls ---
    const config: EngramConfig = {
      dataDir: tmpDir,
      embeddings: {
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 768,
      },
      propertyExtraction: {
        enabled: false,
        baseUrl: '',
        model: '',
        maxTokens: 300,
      },
      whisper: { enabled: true, model: 'small.en', language: 'auto' },
      youtube: { enabled: true, preferLanguage: 'en', fallbackToYtdlp: true },
      modules: {},
      mcp: { stdio: false, httpPort: 7777 },
      engramAccount: {
        jwt: fakeJwt(expSec),
        refreshToken: 'rt',
        apiKey: 'ak',
        masterKeySalt: saltHex,
        baseUrl,
        pairedAt: new Date().toISOString(),
      },
    };

    const result = await pollOnce({ store, config, masterKey });

    // --- Assert ---
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);

    // Item was acknowledged (removed from inbox)
    expect(state.ackedIds).toContain(itemId);
    expect(state.inbox).toHaveLength(0);

    // Memory was stored in SQLite
    const rows = getDb()
      .prepare("SELECT content, properties_json FROM memories WHERE type = 'notes'")
      .all() as Array<{ content: string; properties_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain('ship Plan K');

    // Vector store can find it via semantic search
    const hits = await store.search('notes', 'team meeting decision sprint', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].memory.content).toContain('ship Plan K');
  }, 60_000);
});
