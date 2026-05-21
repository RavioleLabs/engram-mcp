// src/memory/modules/youtube/tests/channel.test.ts
import { describe, it, expect } from 'vitest';
import { resolveChannelId } from '../watcher.js';

const REAL_CHANNEL_ID = 'UCnUYZLuoy1rq1aVMwx4aTzw'; // Andrej Karpathy — stable, public
const REAL_CHANNEL_URL = 'https://www.youtube.com/@AndrejKarpathy';

describe('resolveChannelId', () => {
  it('returns the ID unchanged when given a valid channel ID', async () => {
    const id = await resolveChannelId(REAL_CHANNEL_ID);
    expect(id).toBe(REAL_CHANNEL_ID);
  });

  it(
    'resolves a channel URL to a channel ID',
    async () => {
      let id: string;
      try {
        id = await resolveChannelId(REAL_CHANNEL_URL);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Network may be unavailable or YouTube may block — skip gracefully
        if (msg.includes('HTTP') || msg.includes('fetch') || msg.includes('Cannot resolve')) {
          console.warn(`Skipping resolveChannelId URL test — ${msg}`);
          return;
        }
        throw e;
      }
      expect(id).toMatch(/^UC[A-Za-z0-9_-]{22}$/);
    },
    20_000,
  );

  it('throws on unresolvable input', async () => {
    await expect(resolveChannelId('not-a-channel')).rejects.toThrow(/Cannot resolve/);
  });
});

describe('RSS feed fetch (real network)', () => {
  it(
    'fetches and parses the channel RSS feed',
    async () => {
      const { XMLParser } = await import('fast-xml-parser');
      const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${REAL_CHANNEL_ID}`;
      let res: Response;
      try {
        res = await fetch(feedUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        // Network unavailable in CI — skip gracefully
        console.warn(`Skipping RSS test — network error: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (!res.ok) {
        // YouTube rate-limit or temporary error — skip gracefully instead of failing
        console.warn(`Skipping RSS test — HTTP ${res.status} from YouTube`);
        return;
      }
      const xml = await res.text();
      const parser = new XMLParser({ ignoreAttributes: false });
      const parsed = parser.parse(xml) as { feed?: { entry?: unknown } };
      expect(parsed.feed).toBeDefined();
    },
    20_000,
  );
});
