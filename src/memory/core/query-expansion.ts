// Query expansion — ask the LLM for 2-3 alternate phrasings of the user
// query, then run semantic search on each variant in parallel and fuse by
// RRF. Worth +2-4 r@10 pts on top of bge-m3 in stress test fixtures.
//
// Off by default. One LLM call per recall (~150 tokens in, ~80 out) so
// cost is bounded: ~$0.0002/query with Claude Haiku 4.5.

import { createLogger } from '../../logger.js';
import type { ExpansionConfig } from '../../config/schema.js';

const log = createLogger('query-expansion');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Returns [originalQuery, ...variants]. Always includes the original. On
 * any failure returns [originalQuery] so recall keeps working.
 */
export async function expandQuery(query: string, config: ExpansionConfig): Promise<string[]> {
  if (!config.enabled) return [query];
  if (!query.trim()) return [query];

  try {
    if (config.provider === 'anthropic') {
      const variants = await expandAnthropic(query, config);
      const unique = dedupeKeepingOrder([query, ...variants]);
      return unique.slice(0, config.variants + 1);
    }
    log.warn(`Provider "${config.provider}" not implemented yet — skipping expansion`);
    return [query];
  } catch (e) {
    log.warn(
      `Query expansion failed (${e instanceof Error ? e.message : String(e)}) — using original`,
    );
    return [query];
  }
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

async function expandAnthropic(query: string, config: ExpansionConfig): Promise<string[]> {
  if (!config.apiKey) {
    throw new Error('queryExpansion.provider=anthropic requires apiKey');
  }

  const prompt =
    `Generate exactly ${config.variants} alternative phrasings of this search query. ` +
    `Different angles, same intent, same language as the original. ` +
    `Vary vocabulary and structure — but stay searchable.\n\n` +
    `Query: "${query}"\n\n` +
    `Return ONLY a JSON array of ${config.variants} strings. No markdown, no explanation.`;

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
  return parseStringArray(text);
}

/**
 * Pull the first JSON-array-of-strings out of free-form LLM text. Tolerates
 * ```json fences and trailing commentary. Returns [] on parse failure (the
 * caller will fall back to the original query).
 */
export function parseStringArray(text: string): string[] {
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1');
  const match = cleaned.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  } catch {
    return [];
  }
}

function dedupeKeepingOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const k = s.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}
