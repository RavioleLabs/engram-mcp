/**
 * src/cloud/transit-poller.ts
 *
 * Cloud transit poller — fetches encrypted blobs from Plan J transit inbox,
 * decrypts with user master key, dispatches to the right ingest path.
 *
 * Runs as a node-cron job (default: every 5 minutes).
 * Only starts if config.engramAccount is set (user has paired).
 *
 * Dispatch table:
 *   'voice' → Whisper transcribe → notes ingest (voice_note variant)
 *   'doc'   → notes ingest (with document tags)
 *   'text'  → notes ingest (direct, no transcription)
 *
 * State: last_ts persisted in module_state(module_id='cloud_transit', key='last_ts').
 */
import cron from 'node-cron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ulid } from 'ulid';
import { createHash } from 'crypto';
import { getDb } from '../db/index.js';
import { createLogger } from '../logger.js';
import { getValidJwt } from './auth.js';
import { decryptBlob } from './crypto.js';
import { MemoryStore } from '../memory/core/store.js';
import type { EngramConfig } from '../config/schema.js';
import { transcribeAudio } from '../memory/modules/audio/transcriber.js';

const log = createLogger('cloud:transit-poller');

const MODULE_ID = 'cloud_transit';
const LAST_TS_KEY = 'last_ts';

// ---------------------------------------------------------------------------
// State helpers (module_state table)
// ---------------------------------------------------------------------------

function getLastTs(): string {
  const row = getDb()
    .prepare('SELECT value_json FROM module_state WHERE module_id = ? AND key = ?')
    .get(MODULE_ID, LAST_TS_KEY) as { value_json: string } | undefined;
  if (!row) return new Date(0).toISOString(); // epoch — fetch everything
  return JSON.parse(row.value_json) as string;
}

