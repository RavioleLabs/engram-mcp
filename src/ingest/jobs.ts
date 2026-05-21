// src/ingest/jobs.ts
// Async job system for heavy ingest operations (audio, large video transcripts, etc.)
import { ulid } from 'ulid';
import { getDb } from '../db/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('ingest:jobs');

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface IngestJob {
  id: string;
  uri: string;
  type: string | null;
  status: JobStatus;
  progress: number;
  memory_id: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  poll_count: number;
}

// Migration SQL — run once when the DB is initialised (called from db/index.ts migration 6)
export const INGEST_JOBS_DDL = `
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

// 7-day retention in ms
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Ingest call counter for probabilistic GC (1-in-50)
let _ingestCallCount = 0;

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function createJob(uri: string, type?: string): string {
  const id = `job_${ulid()}`;
  getDb()
    .prepare(
      `INSERT INTO ingest_jobs (id, uri, type, status, progress, created_at, poll_count)
       VALUES (?, ?, ?, 'pending', 0, ?, 0)`,
    )
    .run(id, uri, type ?? null, Date.now());

  // Probabilistic GC: run every ~50th call
  _ingestCallCount++;
  if (_ingestCallCount % 50 === 0) {
    gcOldJobs();
  }

  log.debug(`Created ingest job ${id} for ${uri}`);
  return id;
}

export function startJob(jobId: string): void {
  getDb()
    .prepare(`UPDATE ingest_jobs SET status = 'processing', started_at = ? WHERE id = ?`)
    .run(Date.now(), jobId);
}

export function updateProgress(jobId: string, progress: number): void {
  getDb()
    .prepare(`UPDATE ingest_jobs SET progress = ? WHERE id = ?`)
    .run(Math.min(100, Math.max(0, progress)), jobId);
}

export function completeJob(jobId: string, memoryId: string): void {
  getDb()
    .prepare(
      `UPDATE ingest_jobs
       SET status = 'completed', memory_id = ?, progress = 100, completed_at = ?
       WHERE id = ?`,
    )
    .run(memoryId, Date.now(), jobId);
  log.debug(`Job ${jobId} completed → memory ${memoryId}`);
}

export function failJob(jobId: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE ingest_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
    )
    .run(error, Date.now(), jobId);
  log.warn(`Job ${jobId} failed: ${error}`);
}

export function getJob(jobId: string): IngestJob | undefined {
  // Increment poll_count and return updated row atomically
  getDb()
    .prepare(`UPDATE ingest_jobs SET poll_count = poll_count + 1 WHERE id = ?`)
    .run(jobId);

  const row = getDb()
    .prepare(`SELECT * FROM ingest_jobs WHERE id = ?`)
    .get(jobId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    uri: row.uri as string,
    type: row.type as string | null,
    status: row.status as JobStatus,
    progress: row.progress as number,
    memory_id: row.memory_id as string | null,
    error: row.error as string | null,
    created_at: row.created_at as number,
    started_at: row.started_at as number | null,
    completed_at: row.completed_at as number | null,
    poll_count: row.poll_count as number,
  };
}

/** Compute retry hint for pending/processing jobs. */
export function computeRetryHint(pollCount: number): { retry_after_ms: number; should_give_up: boolean } {
  const retry_after_ms = Math.min(1000 * Math.pow(2, pollCount), 10_000);
  const should_give_up = pollCount >= 10;
  return { retry_after_ms, should_give_up };
}

/** Run once at startup to sweep stale completed/failed jobs older than 7 days. */
export function gcJobsOnStartup(): void {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    const result = getDb()
      .prepare(
        `DELETE FROM ingest_jobs WHERE status IN ('completed', 'failed') AND completed_at < ?`,
      )
      .run(cutoff);
    if (result.changes > 0) {
      log.info(`Startup GC: removed ${result.changes} old ingest jobs`);
    }
  } catch {
    // Non-critical — ignore GC errors
  }
}

// ── GC ────────────────────────────────────────────────────────────────────────

/**
 * Time-based GC: delete completed/failed jobs older than 7 days.
 * Called probabilistically (every ~50 ingest() calls).
 */
function gcOldJobs(): void {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    const result = getDb()
      .prepare(
        `DELETE FROM ingest_jobs WHERE status IN ('completed', 'failed') AND completed_at < ?`,
      )
      .run(cutoff);
    if (result.changes > 0) {
      log.debug(`GC: removed ${result.changes} old ingest jobs`);
    }
  } catch {
    // Non-critical — ignore GC errors
  }
}
