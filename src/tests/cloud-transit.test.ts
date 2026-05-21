import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { ulid } from 'ulid';
import { initDb, closeDb, getDb } from '../db/index.js';
import { initVectorStore } from '../vector/store.js';
import { MemoryStore } from '../memory/core/store.js';
import { saveTokens } from '../cloud/auth.js';
import {
  generateMasterKeySalt,
  deriveMasterKey,
  encryptBlob,
} from '../cloud/crypto.js';
import { pollOnce, type TransitItem } from '../cloud/transit-poller.js';
import type { EngramConfig } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Mock Plan J server
// ---------------------------------------------------------------------------

interface MockServerState {
  inbox: TransitItem[];
  ackedIds: string[];
  blobsByItemId: Map<string, Uint8Array>; // encrypted blobs served at /blob/:id
}

function startMockTransitServer(
  state: MockServerState,
): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);

      // GET /transit/inbox?since=…
      if (req.method === 'GET' && url.pathname === '/transit/inbox') {
        const since = url.searchParams.get('since') ?? '';
        const items = state.inbox.filter((i) => i.createdAt > since);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items }));
        return;
      }

      // GET /blob/:id — simulates R2 signed URL
      if (req.method === 'GET' && url.pathname.startsWith('/blob/')) {
        const id = url.pathname.replace('/blob/', '');
        const blob = state.blobsByItemId.get(id);
        if (!blob) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from(blob));
        return;
      }

      // POST /transit/ack
      if (req.method === 'POST' && url.pathname === '/transit/ack') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          const { id } = JSON.parse(body) as { id: string };
          state.ackedIds.push(id);
          // Remove from inbox
          state.inbox = state.inbox.filter((i) => i.id !== id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ollamaConfig: EngramConfig['embeddings'] = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
};

