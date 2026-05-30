// LLM rerank — second-stage ranking that asks an LLM to order the top
// candidates by relevance. RRF + tag-overlap brings us to ~92-96% r@10
// (with bge-m3); rerank pushes that toward 99% for the cases where the
// embedder ranked a close-but-wrong doc above the right one.
//
// Off by default — requires the user to (a) provide an API key and (b)
// enable it in config.rerank.enabled. Each rerank call is one LLM request,
// ~300 input + 50 output tokens, ~$0.0003 with Claude Haiku 4.5 (priced
// 2026-Q2). Cost-bounded by topN.
//
// The implementation only supports Anthropic for v0.7.0 — Cohere / OpenAI
// stubs reserved but route to a NotImplemented error so callers fail loud
// instead of silently bypassing the rerank.

import { createLogger } from '../../logger.js';
import type { SearchResult } from '../../types.js';

const log = createLogger('rerank');

export interface RerankConfig {
  enabled: boolean;
  provider: 'anthropic' | 'cohere' | 'openai';
  model: string;
  apiKey?: string;
  /** How many candidates we ask the LLM to rerank. Default 20. */
  topN: number;
  /** Hard request timeout. Default 15s. */
  timeoutMs: number;
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Rerank `candidates` by relevance to `query`. Returns the same array
 * reordered (length unchanged). Falls back to the input order on any
 * failure — recall must keep working even when the rerank backend hiccups.
 */
export async function llmRerank(
  query: string,
  candidates: SearchResult[],
  config: RerankConfig,
): Promise<SearchResult[]> {
  if (!config.enabled || candidates.length <= 1) return candidates;

  const slice = candidates.slice(0, config.topN);
  try {
    if (config.provider === 'anthropic') {
      const order = await rerankAnthropic(query, slice, config);
      const reordered = order.map((i) => slice[i]).filter((c): c is SearchResult => c != null);
      // Append candidates the LLM dropped (or that fell outside topN) so we
      // never silently lose results.
      const seen = new Set(reordered.map((c) => c.memory.id));
      const tail = candidates.filter((c) => !seen.has(c.memory.id));
      return [...reordered, ...tail];
    }
    log.warn(`Provider "${config.provider}" not implemented yet — skipping rerank`);
    return candidates;
  } catch (e) {
    log.warn(`Rerank failed (${e instanceof Error ? e.message : String(e)}) — keeping RRF order`);
    return candidates;
  }
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

async function rerankAnthropic(
  query: string,
  candidates: SearchResult[],
  config: RerankConfig,
): Promise<number[]> {
  if (!config.apiKey) {
    throw new Error('rerank.provider=anthropic requires apiKey (config or ANTHROPIC_API_KEY)');
  }

  const docs = candidates
    .map((c, i) => {
      const title = c.memory.properties.title?.toString().slice(0, 160) ?? '(no title)';
      const snippet = c.snippet?.slice(0, 400) ?? '';
      return `[${i}] title: ${title}\n     snippet: ${snippet}`;
    })
    .join('\n\n');

  const prompt =
    `Rank these ${candidates.length} documents by relevance to the query.\n\n` +
    `Query: "${query}"\n\n` +
    `Documents:\n${docs}\n\n` +
    `Return ONLY a JSON array of indices in descending relevance order, ` +
    `e.g. [3, 0, 7, 1]. No explanation, no markdown, just the array.`;

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!res.ok) {
    const tail = await res.text().catch(() => '');
    throw new Error(`Anthropic API HTTP ${res.status}: ${tail.slice(0, 200)}`);
  }

  const data = (await res.json()) as AnthropicResponse;
  if (data.error) throw new Error(`Anthropic API: ${data.error.message ?? 'unknown error'}`);

  const text = (data.content ?? []).map((c) => c.text ?? '').join('');
  return parseOrderJson(text, candidates.length);
}

/**
 * Pull the first JSON-array-of-integers out of free-form text. Tolerates
 * surrounding whitespace, mild markdown wrapping, and trailing commentary.
 * Throws if no parseable array is found.
 */
export function parseOrderJson(text: string, length: number): number[] {
  // Strip ```json fences if the model added them.
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1');
  const match = cleaned.match(/\[\s*(?:-?\d+\s*,\s*)*-?\d+\s*\]/);
  if (!match) {
    throw new Error(`No JSON array found in rerank response: ${cleaned.slice(0, 200)}`);
  }
  const parsed = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Rerank response is not an array');
  const ints = parsed
    .map((v) => (typeof v === 'number' ? Math.trunc(v) : NaN))
    .filter((n) => Number.isFinite(n) && n >= 0 && n < length);
  // Drop duplicates while preserving order — the LLM occasionally repeats
  // an index when it can't decide.
  const seen = new Set<number>();
  return ints.filter((n) => {
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}
