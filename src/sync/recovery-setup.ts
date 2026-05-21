// src/sync/recovery-setup.ts
/**
 * Opt-in recovery shards setup flow — runs on the user's PC.
 *
 * Steps:
 *   1. Generate a random 32-byte Key-Wrapping Key (KWK).
 *   2. Encrypt the current master key with KWK → mk_ciphertext.
 *   3. Split KWK into 5 Shamir shares (3-of-5).
 *   4. POST /saves/recovery/initiate with shares + mk_ciphertext.
 *      - Sends each share code to the corresponding trusted email via Resend
 *        (the cloud worker handles email delivery via plaintext_codes in the body).
 *   5. Store local record of setup completion in SQLite.
 */
import sodium from 'libsodium-wrappers';
import { randomBytes } from 'crypto';
import { createLogger } from '../logger.js';
import { shamirSplit, type ShamirShare } from './shamir.js';
import { getDb } from '../db/index.js';
import { ulid } from 'ulid';

const log = createLogger('recovery-setup');

export interface RecoverySetupInput {
  /** The user's 32-byte master key (must be held in RAM — never written to disk) */
  masterKey: Buffer;
  /** Exactly 5 trusted email addresses */
  trustedEmails: [string, string, string, string, string];
  /** JWT for cloud API calls */
  jwt: string;
  /** Cloud API base URL, e.g. 'https://api.engram-mcp.com' */
  cloudBaseUrl: string;
}

export interface RecoverySetupResult {
  ok: true;
  shardsStored: number;
  /** The KWK, for in-memory ephemeral use only. NEVER log or persist this. */
  kwk: Buffer;
}

/**
 * Encrypt masterKey with kwk using XChaCha20-Poly1305 (libsodium secretbox).
 * Returns a hex string: nonce (24 bytes) || ciphertext.
 */
async function encryptMasterKey(masterKey: Buffer, kwk: Buffer): Promise<string> {
  await sodium.ready;

  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(
    new Uint8Array(masterKey),
    nonce,
    new Uint8Array(kwk),
  );

  return Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]).toString('hex');
}

/**
 * Envelope-encrypt a share code for server-side storage.
 * For local dev: we hex-encode the base32 code. In production the cloud worker
 * would apply its own envelope encryption before persisting to D1.
 */
function envelopeEncryptShare(share: ShamirShare): string {
  // Simplified: hex-encode the base32 code for transport.
  // The cloud worker stores as-is; it treats this as the share_ciphertext column.
  return Buffer.from(share.code).toString('hex');
}

export async function setupRecoveryShards(
  input: RecoverySetupInput,
): Promise<RecoverySetupResult> {
  const { masterKey, trustedEmails, jwt, cloudBaseUrl } = input;

  if (masterKey.length !== 32) throw new Error('masterKey must be 32 bytes');
  if (trustedEmails.length !== 5) throw new Error('Need exactly 5 trusted emails');

  // 1. Generate KWK
  const kwk = Buffer.from(randomBytes(32));
  log.info('Generated KWK for recovery setup');

  // 2. Encrypt master key with KWK
  const mkCiphertext = await encryptMasterKey(masterKey, kwk);
  log.info('Encrypted master key with KWK');

  // 3. Split KWK into 5 shares (3-of-5)
  const shares = shamirSplit(kwk, 3, 5);
  log.info('Split KWK into 5 Shamir shares');

  // 4. Prepare payload for cloud
  const sharesPayload = shares.map((share) => ({
    index: share.index,
    encrypted_share: envelopeEncryptShare(share),
    plaintext_code: share.code, // sent for email delivery; not stored server-side
  }));

  // 5. POST /saves/recovery/initiate
  const res = await fetch(`${cloudBaseUrl}/saves/recovery/initiate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      trusted_emails: trustedEmails,
      mk_ciphertext: mkCiphertext,
      shares: sharesPayload,
      plaintext_codes: shares.map((s) => s.code),
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Recovery initiate failed: ${res.status} — ${errBody}`);
  }

  // 6. Store local record
  const db = getDb();
  // Clear any previous shards
  db.prepare(`DELETE FROM recovery_shards`).run();

  for (let i = 0; i < 5; i++) {
    db.prepare(
      `INSERT INTO recovery_shards (id, share_index, trusted_email, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(ulid(), i + 1, trustedEmails[i], Date.now());
  }

  log.info('Recovery shards setup complete — 5 emails will receive their share codes');

  // 7. Zero out KWK from buffer after use (best-effort in JS)
  const kwkCopy = Buffer.from(kwk); // return a copy for caller verification
  kwk.fill(0);

  return { ok: true, shardsStored: 5, kwk: kwkCopy };
}

/**
 * Decrypt the encrypted master key using the KWK reconstructed from Shamir shares.
 * Called during the recovery restore flow on the client side.
 *
 * @param mkCiphertextHex - hex string: nonce (24 bytes) || ciphertext
 * @param kwk             - 32-byte key-wrapping key (reconstructed from 3-of-5 shares)
 */
export async function decryptMasterKey(mkCiphertextHex: string, kwk: Buffer): Promise<Buffer> {
  await sodium.ready;

  const combined = Buffer.from(mkCiphertextHex, 'hex');
  const NONCE_LEN = sodium.crypto_secretbox_NONCEBYTES; // 24
  const nonce = combined.subarray(0, NONCE_LEN);
  const ciphertext = combined.subarray(NONCE_LEN);

  const plaintext = sodium.crypto_secretbox_open_easy(
    new Uint8Array(ciphertext),
    new Uint8Array(nonce),
    new Uint8Array(kwk),
  );

  if (!plaintext) {
    throw new Error('Failed to decrypt master key — wrong KWK or corrupted ciphertext');
  }

  return Buffer.from(plaintext);
}
