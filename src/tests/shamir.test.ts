// src/tests/shamir.test.ts
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { shamirSplit, shamirCombine } from '../sync/shamir.js';

describe('Shamir Secret Sharing', () => {
  it('round-trips a 32-byte KWK with 3-of-5', () => {
    const kwk = randomBytes(32);
    const shares = shamirSplit(kwk, 3, 5);

    expect(shares).toHaveLength(5);
    expect(shares[0].index).toBe(1);
    expect(shares[4].index).toBe(5);
    // All codes should be base32 (uppercase alpha + digits 2-7)
    for (const share of shares) {
      expect(share.code).toMatch(/^[A-Z2-7]+$/);
    }

    // Reconstruct from any 3 shares
    const reconstructed = shamirCombine([shares[0], shares[2], shares[4]]);
    expect(reconstructed).toStrictEqual(kwk);
  });

  it('round-trips with a different 3 shares', () => {
    const kwk = randomBytes(32);
    const shares = shamirSplit(kwk, 3, 5);
    const reconstructed = shamirCombine([shares[1], shares[3], shares[0]]);
    expect(reconstructed).toStrictEqual(kwk);
  });

  it('fails with only 2 shares (below threshold of 3)', () => {
    const kwk = randomBytes(32);
    const shares = shamirSplit(kwk, 3, 5);
    // 2 shares will produce garbage, not an error, due to SSS math —
    // but the length check on the result will catch it.
    // secrets.js-grempe returns a wrong value, not the original.
    const bad = shamirCombine([shares[0], shares[1]]);
    expect(bad).not.toStrictEqual(kwk);
  });

  it('rejects kwk not 32 bytes', () => {
    expect(() => shamirSplit(Buffer.from('short'), 3, 5)).toThrow(/32 bytes/);
  });

  it('rejects threshold < 2', () => {
    expect(() => shamirSplit(randomBytes(32), 1, 5)).toThrow(/threshold/);
  });

  it('rejects total < threshold', () => {
    expect(() => shamirSplit(randomBytes(32), 5, 3)).toThrow(/total/);
  });

  it('codes survive lowercasing + whitespace in recovery form entry', () => {
    const kwk = randomBytes(32);
    const shares = shamirSplit(kwk, 3, 5);

    // Simulate user copy-pasting with a lowercase letter or extra space
    const noisyShares = [
      { ...shares[0], code: shares[0].code.toLowerCase() },
      { ...shares[2], code: '  ' + shares[2].code + '  ' },
      { ...shares[4], code: shares[4].code },
    ];
    const reconstructed = shamirCombine(noisyShares);
    expect(reconstructed).toStrictEqual(kwk);
  });
});
