// src/sync/shamir.ts
/**
 * Thin wrapper around secrets.js-grempe for Shamir Secret Sharing.
 *
 * Splits a 32-byte Buffer into `total` hex-encoded shares, any `threshold`
 * of which can reconstruct the original.  Shares are base32-encoded for
 * safe transmission over email (no case-sensitivity issues, no ambiguous chars).
 *
 * We operate on the Key-Wrapping Key (KWK), NOT the master key or passphrase.
 */
import secrets from 'secrets.js-grempe';
import { createLogger } from '../logger.js';

const log = createLogger('shamir');

/** Base32 alphabet (RFC 4648 without padding) */
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode a secrets.js share string (hex-encoded ASCII) as base32.
 * The share from secrets.js-grempe is a hex string like "8011ab..."; we encode
 * its ASCII bytes (not the decoded binary) so the round-trip is exact regardless
 * of whether the hex string has odd or even length.
 */
function shareToBase32(hexShare: string): string {
  // Treat each ASCII character of the hex share as a byte
  const bytes = Buffer.from(hexShare, 'ascii');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Decode a base32 string back to the secrets.js share hex string.
 */
function base32ToShare(b32: string): string {
  const clean = b32
    .toUpperCase()
    .replace(/\s/g, '')
    .replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const byteArr: number[] = [];
  for (const char of clean) {
    const idx = B32_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base32 char: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      byteArr.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(byteArr).toString('ascii');
}

export interface ShamirShare {
  /** 1-based index of this share */
  index: number;
  /** Base32-encoded share for safe email delivery */
  code: string;
}

/**
 * Split a 32-byte key-wrapping key into `total` shares, requiring `threshold`
 * to reconstruct.
 *
 * @param kwk   32-byte Buffer (the key-wrapping key)
 * @param threshold  minimum shares to reconstruct (e.g. 3)
 * @param total      total number of shares (e.g. 5)
 */
export function shamirSplit(kwk: Buffer, threshold: number, total: number): ShamirShare[] {
  if (kwk.length !== 32) throw new Error('KWK must be 32 bytes');
  if (threshold < 2) throw new Error('threshold must be >= 2');
  if (total < threshold) throw new Error('total must be >= threshold');

  const hexSecret = kwk.toString('hex');
  const hexShares: string[] = secrets.share(hexSecret, total, threshold);

  log.info(`Shamir split: ${total} shares, threshold ${threshold}`);

  return hexShares.map((hexShare, i) => ({
    index: i + 1,
    code: shareToBase32(hexShare),
  }));
}

/**
 * Reconstruct the 32-byte KWK from at least `threshold` shares.
 *
 * @param shares  Array of ShamirShare (any order, only threshold needed)
 */
export function shamirCombine(shares: ShamirShare[]): Buffer {
  if (shares.length < 2) throw new Error('Need at least 2 shares to combine');

  const hexShares = shares.map((s) => base32ToShare(s.code));
  const hexSecret = secrets.combine(hexShares);

  const kwk = Buffer.from(hexSecret, 'hex');
  // Note: with fewer shares than threshold, secrets.js-grempe returns garbage of
  // a different length — callers should validate length === 32 before trusting the result.
  if (kwk.length === 32) {
    log.info(`Shamir combine: reconstructed KWK from ${shares.length} shares`);
  } else {
    log.warn(
      `Shamir combine: reconstructed key has unexpected length ${kwk.length} — wrong key or insufficient shares`,
    );
  }
  return kwk;
}
