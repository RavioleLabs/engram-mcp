import { embedOpenAICompat } from './openai-compat.js';
import type { EmbeddingsConfig } from '../../config/schema.js';

export function embedOllama(text: string, config: EmbeddingsConfig): Promise<Float32Array> {
  return embedOpenAICompat(text, {
    baseUrl: config.baseUrl ?? 'http://localhost:11434',
    model: config.model,
    dimensions: config.dimensions,
  });
}
