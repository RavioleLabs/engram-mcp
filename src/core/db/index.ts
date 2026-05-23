// src/core/db/index.ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../logger.js';

const log = createLogger('db');

let _db: Database.Database | null = null;

function resolvePath(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('DB not initialized. Call initDb() first.');
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function initDb(dataDir: string): Database.Database {
  const resolved = resolvePath(dataDir);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(resolved, 0o700);
  } catch {}

  const dbPath = path.join(resolved, 'engram.db');
  log.info(`Opening database at ${dbPath}`);

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {}

  runMigrations(_db);
  log.info('Database ready');

  return _db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
    v: number | null;
  };
  const current = row.v ?? 0;

  const migrations: Array<{ version: number; sql: string }> = [
    { version: 1, sql: MIGRATION_1 },
    { version: 2, sql: MIGRATION_2 },
    { version: 3, sql: MIGRATION_3 },
    { version: 4, sql: MIGRATION_4 },
    { version: 5, sql: MIGRATION_5 },
    { version: 6, sql: MIGRATION_6 },
    { version: 7, sql: MIGRATION_7 },
    { version: 8, sql: MIGRATION_8 },
    { version: 9, sql: '' /* applied programmatically — see below */ },
  ];

  for (const m of migrations) {
    if (m.version > current) {
      log.info(`Applying migration v${m.version}`);
      if (m.version === 9) {
        // Recall signals: importance, decay, skip/pin feedback, intent tagging,
        // access tracking. All idempotent ADD COLUMN guarded by PRAGMA check.
        const cols = db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
        const has = (n: string) => cols.some((c) => c.name === n);
        if (!has('access_count'))     db.exec(`ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
        if (!has('last_accessed_at')) db.exec(`ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER`);
        if (!has('importance'))       db.exec(`ALTER TABLE memories ADD COLUMN importance TEXT NOT NULL DEFAULT 'medium'`);
        if (!has('pinned'))           db.exec(`ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
        if (!has('skip_penalty'))     db.exec(`ALTER TABLE memories ADD COLUMN skip_penalty REAL NOT NULL DEFAULT 1.0`);
        if (!has('intent'))           db.exec(`ALTER TABLE memories ADD COLUMN intent TEXT`);
        if (!has('confidence'))       db.exec(`ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0`);
        db.exec(`CREATE INDEX IF NOT EXISTS memories_importance_idx ON memories(importance, pinned)`);
        db.exec(`CREATE INDEX IF NOT EXISTS memories_intent_idx ON memories(intent)`);
        db.exec(`CREATE INDEX IF NOT EXISTS memories_accessed_idx ON memories(last_accessed_at DESC)`);
      } else if (m.version === 8) {
        // SQLite lacks ADD COLUMN IF NOT EXISTS — guard programmatically
        const cols = db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === 'scope')) {
          db.exec(`ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal'`);
        }
        // Workspace registry table
        db.exec(MIGRATION_8_WORKSPACES);
        db.exec(`CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(scope)`);
      } else if (m.version === 7) {
        // SQLite doesn't support ADD COLUMN IF NOT EXISTS.
        // Check if poll_count already exists before altering (happens when
        // migration 6 was applied after the column was added to it).
        const cols = db.prepare(`PRAGMA table_info(ingest_jobs)`).all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === 'poll_count')) {
          db.exec(`ALTER TABLE ingest_jobs ADD COLUMN poll_count INTEGER NOT NULL DEFAULT 0`);
        }
      } else {
        db.exec(m.sql);
      }
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        Date.now(),
      );
    }
  }
}

