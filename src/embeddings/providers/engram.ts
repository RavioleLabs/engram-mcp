/**
 * Engram-hosted embeddings (Pro tier).
 * Calls POST api.engram-mcp.com/api/embeddings with batch format.
 * Auth: Bearer <engramAccount.apiKey> from ~/.engram/config.json.
 *
 * Falls back gracefully on quota errors with clear messages.
 * When the server returns used_fallback:true, throws QuotaFallbackError
 * so the dispatcher can transparently retry with local Ollama.
 */
import { createLogger } from '../../logger.js';
import type { EmbeddingsConfig } from '../../config/schema.js';

const log = createLogger('embeddings:engram');

const ENGRAM_DEFAULT_BASE_URL = 'https://api.engram-mcp.com';

/**
 * Thrown when the hosted endpoint returns {used_fallback: true}.
 * The dispatcher catches this and retries with Ollama.
 */
export class QuotaFallbackError extends Error {
  readonly exhaustedUntil?: string;
  constructor(message: string, exhaustedUntil?: string) {
    super(message);
    this.name = 'QuotaFallbackError';
    this.exhaustedUntil = exhaustedUntil;
  }
}

/**
 * Embed a single text via the Engram-hosted endpoint.
 * Internally uses the batch API (texts: [text]) and returns the first vector.
 *
 * Throws QuotaFallbackError when the server indicates fallback mode.
 */
export async function embedEngram(text: string, config: EmbeddingsConfig): Promise<Float32Array> {
  if (!config.apiKey) {
    throw new Error(
      'Engram-hosted embeddings require an apiKey (Pro tier). ' +
      'Get yours at https://engram-mcp.com/settings, or switch provider to "ollama" in ~/.engram/config.json.',
    );
  }

  const baseUrl = (config.baseUrl ?? ENGRAM_DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/api/embeddings`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ texts: [text] }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `Engram embeddings network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Parse body first so we can check used_fallback on 200
  const body = await res.text();
  let data: {
    embeddings?: number[][];
    tokens_used?: number;
    tokens_remaining?: number;
    overage_billed?: boolean;
    used_fallback?: boolean;
    message?: string;
    quota_exhausted_until?: string;
    error?: string;
  } = {};
  try { data = JSON.parse(body); } catch { /* ignore */ }

  // Fallback signal — server says "use local provider"
  if (res.ok && data.used_fallback) {
    const msg = data.message ?? 'Hosted embedding quota exhausted.';
    log.warn(`Hosted embeddings quota exhausted: ${msg}`);
    log.info('Falling back to local Ollama provider for this and future requests this session.');
    throw new QuotaFallbackError(msg, data.quota_exhausted_until);
  }

  if (!res.ok) {
    if (res.status === 403 || data.error === 'pro_required') {
      throw new Error(
        'Engram-hosted embeddings require a Pro subscription ($9/mo). ' +
        'Upgrade at https://engram-mcp.com/billing, or switch provider to "ollama".',
      );
    }
    if (res.status === 402 || data.error === 'quota_exceeded') {
      throw new Error(
        'Engram embedding quota exceeded for this month (block mode). ' +
        'Change overage_mode in your dashboard, or wait for the next billing cycle.',
      );
    }
    throw new Error(`Engram embeddings API ${res.status}: ${body.slice(0, 200)}`);
  }

  if (data.overage_billed) {
    log.warn(
      `Engram embeddings overage billed — ${data.tokens_used} tokens used this request. ` +
      `Check your usage at https://engram-mcp.com/dashboard.`,
    );
  }

  const vec = data.embeddings?.[0];
  if (!vec?.length) throw new Error('Engram embeddings API returned empty vector');

  if (config.dimensions && vec.length !== config.dimensions) {
    log.warn(
      `Embedding dim ${vec.length} does not match config dim ${config.dimensions} — accepting anyway`,
    );
  }

  return new Float32Array(vec);
}
