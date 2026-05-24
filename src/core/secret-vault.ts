/**
 * Secret vault — at-rest encryption for OAuth client secrets and similar
 * long-lived plaintext credentials stored in ~/.engram/config.json.
 *
 * Threat model: defend against accidental disclosure of config.json (support
 * ticket attachments, backup tools that capture .json but miss .key, log
 * captures, GitHub gists). NOT a defense against an attacker with full local
 * user privileges — they can read both config.json (mode 0600) AND the key
 * file (also mode 0600) next to it. Hardware-backed keychains (macOS
 * Keychain, Windows DPAPI, libsecret on Linux) would close that gap but
 * require platform-specific code paths; this vault is the pragmatic middle.
 *
 * Format on disk:
 *   plaintext:  "abc123…"  (legacy / user-pasted, still accepted)
 *   encrypted:  "enc:v1:<nonce_b64>:<ct_b64>"  (output of encryptSecret)
 *
 * Algorithm: libsodium secretbox (XSalsa20-Poly1305).
 * Key:      32 bytes from ~/.engram/secret.key (mode 0600), generated on
 *           first use if missing.
 *
 * Migration: call `engram-mcp secrets encrypt` to rewrite config.json with
 * encrypted values. Plain values keep working until rewritten.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sodium from 'libsodium-wrappers';

const KEY_PATH = path.join(os.homedir(), '.engram', 'secret.key');
const ENC_PREFIX = 'enc:v1:';

let cachedKey: Uint8Array | null = null;
let sodiumReady = false;

async function ensureSodium(): Promise<void> {
  if (sodiumReady) return;
  await sodium.ready;
  sodiumReady = true;
}

function loadOrCreateKey(): Uint8Array {
  if (cachedKey) return cachedKey;

  if (fs.existsSync(KEY_PATH)) {
    try {
      const raw = fs.readFileSync(KEY_PATH);
      if (raw.length !== 32) {
        throw new Error(`secret.key is ${raw.length} bytes, expected 32`);
      }
      cachedKey = new Uint8Array(raw);
      return cachedKey;
    } catch (e) {
      throw new Error(
        `Failed to read ${KEY_PATH}: ${(e as Error).message}. ` +
          `If you've lost this key, encrypted config values can no longer be decrypted.`,
      );
    }
  }

  // Generate fresh key. Use umask to ensure 0o600 atomically.
  const prevUmask = process.umask(0o077);
  try {
    fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true, mode: 0o700 });
    const key = new Uint8Array(32);
    // Browser-style API works in Node 22 (subtle crypto)
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(key);
    } else {
      // Fallback for older Node: this branch should never run on engines.node>=22
      throw new Error('crypto.getRandomValues not available');
    }
    fs.writeFileSync(KEY_PATH, Buffer.from(key), { mode: 0o600 });
    // Belt-and-suspenders chmod in case umask was ignored
    try {
      fs.chmodSync(KEY_PATH, 0o600);
    } catch {
      /* best effort */
    }
    cachedKey = key;
    return cachedKey;
  } finally {
    process.umask(prevUmask);
  }
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * Encrypt a plaintext value for at-rest storage. Returns the `enc:v1:…` form
 * suitable for round-tripping through config.json.
 */
export async function encryptSecret(plaintext: string): Promise<string> {
  await ensureSodium();
  const key = loadOrCreateKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, key);
  return `${ENC_PREFIX}${sodium.to_base64(
    nonce,
    sodium.base64_variants.ORIGINAL,
  )}:${sodium.to_base64(ct, sodium.base64_variants.ORIGINAL)}`;
}

/**
 * Decrypt a stored value. Plaintext values (no `enc:v1:` prefix) pass through
 * unchanged so legacy configs and user-pasted secrets keep working.
 */
export async function decryptSecret(stored: string): Promise<string> {
  if (!isEncrypted(stored)) return stored;
  await ensureSodium();
  const key = loadOrCreateKey();
  const parts = stored.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 2) {
    throw new Error('Encrypted secret malformed: expected enc:v1:<nonce>:<ciphertext>');
  }
  const [nonceB64, ctB64] = parts;
  const nonce = sodium.from_base64(nonceB64, sodium.base64_variants.ORIGINAL);
  const ct = sodium.from_base64(ctB64, sodium.base64_variants.ORIGINAL);
  const plain = sodium.crypto_secretbox_open_easy(ct, nonce, key);
  return sodium.to_string(plain);
}

/**
 * Sync convenience wrapper for callers that already awaited sodium.ready
 * elsewhere (or accept the async-init blocking on first call). Not exported
 * to avoid encouraging sync usage in module-load paths.
 */