function fakeJwt(expSec: number): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: 'u', exp: expSec })).toString('base64url');
  return `${h}.${p}.sig`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cloud/transit-poller', () => {
  let tmpDir: string;
  let store: MemoryStore;
  let masterKey: Uint8Array;
  let saltHex: string;
  let mockState: MockServerState;
  let mockServer: http.Server;
  let baseUrl: string;
  let config: EngramConfig;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-transit-'));
    initDb(tmpDir);
    initVectorStore(tmpDir);

    store = new MemoryStore({ embeddings: ollamaConfig });

    // Generate master key
    saltHex = await generateMasterKeySalt();
    masterKey = await deriveMasterKey('test-passphrase', saltHex);

    // Save fake JWT to oauth_tokens (poller calls getValidJwt which reads DB)
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    saveTokens({
      jwt: fakeJwt(expSec),
      refreshToken: 'rt',
      apiKey: 'ak-test',
      expiresAt: expSec * 1000,
    });

    // Start mock server
    mockState = { inbox: [], ackedIds: [], blobsByItemId: new Map() };
    const started = await startMockTransitServer(mockState);
    mockServer = started.server;
    baseUrl = started.baseUrl;

    config = {
      dataDir: tmpDir,
      embeddings: ollamaConfig,
      propertyExtraction: {
        enabled: false,
        baseUrl: 'http://localhost:11434',
        model: 'llama3.2:3b',
        maxTokens: 300,
      },
      whisper: { enabled: true, model: 'small.en', language: 'auto' },
      youtube: { enabled: true, preferLanguage: 'en', fallbackToYtdlp: true },
      modules: {},
      mcp: { stdio: true, httpPort: 7777 },
      engramAccount: {
        jwt: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
        refreshToken: 'rt',
        apiKey: 'ak-test',
        masterKeySalt: saltHex,
        baseUrl,
        pairedAt: new Date().toISOString(),
      },
    };
  });

  afterEach(() => {
    closeDb();
    mockServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pollOnce returns processed=0 when inbox is empty', async () => {
    const result = await pollOnce({ store, config, masterKey });
    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('pollOnce ingests a text item and acks it', async () => {
    // Prepare encrypted text blob
    const itemId = ulid();
    const plaintext = new TextEncoder().encode('Hello from mobile! This is a transit text note.');
    const encrypted = await encryptBlob(plaintext, masterKey);
    mockState.blobsByItemId.set(itemId, encrypted);

    const item: TransitItem = {
      id: itemId,
      type: 'text',
      downloadUrl: `${baseUrl}/blob/${itemId}`,
      createdAt: new Date().toISOString(),
      mimeType: 'text/plain',
      filename: 'note.txt',
      sizeBytes: encrypted.length,
    };
    mockState.inbox.push(item);

    const result = await pollOnce({ store, config, masterKey });

    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
    expect(mockState.ackedIds).toContain(itemId);
    expect(mockState.inbox).toHaveLength(0);

    // Verify the memory was actually stored
    const memories = getDb()
      .prepare("SELECT content, properties_json FROM memories WHERE type = 'notes'")
      .all() as Array<{ content: string; properties_json: string }>;
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe('Hello from mobile! This is a transit text note.');
    const props = JSON.parse(memories[0].properties_json) as {
      custom?: { transit_id: string };
    };
    expect(props.custom?.transit_id).toBe(itemId);
  }, 30_000);

  it('pollOnce processes multiple items and acks each', async () => {
    for (let i = 0; i < 3; i++) {
      const id = ulid();
      const pt = new TextEncoder().encode(`Transit note number ${i}`);
      const enc = await encryptBlob(pt, masterKey);
      mockState.blobsByItemId.set(id, enc);
      mockState.inbox.push({
        id,
        type: 'text',
        downloadUrl: `${baseUrl}/blob/${id}`,
        createdAt: new Date(Date.now() + i).toISOString(),
        mimeType: 'text/plain',
        sizeBytes: enc.length,
      });
    }

    const result = await pollOnce({ store, config, masterKey });
    expect(result.processed).toBe(3);
    expect(result.errors).toBe(0);
    expect(mockState.ackedIds).toHaveLength(3);
    expect(mockState.inbox).toHaveLength(0);
  }, 60_000);

  it('pollOnce handles decryption failure gracefully (wrong key), counts as error', async () => {
    const itemId = ulid();
    // Encrypt with a DIFFERENT master key
    const otherSalt = await generateMasterKeySalt();
    const otherKey = await deriveMasterKey('other-passphrase', otherSalt);
    const enc = await encryptBlob(new TextEncoder().encode('secret'), otherKey);
    mockState.blobsByItemId.set(itemId, enc);
    mockState.inbox.push({
      id: itemId,
      type: 'text',
      downloadUrl: `${baseUrl}/blob/${itemId}`,
      createdAt: new Date().toISOString(),
      mimeType: 'text/plain',
      sizeBytes: enc.length,
    });

    const result = await pollOnce({ store, config, masterKey });
    // Error counted, item NOT acked (stays in inbox)
    expect(result.errors).toBe(1);
    expect(result.processed).toBe(0);
    expect(mockState.ackedIds).toHaveLength(0);
    expect(mockState.inbox).toHaveLength(1);
  }, 30_000);

  it('pollOnce persists last_ts watermark so next poll uses since filter', async () => {
    const id1 = ulid();
    const ts1 = '2026-01-01T00:00:00.000Z';
    const pt = new TextEncoder().encode('old note');
    const enc = await encryptBlob(pt, masterKey);
    mockState.blobsByItemId.set(id1, enc);
    mockState.inbox.push({
      id: id1,
      type: 'text',
      downloadUrl: `${baseUrl}/blob/${id1}`,
      createdAt: ts1,
      mimeType: 'text/plain',
      sizeBytes: enc.length,
    });

    await pollOnce({ store, config, masterKey });

    // Second poll — inbox is empty, mock server filters by since
    const result2 = await pollOnce({ store, config, masterKey });
    expect(result2.processed).toBe(0);

    // module_state should have the watermark
    const row = getDb()
      .prepare(
        "SELECT value_json FROM module_state WHERE module_id = 'cloud_transit' AND key = 'last_ts'",
      )
      .get() as { value_json: string } | undefined;
    expect(row).not.toBeUndefined();
    expect(JSON.parse(row!.value_json)).toBe(ts1);
  }, 30_000);

  it('doc item is ingested as notes with doc tags', async () => {
    const id = ulid();
    const text = 'This is a shared document excerpt. Machine learning basics.';
    const enc = await encryptBlob(new TextEncoder().encode(text), masterKey);
    mockState.blobsByItemId.set(id, enc);
    mockState.inbox.push({
      id,
      type: 'doc',
      downloadUrl: `${baseUrl}/blob/${id}`,
      createdAt: new Date().toISOString(),
      mimeType: 'application/pdf',
      filename: 'ml-basics.pdf',
      sizeBytes: enc.length,
    });

    const result = await pollOnce({ store, config, masterKey });
    expect(result.processed).toBe(1);

    const memories = getDb()
      .prepare("SELECT properties_json FROM memories WHERE type = 'notes'")
      .all() as Array<{ properties_json: string }>;
    const props = JSON.parse(memories[0].properties_json) as {
      tags?: string[];
      custom?: { mime_type: string };
    };
    expect(props.tags).toContain('document');
    expect(props.custom?.mime_type).toBe('application/pdf');
  }, 30_000);
});
