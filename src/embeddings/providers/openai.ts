import { embedOpenAICompat } from './openai-compat.js';
import type { EmbeddingsConfig } from '../../config/schema.js';

export function embedOpenAI(text: string, config: EmbeddingsConfig): Promise<Float32Array> {
  if (!config.apiKey) throw new Error('OpenAI requires apiKey');
  return embedOpenAICompat(text, {
    baseUrl: config.baseUrl ?? 'https://api.openai.com',
    model: config.model,
    apiKey: config.apiKey,
    dimensions: config.dimensions,
  });
}
