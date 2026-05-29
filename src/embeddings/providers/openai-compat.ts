import { createLogger } from '../../logger.js';

const log = createLogger('embeddings:openai-compat');

// Sustained-reindex stress test (specs/2026-05-29 §R12) showed Ollama
// dropping ~2/600 requests with AbortError under continuous load. Wrap the
// fetch in a bounded retry+backoff so a one-doc transient blip doesn't kill
// the whole reindex. Heavier providers (Voyage, OpenAI) also rate-limit
// occasionally — same pattern handles both.
const MAX_RETRIES = 4;
const BACKOFF_MS = [1000, 2000, 4000, 8000];
const REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS ?? 60_000);

function isTransient(e: unknown): boolean {
  if (!e) return false;
  const msg = e instanceof Error ? e.message : String(e);
  return /timeout|abort|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|HTTP 5\d\d|HTTP 429/i.test(
    msg,
  );
}

export async function embedOpenAICompat(
  text: string,
  options: { baseUrl: string; model: string; apiKey?: string; dimensions: number },
): Promise<Float32Array> {
  const url = `${options.baseUrl.replace(/\/$/, '')}/v1/embeddings`;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: options.model, input: text }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Embedding API HTTP ${res.status}: ${body.slice(0, 200)}`);
        if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
          lastErr = err;
          log.warn(
            `HTTP ${res.status} from embedding API, retry ${attempt + 1}/${MAX_RETRIES} in ${
              BACKOFF_MS[attempt]
            }ms…`,
          );
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
          continue;
        }
        throw err;
      }
      const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
      const vec = data.data[0]?.embedding;
      if (!vec?.length) throw new Error('Embedding API returned empty vector');
      if (vec.length !== options.dimensions) {
        log.warn(
          `Embedding dim ${vec.length} does not match config dim ${options.dimensions} — accepting anyway`,
        );
      }
      return new Float32Array(vec);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES && isTransient(e)) {
        log.warn(
          `Embedding request failed (${e instanceof Error ? e.message : e}), ` +
            `retry ${attempt + 1}/${MAX_RETRIES} in ${BACKOFF_MS[attempt]}ms…`,
        );
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error('Embedding API: unknown error after retries');
}
