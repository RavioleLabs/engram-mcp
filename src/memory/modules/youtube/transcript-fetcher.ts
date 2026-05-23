// src/memory/modules/youtube/transcript-fetcher.ts
/**
 * YouTube transcript fetcher.
 *
 * Strategy:
 *   1. Fetch the video page HTML.
 *   2. Extract the player config containing `captionTracks`.
 *   3. Pick the preferred language track (or first available).
 *   4. Download the timedtext XML and parse into segments.
 *
 * Fallback: shell out to `yt-dlp --write-auto-sub --skip-download --sub-format vtt`
 *           if step 2/3 fails AND `yt-dlp` is on PATH AND config.fallbackToYtdlp is true.
 */
import { spawn } from 'child_process';
import { createLogger } from '../../../logger.js';
import type { YoutubeConfig } from '../../../config/schema.js';

const log = createLogger('youtube:transcript');

export interface YoutubeTranscriptSegment {
  start: number; // seconds
  duration: number;
  text: string;
}

export interface YoutubeTranscriptResult {
  video_id: string;
  title: string;
  channel: string;
  language: string;
  segments: YoutubeTranscriptSegment[];
  full_text: string;
}

export function extractVideoId(url: string): string {
  // Handle multiple URL shapes:
  //   https://www.youtube.com/watch?v=ID
  //   https://youtu.be/ID
  //   https://www.youtube.com/embed/ID
  //   https://www.youtube.com/shorts/ID
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /embed\/([A-Za-z0-9_-]{11})/,
    /shorts\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url; // raw id
  throw new Error(`Could not extract YouTube video id from: ${url}`);
}

export async function fetchTranscript(
  url: string,
  config: YoutubeConfig,
): Promise<YoutubeTranscriptResult> {
  const videoId = extractVideoId(url);
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Step 1: fetch watch page
  const resp = await fetch(watchUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15',
      'Accept-Language': `${config.preferLanguage},en;q=0.9`,
    },
  });
  if (!resp.ok) throw new Error(`YouTube watch page returned ${resp.status}`);
  const html = await resp.text();

  // Step 2: extract title + channel + captionTracks
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(/ - YouTube$/, '').trim() : videoId;
  const channelMatch = html.match(/"ownerChannelName":"([^"]+)"/);
  const channel = channelMatch ? channelMatch[1] : 'unknown';

  const captionsMatch = html.match(/"captionTracks":(\[[^\]]+\])/);
  if (!captionsMatch) {
    if (config.fallbackToYtdlp) {
      log.info(`No captionTracks in HTML for ${videoId} — falling back to yt-dlp`);
      return await fetchViaYtdlp(videoId, watchUrl, title, channel, config);
    }
    throw new Error(`No captions available for video ${videoId}`);
  }

  type CapTrack = { baseUrl: string; languageCode: string; kind?: string };
  const tracks = JSON.parse(captionsMatch[1]) as CapTrack[];
  const preferred =
    tracks.find((t) => t.languageCode === config.preferLanguage && t.kind !== 'asr') ??
    tracks.find((t) => t.languageCode === config.preferLanguage) ??
    tracks.find((t) => t.kind !== 'asr') ??
    tracks[0];
  if (!preferred) throw new Error('No usable caption track');

  // Step 3: download timedtext
  const xmlResp = await fetch(preferred.baseUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15',
      Referer: 'https://www.youtube.com/',
    },
  });
  if (!xmlResp.ok) throw new Error(`Timedtext fetch failed: ${xmlResp.status}`);
  const xml = await xmlResp.text();

  // Step 4: parse <text start="X" dur="Y">content</text>
  const segments: YoutubeTranscriptSegment[] = [];
  const re = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    segments.push({
      start: parseFloat(m[1]),
      duration: parseFloat(m[2]),
      text: decodeHtmlEntities(m[3]).replace(/\n/g, ' ').trim(),
    });
  }

  // YouTube's timedtext API may return empty XML even for videos with captions.
  // If we got 0 segments and yt-dlp fallback is enabled, use it.
  if (segments.length === 0 && config.fallbackToYtdlp) {
    log.info(`Timedtext returned 0 segments for ${videoId} — falling back to yt-dlp`);
    return await fetchViaYtdlp(videoId, watchUrl, title, channel, config);
  }

  if (segments.length === 0) {
    throw new Error(
      `No transcript segments found for video ${videoId}. Enable fallbackToYtdlp or check if the video has captions.`,
    );
  }

  return {
    video_id: videoId,
    title,
    channel,
    language: preferred.languageCode,
    segments,
    full_text: segments.map((s) => s.text).join(' '),
  };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function fetchViaYtdlp(
  videoId: string,
  url: string,
  title: string,
  channel: string,
  config: YoutubeConfig,
): Promise<YoutubeTranscriptResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang',
      `${config.preferLanguage},en`,
      '--skip-download',
      '--sub-format',
      'vtt',
      '--output',
      `/tmp/engram-yt-%(id)s.%(ext)s`,
      url,
    ];
    const child = spawn('yt-dlp', args);
    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', (e) =>
      reject(new Error(`yt-dlp not available: ${e.message}. Install via 'brew install yt-dlp'.`)),
    );
    child.on('exit', async (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-300)}`));
        return;
      }
      try {
        const fs = await import('fs');
        // Find the produced VTT file
        const candidates = fs
          .readdirSync('/tmp')
          .filter((n) => n.startsWith(`engram-yt-${videoId}`));
        const vttFile = candidates.find((n) => n.endsWith('.vtt'));
        if (!vttFile) throw new Error('yt-dlp produced no .vtt');
        const vtt = fs.readFileSync(`/tmp/${vttFile}`, 'utf-8');
        const segments = parseVtt(vtt);
        resolve({
          video_id: videoId,
          title,
          channel,
          language: config.preferLanguage,
          segments,
          full_text: segments.map((s) => s.text).join(' '),
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parseVtt(vtt: string): YoutubeTranscriptSegment[] {
  const segments: YoutubeTranscriptSegment[] = [];
  const re = /(\d+):(\d{2}):(\d{2})[.,](\d+) --> (\d+):(\d{2}):(\d{2})[.,](\d+)\n([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(vtt)) !== null) {
    const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
    segments.push({ start, duration: end - start, text: m[9].trim() });
  }
  return segments;
}
