// src/memory/modules/audio/transcriber.ts
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createLogger } from '../../../logger.js';
import type { WhisperConfig, EngramConfig } from '../../../config/schema.js';

const log = createLogger('audio:transcriber');

export interface TranscriptSegment {
  start: number; // seconds
  end: number; // seconds
  text: string;
}

export interface TranscriptResult {
  language: string;
  duration: number;
  segments: TranscriptSegment[];
  full_text: string;
}

// Shape of the JSON file written by whisper-cli -oj -ojf
interface WhisperJsonOutput {
  result?: { language?: string };
  transcription: Array<{
    timestamps: { from: string; to: string };
    text: string;
  }>;
}

/**
 * Transcribe audio using the configured provider.
 * - provider: "local"          → whisper.cpp via nodejs-whisper (default, free)
 * - provider: "engram-hosted"  → POST to api.engram-mcp.com/api/whisper (Pro)
 *   Falls back to local whisper if the API call fails and local whisper is available.
 */

import { ENGRAM_API_BASE } from '../../../cloud/endpoints.js';
export async function transcribeAudio(
  audioPath: string,
  config: WhisperConfig,
  engramConfig?: EngramConfig,
): Promise<TranscriptResult> {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const provider: string = config.provider ?? 'local';

  if (provider === 'engram-hosted') {
    try {
      return await transcribeEngram(audioPath, engramConfig);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Engram-hosted whisper failed (${msg}), falling back to local whisper.cpp`);
      // Fall through to local transcription
    }
  }

  return transcribeLocal(audioPath, config);
}

// ── Engram-hosted transcription ───────────────────────────────────────────────

async function transcribeEngram(
  audioPath: string,
  engramConfig?: EngramConfig,
): Promise<TranscriptResult> {
  const apiKey = engramConfig?.engramAccount?.apiKey;
  if (!apiKey) {
    throw new Error(
      'Engram-hosted whisper requires an API key. ' +
        'Set engramAccount.apiKey in ~/.engram/config.json or switch whisper.provider to "local".',
    );
  }

  const baseUrl = ENGRAM_API_BASE.replace(/\/$/, '');
  const url = `${baseUrl}/api/whisper`;

  const audioBuffer = fs.readFileSync(audioPath);
  const audioDurationSeconds = estimateAudioDuration(audioBuffer);

  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: 'audio/wav' });
  formData.append('audio', blob, path.basename(audioPath));

  log.info(`Transcribing ${audioPath} via Engram-hosted whisper (~${audioDurationSeconds}s)`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'X-Audio-Duration-Seconds': String(audioDurationSeconds),
    },
    body: formData,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text();
    let parsed: { error?: string } = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* ignore */
    }

    if (res.status === 403 || parsed.error === 'pro_required') {
      throw new Error(
        'Engram-hosted whisper requires a Pro subscription ($9/mo). ' +
          'Upgrade at https://engram-mcp.com/billing, or switch whisper.provider to "local".',
      );
    }
    if (res.status === 402 || parsed.error === 'quota_exceeded') {
      throw new Error(
        'Engram whisper quota exceeded for this month. ' +
          'Enable overage in your account, or wait for the next billing cycle.',
      );
    }
    throw new Error(`Engram whisper API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    transcript: string;
    language: string;
    seconds_used: number;
    seconds_remaining: number;
    overage_billed?: boolean;
  };

  if (data.overage_billed) {
    log.warn(
      `Engram whisper overage billed — ${data.seconds_used}s used this request. ` +
        `Check your usage at https://engram-mcp.com/billing.`,
    );
  }

  log.info(
    `Engram-hosted whisper complete — ${data.seconds_used}s billed, ${data.seconds_remaining}s remaining`,
  );

  const fullText = data.transcript ?? '';
  return {
    language: data.language ?? 'unknown',
    duration: audioDurationSeconds,
    segments: fullText ? [{ start: 0, end: audioDurationSeconds, text: fullText }] : [],
    full_text: fullText,
  };
}

/**
 * Rough audio duration estimate from file size.
 * Assumes 16kHz mono WAV (~16KB/s). Accurate enough for billing rounding.
 */
function estimateAudioDuration(buffer: Buffer): number {
  return Math.max(1, Math.ceil(buffer.length / 16_000));
}

// ── Local whisper.cpp transcription (original implementation) ─────────────────

async function transcribeLocal(
  audioPath: string,
  config: WhisperConfig,
): Promise<TranscriptResult> {
  const { nodewhisper } = (await import('nodejs-whisper')) as typeof import('nodejs-whisper');

  const startMs = Date.now();
  log.info(`Transcribing ${audioPath} with local whisper model=${config.model}`);

  // nodewhisper will write <audioPath>.json alongside the audio file
  const jsonOutputPath = `${audioPath}.json`;
  // Remove stale JSON if present
  if (fs.existsSync(jsonOutputPath)) fs.unlinkSync(jsonOutputPath);

  // nodejs-whisper's Logger type now requires the full Console interface (TS 5.7.3+).
  // Our app logger only has log/debug/info/warn/error — cast away the extras since
  // nodejs-whisper only calls those 5 in practice.
  const whisperLogger = { ...log, log: log.info } as unknown as Console;

  const rawResult = (await nodewhisper(audioPath, {
    modelName: config.model,
    autoDownloadModelName: config.model,
    removeWavFileAfterTranscription: false,
    withCuda: false,
    logger: whisperLogger,
    whisperOptions: {
      outputInText: false,
      outputInVtt: false,
      outputInSrt: false,
      outputInCsv: false,
      outputInJson: true,
      outputInJsonFull: true,
      outputInWords: false,
      outputInLrc: false,
      translateToEnglish: false,
      wordTimestamps: false,
      timestamps_length: 20,
      splitOnWord: false,
    },
  })) as unknown;

  let segments: TranscriptSegment[] = [];
  let detectedLanguage = config.language === 'auto' ? 'unknown' : config.language;

  // Prefer the JSON file written by whisper-cli for structured segment data
  if (fs.existsSync(jsonOutputPath)) {
    try {
      const jsonText = fs.readFileSync(jsonOutputPath, 'utf-8');
      const parsed = JSON.parse(jsonText) as WhisperJsonOutput;
      if (parsed.result?.language) detectedLanguage = parsed.result.language;
      if (Array.isArray(parsed.transcription)) {
        segments = parsed.transcription.map((s) => ({
          start: parseTimestamp(s.timestamps.from),
          end: parseTimestamp(s.timestamps.to),
          text: s.text.trim(),
        }));
      }
    } catch (e) {
      log.warn(`Failed to parse whisper JSON output at ${jsonOutputPath}: ${e}`);
    }
  }

  // Fallback: parse stdout as plain text
  if (segments.length === 0) {
    const rawStr = String(rawResult).trim();
    if (rawStr) {
      segments = [{ start: 0, end: 0, text: rawStr }];
    }
  }

  const elapsed = Date.now() - startMs;
  log.info(`Transcribed ${audioPath} in ${elapsed}ms — ${segments.length} segments`);

  return {
    language: detectedLanguage,
    duration: segments.length ? segments[segments.length - 1].end : 0,
    segments,
    full_text: segments.map((s) => s.text).join('\n'),
  };
}

function parseTimestamp(ts: string): number {
  // Format: "00:00:01,234" or "00:00:01.234"
  const match = ts.match(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d+)/);
  if (!match) return 0;
  const [, h, m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

export function getWhisperModelDir(): string {
  const home = process.env.DATA_DIR
    ? process.env.DATA_DIR.replace(/^~/, os.homedir())
    : path.join(os.homedir(), '.engram');
  return path.join(home, 'whisper-models');
}
