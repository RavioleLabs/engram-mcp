import { createLogger } from '../../logger.js';

const log = createLogger('embeddings:openai-compat');

export async function embedOpenAICompat(
  text: string,
  options: { baseUrl: string; model: string; apiKey?: string; dimensions: number },
): Promise<Float32Array> {
  const url = `${options.baseUrl.replace(/\/$/, '')}/v1/embeddings`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: options.model, input: text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
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
}