export function getLocalLamport(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT MAX(lamport_ts) as max_ts FROM ops_log WHERE device_id = (
         SELECT device_id FROM device_identity LIMIT 1
       )`,
    )
    .get() as { max_ts: number | null } | undefined;
  return row?.max_ts ?? 0;
}

export function incrementLamport(db: Database.Database, deviceId: string): number {
  const current = db
    .prepare(`SELECT lamport_ts FROM device_identity WHERE device_id = ?`)
    .get(deviceId) as { lamport_ts: number } | undefined;
  const next = (current?.lamport_ts ?? 0) + 1;
  db.prepare(`UPDATE device_identity SET lamport_ts = ? WHERE device_id = ?`).run(next, deviceId);
  return next;
}

// Migration 8 is handled programmatically (SQLite lacks ADD COLUMN IF NOT EXISTS).
// The constant is kept for schema documentation purposes only.
const MIGRATION_8 = `-- scope column added to memories (handled below)`;

// Workspace registry: local record of workspaces the user is a member of.
// Stores the decrypted team key path + metadata for fast lookup.
// The actual team master keys are stored in ~/.engram/keys/workspaces/<id>.key
const MIGRATION_8_WORKSPACES = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id           TEXT PRIMARY KEY,    -- ULID (matches cloud workspace id)
    name         TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'member',
    owner_email  TEXT,
    joined_at    TEXT NOT NULL
  );
`;

// Migration 7 is handled programmatically (SQLite lacks ADD COLUMN IF NOT EXISTS)
// The constant is kept for schema documentation purposes only.
const MIGRATION_7 = `-- poll_count column added to ingest_jobs (handled below)`;


const MIGRATION_6 = `
  -- ingest_jobs: async job tracking for heavy ingest operations (audio, large video, etc.)
  CREATE TABLE IF NOT EXISTS ingest_jobs (
    id          TEXT    PRIMARY KEY,
    uri         TEXT    NOT NULL,
    type        TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending',
    progress    INTEGER NOT NULL DEFAULT 0,
    memory_id   TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    started_at  INTEGER,
    completed_at INTEGER,
    poll_count  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status ON ingest_jobs(status, created_at);
`;

const MIGRATION_5 = `
  -- recovery_shards: local mirror of shard setup metadata (no share codes stored locally)
  CREATE TABLE IF NOT EXISTS recovery_shards (
    id              TEXT    PRIMARY KEY,
    share_index     INTEGER NOT NULL,
    trusted_email   TEXT    NOT NULL,
    created_at      INTEGER NOT NULL
  );

  -- snapshot_log: tracks local knowledge of uploaded cloud snapshots
  CREATE TABLE IF NOT EXISTS snapshot_log (
    id          TEXT    PRIMARY KEY,
    r2_key      TEXT    NOT NULL,
    lamport_ts  INTEGER NOT NULL,
    size_bytes  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );
`;

const MIGRATION_4 = `
  -- ops_log: append-only operation log for bidirectional sync
  CREATE TABLE IF NOT EXISTS ops_log (
    op_id       TEXT    PRIMARY KEY,
    device_id   TEXT    NOT NULL,
    lamport_ts  INTEGER NOT NULL,
    op_type     TEXT    NOT NULL
                CHECK (op_type IN ('add_memory','update_properties','delete_memory','add_relation')),
    memory_id   TEXT    NOT NULL,
    payload_enc BLOB    NOT NULL,
    nonce       BLOB    NOT NULL,
    sig         BLOB    NOT NULL,
    sent_at     INTEGER,
    applied     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ops_log_pending
    ON ops_log (sent_at, created_at)
    WHERE sent_at IS NULL;

  CREATE INDEX IF NOT EXISTS idx_ops_log_memory
    ON ops_log (memory_id, lamport_ts);

  CREATE INDEX IF NOT EXISTS idx_ops_log_applied
    ON ops_log (applied, created_at);

  -- tombstones: soft-delete with grace period
  CREATE TABLE IF NOT EXISTS tombstones (
    memory_id   TEXT    PRIMARY KEY,
    deleted_at  INTEGER NOT NULL,
    op_id       TEXT    NOT NULL,
    grace_until INTEGER NOT NULL,
    finalized   INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_tombstones_grace
    ON tombstones (finalized, grace_until);

  -- device_identity: local ed25519 keypair (one row per device)
  CREATE TABLE IF NOT EXISTS device_identity (
    device_id   TEXT    PRIMARY KEY,
    pubkey_hex  TEXT    NOT NULL,
    privkey_hex TEXT    NOT NULL,
    lamport_ts  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
`;

const MIGRATION_3 = `
  CREATE TABLE saved_views (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    definition_json TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX idx_saved_views_pinned ON saved_views(pinned DESC, created_at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

const MIGRATION_2 = `
  CREATE TABLE watched_sources (
    id TEXT PRIMARY KEY,                    -- ULID
    module_id TEXT NOT NULL,                -- 'drive' | 'notion' | ...
    external_id TEXT NOT NULL,              -- doc id / page id / file id
    display_name TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}', -- per-module metadata
    last_synced_at INTEGER,
    last_modified_remote TEXT,              -- remote ETag / modified_time
    last_error TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE(module_id, external_id)
  );

  CREATE INDEX idx_watched_sources_module ON watched_sources(module_id);
  CREATE INDEX idx_watched_sources_enabled ON watched_sources(enabled, module_id);
`;

const MIGRATION_1 = `
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    properties_json TEXT NOT NULL,
    wikilinks_json TEXT NOT NULL DEFAULT '[]',
    related_ids_json TEXT NOT NULL DEFAULT '[]',
    embedding_model TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(type, source_id, content_hash)
  );

  CREATE INDEX idx_memories_type ON memories(type);
  CREATE INDEX idx_memories_source ON memories(type, source_id);
  CREATE INDEX idx_memories_created ON memories(created_at DESC);

  CREATE VIRTUAL TABLE memories_fts USING fts5(
    id UNINDEXED,
    content,
    title,
    tags,
    tokenize = 'porter unicode61'
  );

  CREATE TABLE custom_types (
    type_name TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    schema_json TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE oauth_tokens (
    provider TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER,
    extra_json TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE module_state (
    module_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (module_id, key)
  );
`;
