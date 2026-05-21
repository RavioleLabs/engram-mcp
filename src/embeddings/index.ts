/**
 * Embedding dispatcher — routes to the configured provider.
 *
 * Supported providers:
 *   - ollama          (local, Free default — nomic-embed-text)
 *   - engram          (hosted Pro tier — api.engram-mcp.com, requires apiKey)
 *   - voyage          (Voyage AI, requires apiKey)
 *   - openai          (OpenAI, requires apiKey)
 *   - openai-compatible (BYO endpoint, requires baseUrl)
 */

import { createLogger } from '../logger.js';
import type { EmbeddingsConfig } from '../config/schema.js';
import { embedOllama } from './providers/ollama.js';
import { embedEngram, QuotaFallbackError } from './providers/engram.js';
import { embedVoyage } from './providers/voyage.js';
import { embedOpenAI } from './providers/openai.js';
import { embedOpenAICompat } from './providers/openai-compat.js';

const log = createLogger('embeddings');

// ─── Session-level fallback flag ──────────────────────────────────────────────
// Set to true when the hosted endpoint signals quota exhaustion (used_fallback).
// All subsequent requests in this process session use Ollama directly.
let _sessionFallbackActive = false;

/** Exported for testing — reset between test runs */
export function resetSessionFallback(): void {
  _sessionFallbackActive = false;
}

// ─── Core embed call ──────────────────────────────────────────────────────────

/**
 * Embed a single text string. Returns a Float32Array of the embedding vector.
 *
 * When provider is 'engram'/'engram-hosted' and the hosted endpoint returns
 * {used_fallback: true}, automatically retries via local Ollama and marks the
 * session so future calls skip the hosted endpoint entirely.
 */
export async function embed(text: string, config: EmbeddingsConfig): Promise<Float32Array> {
  switch (config.provider) {
    case 'ollama':
      return embedOllama(text, config);
    case 'engram':
    case 'engram-hosted': {
      // If this session already fell back, skip to Ollama immediately
      if (_sessionFallbackActive) {
        return embedOllama(text, config);
      }
      try {
        return await embedEngram(text, config);
      } catch (e) {
        if (e instanceof QuotaFallbackError) {
          _sessionFallbackActive = true;
          log.info(
            `Session fallback active — all embeddings this session will use local Ollama. ` +
            `Hosted quota resets: ${e.exhaustedUntil ?? 'next month'}.`,
          );
          return embedOllama(text, config);
        }
        throw e;
      }
    }
    case 'voyage':
      return embedVoyage(text, config);
    case 'openai':
      return embedOpenAI(text, config);
    case 'openai-compatible':
      if (!config.baseUrl) throw new Error('openai-compatible requires baseUrl');
      return embedOpenAICompat(text, {
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey,
        dimensions: config.dimensions,
      });
    default:
      throw new Error(`Unknown embeddings provider: ${(config as { provider: string }).provider}`);
  }
}

/**
 * Embed multiple texts sequentially (avoids overwhelming the provider).
 */
export async function embedBatch(
  texts: string[],
  config: EmbeddingsConfig,
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (const t of texts) out.push(await embed(t, config));
  return out;
}

// ─── Math ─────────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    nA = 0,
    nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA += a[i] * a[i];
    nB += b[i] * b[i];
  }
  if (nA === 0 || nB === 0) return 0;
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}

// ─── SQLite serialization ─────────────────────────────────────────────────────

export function serializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer);
}

export function deserializeEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ─── Health check ─────────────────────────────────────────────────────────────

export async function checkEmbeddingModel(config: EmbeddingsConfig): Promise<boolean> {
  try {
    await embed('test', config);
    log.info(`Embedding model ready: ${config.provider}/${config.model}`);
    return true;
  } catch (e) {
    log.warn(`Embedding model unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
