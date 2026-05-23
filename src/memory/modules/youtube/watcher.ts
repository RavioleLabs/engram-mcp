// src/memory/modules/youtube/watcher.ts
import { XMLParser } from 'fast-xml-parser';
import { createLogger } from '../../../logger.js';
import { getDb } from '../../../db/index.js';
import { ingestYouTube } from './ingest.js';
import type { EmbeddingsConfig, YoutubeConfig } from '../../../config/schema.js';
import type { MemoryStore } from '../../core/store.js';

const log = createLogger('youtube:watcher');

const FEED_BASE = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const CHANNEL_URL_RE = /(?:youtube\.com\/(?:channel\/|@))([A-Za-z0-9_.-]+)/;

// ── resolveChannelId ───────────────────────────────────────────────────────
/**
 * Accepts a channel ID (UCxxx…) or a full URL and returns the channel ID.
 * For handle-based URLs, fetches the channel page and extracts the canonical
 * channel ID from the embedded JSON.
 */
export async function resolveChannelId(input: string): Promise<string> {
  if (CHANNEL_ID_RE.test(input)) return input;

  // Try to extract handle or channel path from URL
  const match = CHANNEL_URL_RE.exec(input);
  if (match) {
    const candidate = match[1];
    if (CHANNEL_ID_RE.test(candidate)) return candidate;
    // It's a handle — fetch the channel page to get the real channel ID
    const channelUrl = input.startsWith('http') ? input : `https://www.youtube.com/${input}`;
    const html = await fetchText(channelUrl);
    const idMatch = /"channelId":"(UC[A-Za-z0-9_-]{22})"/.exec(html);
    if (idMatch) return idMatch[1];
  }

  throw new Error(
    `Cannot resolve channel ID from "${input}". Provide a full channel URL or a channel ID starting with UC.`,
  );
}

// ── pollChannel ────────────────────────────────────────────────────────────
/**
 * Fetches the RSS feed for a channel, diffs against the last known video,
 * and ingests any new videos (up to 15 per poll tick — the RSS feed max).
 */
