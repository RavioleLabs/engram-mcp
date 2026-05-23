// src/memory/modules/youtube/tests/transcript-fetcher.test.ts
import { describe, it, expect } from 'vitest';
import { extractVideoId, fetchTranscript } from '../transcript-fetcher.js';

// Note: YouTube's timedtext API frequently returns empty XML for videos even when captions
// exist in captionTracks. We enable yt-dlp fallback for reliable transcript retrieval.
const config = { enabled: true, preferLanguage: 'en', fallbackToYtdlp: true };

// Stable target: TED Talk Sir Ken Robinson "Do schools kill creativity?"
// (long-standing video with reliable English captions)
const TEST_URL = 'https://www.youtube.com/watch?v=iG9CE55wbtY';

describe('youtube transcript fetcher', () => {
  it('extracts video id from various URL shapes', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=iG9CE55wbtY')).toBe('iG9CE55wbtY');
    expect(extractVideoId('https://youtu.be/iG9CE55wbtY')).toBe('iG9CE55wbtY');
    expect(extractVideoId('iG9CE55wbtY')).toBe('iG9CE55wbtY');
  });

  it('fetches an English transcript for a known video', async () => {
    const result = await fetchTranscript(TEST_URL, config);
    expect(result.video_id).toBe('iG9CE55wbtY');
    expect(result.segments.length).toBeGreaterThan(50);
    expect(result.full_text.toLowerCase()).toContain('creativity');
  }, 60_000);
});
