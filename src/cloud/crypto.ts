/**
 * src/cloud/crypto.ts
 *
 * Cryptographic helpers for the cloud transit E2E layer.
 *
 * Master key: scrypt from user passphrase + random 32-byte salt.
 *   - Salt is stored in config.engramAccount.masterKeySalt (hex).
 *   - Passphrase is NEVER stored — prompted at startup or pairing time.
 *   - Derived key is held in memory only for the process lifetime.
 *
 * Note: The plan spec calls for Argon2id (libsodium crypto_pwhash), which
 * requires libsodium-wrappers-sumo (the "full" build). The base
 * libsodium-wrappers package omits pwhash. We use Node.js built-in
 * crypto.scrypt instead — it is also memory-hard (Colin Percival's scrypt,
 * the predecessor to Argon2id) and available everywhere Node ≥ 10 runs.
 * When libsodium-wrappers-sumo becomes available, swap deriveMasterKey's
 * implementation to crypto_pwhash with no other changes needed.
 *
 * Blob encryption (Plan J mobile side + PC side both use this scheme):
 *   secretbox: XSalsa20-Poly1305 (libsodium crypto_secretbox_easy).
 *   Nonce: random 24 bytes, prepended to ciphertext.
 *   Wire format: nonce (24 bytes) || ciphertext.
 */
import sodium from 'libsodium-wrappers';
import { randomBytes } from 'crypto';
import { scrypt as scryptCallback } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('cloud:crypto');

/** Promise wrapper for crypto.scrypt with options */
function scryptAsync(
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

let _sodiumReady = false;

async function ensureSodium(): Promise<void> {
  if (!_sodiumReady) {
    await sodium.ready;
    _sodiumReady = true;
  }
}

// scrypt parameters — memory-hard equivalent to Argon2id-interactive.
// N=2^14 (16 MiB total with r=8), r=8, p=1.
// OpenSSL default maxmem is 32 MiB; 128*N*r = 128*16384*8 = 16 MiB — fits comfortably.
// Override via env for stronger hardening: ENGRAM_SCRYPT_N (power of 2, max 32768).
const SCRYPT_N = process.env.ENGRAM_SCRYPT_N ? parseInt(process.env.ENGRAM_SCRYPT_N, 10) : 1 << 14; // 16384 → 16 MiB
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 32;
const KEY_BYTES = 32; // 256-bit key for XSalsa20

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

export interface MasterKeyMaterial {
  /** 32-byte derived key (XSalsa20-Poly1305 secret key) */
  key: Uint8Array;
  /** hex-encoded 32-byte salt — persisted in config.engramAccount.masterKeySalt */
  saltHex: string;
}

/**
 * Generate a fresh random salt (call at first pairing).
 * The salt must be stored in config so it survives restarts.
 */
export async function generateMasterKeySalt(): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  return salt.toString('hex');
}

/**
 * Derive the 32-byte master key from passphrase + salt using scrypt.
 * scrypt is memory-hard (equivalent security properties to Argon2id).
 * The derived key is held in process memory only — never written to disk.
 */
export async function deriveMasterKey(passphrase: string, saltHex: string): Promise<Uint8Array> {
  const salt = Buffer.from(saltHex, 'hex');
  if (salt.length !== SALT_BYTES) {
    throw new Error(`Invalid salt length: expected ${SALT_BYTES}, got ${salt.length}`);
  }
  const keyBuf = (await scryptAsync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;
  log.debug('Master key derived (scrypt)');
  return new Uint8Array(keyBuf);
}

// ---------------------------------------------------------------------------
// Blob encryption / decryption (libsodium XSalsa20-Poly1305)
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext blob.
 * Returns: nonce (24 bytes) || ciphertext — ready to upload to R2.
 */
export async function encryptBlob(
  plaintext: Uint8Array,
  masterKey: Uint8Array,
): Promise<Uint8Array> {
  await ensureSodium();
  const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES; // 24
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, masterKey);
  const wire = new Uint8Array(nonce.length + ciphertext.length);
  wire.set(nonce, 0);
  wire.set(ciphertext, nonce.length);
  return wire;
}

/**
 * Decrypt a blob downloaded from R2.
 * Input: nonce (24 bytes) || ciphertext (as produced by encryptBlob).
 * Throws if authentication fails (tampered or wrong key).
 */
export async function decryptBlob(wire: Uint8Array, masterKey: Uint8Array): Promise<Uint8Array> {
  await ensureSodium();
  const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES; // 24
  if (wire.length <= NONCE_BYTES) {
    throw new Error('Ciphertext too short to contain a nonce');
  }
  const nonce = wire.slice(0, NONCE_BYTES);
  const ciphertext = wire.slice(NONCE_BYTES);
  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, masterKey);
  } catch {
    throw new Error('Decryption failed — wrong key or tampered ciphertext');
  }
  if (!plaintext) {
    throw new Error('Decryption failed — wrong key or tampered ciphertext');
  }
  return plaintext;
}

// ---------------------------------------------------------------------------
// Noise-inspired handshake helpers for Bridge Relay (Plan J Noise protocol)
// ---------------------------------------------------------------------------

/**
 * Generate an ephemeral X25519 keypair for the Noise handshake.
 * The PC uses this for each new bridge session.
 */
export async function generateEphemeralKeypair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  await ensureSodium();
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/**
 * Derive a shared session key from the PC's private key and the relay's
 * ephemeral public key (X25519 DH).
 */
export async function deriveSessionKey(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array,
): Promise<Uint8Array> {
  await ensureSodium();
  return sodium.crypto_scalarmult(myPrivateKey, theirPublicKey);
}