function setLastTs(ts: string): void {
  getDb()
    .prepare(
      `INSERT INTO module_state (module_id, key, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(module_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(MODULE_ID, LAST_TS_KEY, JSON.stringify(ts), Date.now());
}

// ---------------------------------------------------------------------------
// Plan J API calls
// ---------------------------------------------------------------------------

export interface TransitItem {
  id: string;
  type: 'voice' | 'doc' | 'text';
  /** Signed R2 URL to download encrypted blob */
  downloadUrl: string;
  /** ISO timestamp of when the item was uploaded */
  createdAt: string;
  /** Blob MIME type hint (e.g., 'audio/webm', 'application/pdf', 'text/plain') */
  mimeType: string;
  /** Original filename if any */
  filename?: string;
  /** Byte size of encrypted blob */
  sizeBytes: number;
}

async function fetchInbox(jwt: string, baseUrl: string, since: string): Promise<TransitItem[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/transit/inbox?since=${encodeURIComponent(since)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Transit inbox fetch failed ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { items?: TransitItem[] };
  return data.items ?? [];
}

async function downloadBlob(downloadUrl: string): Promise<Uint8Array> {
  const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`Blob download failed ${res.status} from ${downloadUrl}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function ackItem(jwt: string, baseUrl: string, itemId: string): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}/transit/ack`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id: itemId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Ack failed ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchItem(
  item: TransitItem,
  plaintext: Uint8Array,
  store: MemoryStore,
  config: EngramConfig,
): Promise<void> {
  const now = new Date().toISOString();
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  switch (item.type) {
    case 'text': {
      // Direct text → notes ingest
      const content = new TextDecoder().decode(plaintext);
      await store.insert({
        id: ulid(),
        type: 'notes',
        source_id: `transit:${item.id}`,
        content,
        content_hash: createHash('sha256').update(content).digest('hex'),
        properties: {
          title: item.filename ?? `Transit note ${item.id.slice(0, 8)}`,
          tags: ['transit', 'cloud'],
          created_at: item.createdAt,
          ingested_at: now,
          custom: { transit_id: item.id, mime_type: item.mimeType },
        },
        wikilinks: [],
        related_ids: [],
        embedding_model: embeddingModel,
      });
      log.info(`Ingested text transit item ${item.id}`);
      break;
    }

    case 'voice': {
      // Write plaintext to a temp file, transcribe via Whisper, ingest as notes
      const tmpDir = os.tmpdir();
      // Determine extension from MIME type (audio/webm → .webm, audio/mp4 → .mp4, etc.)
      const ext = item.mimeType.split('/')[1]?.split(';')[0] ?? 'wav';
      const tmpPath = path.join(tmpDir, `engram-transit-${item.id}.${ext}`);
      fs.writeFileSync(tmpPath, plaintext);

      try {
        const whisperConfig = config.whisper ?? {
          enabled: true,
          model: 'small.en',
          language: 'auto',
        };

        if (!whisperConfig.enabled) {
          log.warn(`Whisper disabled — skipping voice transit item ${item.id}`);
          return;
        }

        const transcript = await transcribeAudio(tmpPath, whisperConfig);
        const content = transcript.full_text;

        await store.insert({
          id: ulid(),
          type: 'notes',
          source_id: `transit:${item.id}`,
          content,
          content_hash: createHash('sha256').update(content).digest('hex'),
          properties: {
            title: item.filename ?? `Voice note ${item.id.slice(0, 8)}`,
            tags: ['transit', 'voice', 'cloud'],
            created_at: item.createdAt,
            ingested_at: now,
            custom: {
              transit_id: item.id,
              mime_type: item.mimeType,
              duration_seconds: transcript.duration,
              language: transcript.language,
              segments: transcript.segments,
            },
          },
          wikilinks: [],
          related_ids: [],
          embedding_model: embeddingModel,
        });

        log.info(
          `Ingested voice transit item ${item.id} (${transcript.duration}s, ${transcript.segments.length} segments)`,
        );
      } finally {
        // Always clean up the temp file
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
      }
      break;
    }

    case 'doc': {
      // Document blob — ingest as a memory in 'notes' type.
      // For binary formats (PDF), the plaintext is assumed to be extracted text.
      const content = new TextDecoder('utf-8', { fatal: false }).decode(plaintext);
      const hash = createHash('sha256').update(plaintext).digest('hex');

      await store.insert({
        id: ulid(),
        type: 'notes',
        source_id: `transit:${item.id}`,
        content,
        content_hash: hash,
        properties: {
          title: item.filename ?? `Document ${item.id.slice(0, 8)}`,
          tags: ['transit', 'document', 'cloud'],
          created_at: item.createdAt,
          ingested_at: now,
          source_url: item.downloadUrl, // signed URL (expires — informational)
          custom: {
            transit_id: item.id,
            mime_type: item.mimeType,
            size_bytes: item.sizeBytes,
          },
        },
        wikilinks: [],
        related_ids: [],
        embedding_model: embeddingModel,
      });
      log.info(`Ingested doc transit item ${item.id} (${item.sizeBytes} bytes)`);
      break;
    }

    default: {
      log.warn(`Unknown transit item type: ${(item as TransitItem).type} — skipping`);
    }
  }
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

export interface TransitPollerOptions {
  store: MemoryStore;
  config: EngramConfig;
  /** In-process master key (Uint8Array, 32 bytes). Held in memory, never stored. */
  masterKey: Uint8Array;
}

export async function pollOnce(
  opts: TransitPollerOptions,
): Promise<{ processed: number; errors: number }> {
  const { store, config, masterKey } = opts;
  const account = config.engramAccount!;
  const baseUrl = account.baseUrl ?? 'https://api.engram-mcp.com';

  let jwt: string;
  try {
    jwt = await getValidJwt(baseUrl);
  } catch (e) {
    log.error(`Cannot get valid JWT: ${e instanceof Error ? e.message : String(e)}`);
    return { processed: 0, errors: 1 };
  }

  const since = getLastTs();
  let items: TransitItem[];
  try {
    items = await fetchInbox(jwt, baseUrl, since);
  } catch (e) {
    log.error(`Inbox fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return { processed: 0, errors: 1 };
  }

  if (items.length === 0) {
    log.debug(`Transit inbox empty (since=${since})`);
    return { processed: 0, errors: 0 };
  }

  log.info(`Transit inbox: ${items.length} item(s) to process`);

  let processed = 0;
  let errors = 0;
  let latestTs = since;

  for (const item of items) {
    try {
      // Download encrypted blob from R2
      const encryptedBlob = await downloadBlob(item.downloadUrl);

      // Decrypt
      const plaintext = await decryptBlob(encryptedBlob, masterKey);

      // Dispatch to ingest
      await dispatchItem(item, plaintext, store, config);

      // Ack (delete from Plan J pending_items)
      await ackItem(jwt, baseUrl, item.id);

      // Update last_ts watermark
      if (item.createdAt > latestTs) latestTs = item.createdAt;

      processed++;
    } catch (e) {
      log.error(
        `Failed to process transit item ${item.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
      errors++;
      // Continue processing other items — don't let one failure block the rest
    }
  }

  if (latestTs !== since) {
    setLastTs(latestTs);
  }

  log.info(`Transit poll complete: ${processed} processed, ${errors} errors`);
  return { processed, errors };
}

/**
 * Start the transit poller cron job.
 * Returns a stop function to cancel the cron.
 * Safe to call multiple times — only starts if engramAccount is configured.
 */
export function startTransitPoller(opts: TransitPollerOptions): { stop: () => void } {
  const task = cron.schedule('*/5 * * * *', async () => {
    log.debug('Transit poll tick');
    try {
      await pollOnce(opts);
    } catch (e) {
      log.error(`Transit poll error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  log.info('Transit poller started (every 5 minutes)');

  return {
    stop: () => {
      task.stop();
      log.info('Transit poller stopped');
    },
  };
}
