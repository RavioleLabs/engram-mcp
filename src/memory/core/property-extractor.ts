import { createLogger } from '../../logger.js';
import type { PropertyExtractionConfig } from '../../config/schema.js';
import type { MemoryProperties } from '../../types.js';

const log = createLogger('property-extractor');

interface ExtractedPartial {
  title?: string;
  tags?: string[];
  sentiment?: 'positive' | 'neutral' | 'negative';
  action_required?: boolean;
  summary?: string;
}

/**
 * OSS basic extraction prompt — asks only for title + tags (2 fields).
 * The private extension overrides this with a richer 5-field prompt.
 */
const SYSTEM_PROMPT_BASIC = `You extract structured metadata from arbitrary text.
Output strict JSON with these fields:
  - title: a 3-7 word title summarizing the text (string)
  - tags: 3-5 lowercase keywords or short phrases (string[])
Output ONLY valid JSON. No explanation, no markdown fences.`;

export async function extractProperties(
  content: string,
  config: PropertyExtractionConfig,
  systemPromptOverride?: string,
): Promise<Partial<MemoryProperties> & { summary?: string }> {
  if (!config.enabled) return {};

  const SYSTEM_PROMPT = systemPromptOverride ?? SYSTEM_PROMPT_BASIC;

  const truncated = content.slice(0, 4000);
  const url = `${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: truncated },
        ],
        temperature: 0,
        max_tokens: config.maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      log.warn(`Property extraction failed: HTTP ${res.status}`);
      return {};
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return {};

    const parsed = parseJsonLenient(text) as ExtractedPartial | null;
    if (!parsed) return {};

    return {
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 200) : undefined,
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((t): t is string => typeof t === 'string').slice(0, 10)
        : undefined,
      sentiment:
        parsed.sentiment === 'positive' ||
        parsed.sentiment === 'neutral' ||
        parsed.sentiment === 'negative'
          ? parsed.sentiment
          : undefined,
      action_required:
        typeof parsed.action_required === 'boolean' ? parsed.action_required : undefined,
      custom: parsed.summary ? { summary: parsed.summary.slice(0, 500) } : undefined,
    };
  } catch (e) {
    log.warn(`Property extraction error: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

function parseJsonLenient(text: string): unknown {
  // Strip markdown code fences if present
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // Try to find first { ... } block
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
