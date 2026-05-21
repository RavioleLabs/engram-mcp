// src/memory/modules/audio/tests/transcriber.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { transcribeAudio } from '../transcriber.js';

const TEST_AUDIO = path.join(import.meta.dirname, 'fixtures', 'hello.wav');

describe('whisper transcriber (real whisper.cpp)', () => {
  it('skips if test audio is not present', () => {
    if (!fs.existsSync(TEST_AUDIO)) {
      console.warn(`Test audio not found: ${TEST_AUDIO}. Create it with:`);
      console.warn(`  say -o ${TEST_AUDIO} --data-format=LEF32@16000 'hello world this is a test'`);
      return;
    }
  });

  it(
    'transcribes a short audio file',
    async () => {
      if (!fs.existsSync(TEST_AUDIO)) return; // skip when fixture missing

      const result = await transcribeAudio(TEST_AUDIO, {
        enabled: true,
        model: 'tiny.en',
        language: 'en',
      });
      expect(result.full_text.toLowerCase()).toMatch(/hello|test/);
      expect(result.segments.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
