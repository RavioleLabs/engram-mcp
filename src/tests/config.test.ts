import { describe, it, expect } from 'vitest';
import { EngramConfigSchema, defaultConfig } from '../config/schema.js';

describe('EngramConfig schema', () => {
  it('accepts the default config', () => {
    expect(() => EngramConfigSchema.parse(defaultConfig)).not.toThrow();
  });

  it('requires embeddings.model', () => {
    const bad = { ...defaultConfig, embeddings: { provider: 'ollama' } };
    expect(() => EngramConfigSchema.parse(bad)).toThrow();
  });
});

describe('EngramConfig propertyExtraction', () => {
  it('default config has property extraction disabled (calling agent provides title/tags)', () => {
    expect(defaultConfig.propertyExtraction.enabled).toBe(false);
    expect(defaultConfig.propertyExtraction.model).toBe('llama3.2:3b'); // model still set for opt-in case
  });

  it('parses a config that enables property extraction', () => {
    const cfg = {
      ...defaultConfig,
      propertyExtraction: { ...defaultConfig.propertyExtraction, enabled: true },
    };
    expect(() => EngramConfigSchema.parse(cfg)).not.toThrow();
  });
});
