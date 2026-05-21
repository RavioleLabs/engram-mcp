import { embedOpenAICompat } from './openai-compat.js';
import type { EmbeddingsConfig } from '../../config/schema.js';

export function embedVoyage(text: string, config: EmbeddingsConfig): Promise<Float32Array> {
  if (!config.apiKey) throw new Error('Voyage AI requires apiKey');
  return embedOpenAICompat(text, {
    baseUrl: config.baseUrl ?? 'https://api.voyageai.com',
    model: config.model,
    apiKey: config.apiKey,
    dimensions: config.dimensions,
  });
}