export async function pollChannel(
  channelId: string,
  channelName: string,
  store: MemoryStore,
  embeddingsConfig: EmbeddingsConfig,
  youtubeConfig: YoutubeConfig,
): Promise<{ ingested: number }> {
  const feedUrl = `${FEED_BASE}${channelId}`;
  let xml: string;
  try {
    xml = await fetchText(feedUrl);
  } catch (e) {
    log.warn(
      `Failed to fetch RSS for channel ${channelId}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { ingested: 0 };
  }

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '_' });
  const parsed = parser.parse(xml) as {
    feed?: {
      entry?:
        | Array<{
            'yt:videoId'?: string;
            title?: string;
            published?: string;
          }>
        | {
            'yt:videoId'?: string;
            title?: string;
            published?: string;
          };
    };
  };

  const entries = parsed.feed?.entry
    ? Array.isArray(parsed.feed.entry)
      ? parsed.feed.entry
      : [parsed.feed.entry]
    : [];

  const db = getDb();
  const lastSyncedRow = db
    .prepare(
      `SELECT last_synced_at FROM watched_sources
       WHERE module_id = 'youtube' AND external_id = ?`,
    )
    .get(channelId) as { last_synced_at: number } | undefined;

  const lastSyncedAt = lastSyncedRow?.last_synced_at ?? 0;
  let ingested = 0;

  for (const entry of entries) {
    const videoId = entry['yt:videoId'];
    const publishedStr = entry.published;
    if (!videoId || !publishedStr) continue;

    const publishedAt = new Date(publishedStr as string).getTime();
    if (publishedAt <= lastSyncedAt) continue;

    const videoUrl = `https://www.youtube.com/watch?v=${videoId as string}`;
    try {
      await ingestYouTube(videoUrl, store, embeddingsConfig, youtubeConfig, {
        tags: [channelName, 'channel-watch'],
        sourceContext: `YouTube channel: ${channelName}`,
      });
      ingested++;
      log.info(`Ingested video ${videoId as string} from channel ${channelId}`);
    } catch (e) {
      log.warn(
        `Failed to ingest video ${videoId as string} from channel ${channelId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // Update last_synced_at
  db.prepare(
    `UPDATE watched_sources SET last_synced_at = ? WHERE module_id = 'youtube' AND external_id = ?`,
  ).run(Date.now(), channelId);

  return { ingested };
}

// ── importPlaylist ─────────────────────────────────────────────────────────
/**
 * Fetches a YouTube playlist page (public only), extracts video IDs from
 * ytInitialData JSON blob embedded in the HTML, and ingests new ones.
 */
export async function importPlaylist(
  playlistUrl: string,
  store: MemoryStore,
  embeddingsConfig: EmbeddingsConfig,
  youtubeConfig: YoutubeConfig,
  limit = 50,
): Promise<{ imported: number; skipped: number }> {
  const html = await fetchText(playlistUrl);

  // Extract ytInitialData JSON
  const match = /var ytInitialData = ({.+?});<\/script>/s.exec(html);
  if (!match) {
    throw new Error(
      'Could not parse playlist page. The playlist may be private or YouTube has changed its page structure.',
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error('ytInitialData JSON parse failed — YouTube may have changed page format.');
  }

  // Walk the deeply nested structure to extract video IDs
  const videoIds = extractVideoIds(data as Record<string, unknown>);
  const unique = [...new Set(videoIds)].slice(0, limit);

  if (!unique.length) {
    return { imported: 0, skipped: 0 };
  }

  // Check which are already ingested
  const db = getDb();
  const existing = new Set<string>(
    (
      db
        .prepare(
          `SELECT source_id FROM memories WHERE type = 'youtube' AND source_id IN (${unique
            .map(() => '?')
            .join(',')})`,
        )
        .all(...unique) as Array<{ source_id: string }>
    ).map((r) => r.source_id),
  );

  let imported = 0;
  let skipped = 0;

  for (const videoId of unique) {
    if (existing.has(`youtube:${videoId}`)) {
      skipped++;
      continue;
    }
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    try {
      await ingestYouTube(url, store, embeddingsConfig, youtubeConfig, {
        tags: ['watch-later', 'playlist-import'],
      });
      imported++;
    } catch (e) {
      log.warn(`Failed to ingest ${videoId}: ${e instanceof Error ? e.message : String(e)}`);
      skipped++;
    }
  }

  return { imported, skipped };
}

// ── startChannelCron ───────────────────────────────────────────────────────
/**
 * Starts the channel polling loop for all watched YouTube channels.
 * Called once at server startup from the YouTube module's onBoot().
 * The interval is configurable via config.youtube.channelPollIntervalMs (default 6h).
 */
export function startChannelCron(
  store: MemoryStore,
  embeddingsConfig: EmbeddingsConfig,
  youtubeConfig: YoutubeConfig,
): void {
  const intervalMs = youtubeConfig.channelPollIntervalMs ?? 21_600_000; // 6h default
  const db = getDb();

  async function tick() {
    const channels = db
      .prepare(
        `SELECT external_id, display_name FROM watched_sources
         WHERE module_id = 'youtube' AND enabled = 1`,
      )
      .all() as Array<{ external_id: string; display_name: string }>;

    if (!channels.length) return;
    log.info(`YouTube channel cron: polling ${channels.length} channel(s)`);

    for (const ch of channels) {
      try {
        const { ingested } = await pollChannel(
          ch.external_id,
          ch.display_name,
          store,
          embeddingsConfig,
          youtubeConfig,
        );
        if (ingested > 0) log.info(`  ${ch.display_name}: ingested ${ingested} new video(s)`);
      } catch (e) {
        log.error(
          `Channel poll error for ${ch.external_id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  // Run once immediately at startup, then on interval
  tick().catch((e) =>
    log.error(`Initial channel poll failed: ${e instanceof Error ? e.message : String(e)}`),
  );
  setInterval(
    () =>
      tick().catch((e) =>
        log.error(`Channel poll error: ${e instanceof Error ? e.message : String(e)}`),
      ),
    intervalMs,
  );

  log.info(`YouTube channel cron started (${intervalMs / 3_600_000}h interval)`);
}

// ── helpers ────────────────────────────────────────────────────────────────
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function extractVideoIds(obj: Record<string, unknown>): string[] {
  const ids: string[] = [];
  JSON.stringify(obj, (_key, value: unknown) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'videoId' in (value as object) &&
      typeof (value as Record<string, unknown>).videoId === 'string'
    ) {
      ids.push((value as Record<string, unknown>).videoId as string);
    }
    return value;
  });
  return ids;
}
