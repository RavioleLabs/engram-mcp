// src/memory/modules/team/keystore.ts
// X25519 keypair generation + storage, and team master key management.
// Private key is encrypted with the user's personal master key (XSalsa20-Poly1305).
// Team master keys are stored at ~/.engram/keys/workspaces/<workspace_id>.key

import sodium from 'libsodium-wrappers';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../../../logger.js';

const log = createLogger('team:keystore');

export interface X25519Keypair {
  publicKey: Uint8Array;  // 32 bytes
  privateKey: Uint8Array; // 32 bytes
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function keysDir(dataDir: string): Promise<string> {
  const dir = path.join(dataDir, 'keys');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

// ── X25519 keypair ────────────────────────────────────────────────────────────

/**
 * Generate or load the user's X25519 keypair.
 * Private key is stored encrypted with `masterKey` (XSalsa20-Poly1305).
 * Layout: nonce(24 bytes) || ciphertext
 */
export async function getOrCreateX25519Keypair(
  dataDir: string,
  masterKey: Uint8Array,
): Promise<X25519Keypair> {
  await sodium.ready;

  const dir = await keysDir(dataDir);
  const pubPath = path.join(dir, 'x25519.pub');
  const encPath = path.join(dir, 'x25519.enc');

  if ((await fileExists(pubPath)) && (await fileExists(encPath))) {
    const pubBuf = await fs.readFile(pubPath);
    const encBuf = await fs.readFile(encPath);

    const nonce = encBuf.subarray(0, sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = encBuf.subarray(sodium.crypto_secretbox_NONCEBYTES);
    const privKey = sodium.crypto_secretbox_open_easy(ciphertext, nonce, masterKey);

    return { publicKey: new Uint8Array(pubBuf), privateKey: privKey };
  }

  // Generate fresh keypair
  const kp = sodium.crypto_kx_keypair();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const encPriv = sodium.crypto_secretbox_easy(kp.privateKey, nonce, masterKey);

  await fs.writeFile(pubPath, Buffer.from(kp.publicKey), { mode: 0o600 });

  const encBuf = Buffer.alloc(nonce.length + encPriv.length);
  Buffer.from(nonce).copy(encBuf, 0);
  Buffer.from(encPriv).copy(encBuf, nonce.length);
  await fs.writeFile(encPath, encBuf, { mode: 0o600 });

  log.info('Generated new X25519 keypair');
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/**
 * Return the hex-encoded X25519 public key if it exists, or null.
 */
export async function getX25519PubkeyHex(dataDir: string): Promise<string | null> {
  await sodium.ready;
  const pubPath = path.join(await keysDir(dataDir), 'x25519.pub');
  if (!(await fileExists(pubPath))) return null;
  const buf = await fs.readFile(pubPath);
  return sodium.to_hex(new Uint8Array(buf));
}

// ── Team (workspace) master keys ─────────────────────────────────────────────

/**
 * Load a workspace's team master key from disk.
 * Returns null if the workspace key has not been stored yet.
 */
export async function loadWorkspaceKey(
  dataDir: string,
  workspaceId: string,
): Promise<Uint8Array | null> {
  const p = path.join(await keysDir(dataDir), 'workspaces', `${workspaceId}.key`);
  try {
    const buf = await fs.readFile(p);
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * Unwrap a team_master_key from a crypto_box_seal ciphertext using our X25519
 * keypair, then persist it at ~/.engram/keys/workspaces/<id>.key
 */
export async function unwrapAndStoreWorkspaceKey(
  dataDir: string,
  workspaceId: string,
  wrappedHex: string,
  keypair: X25519Keypair,
): Promise<Uint8Array> {
  await sodium.ready;
  const wrapped = sodium.from_hex(wrappedHex);
  const teamKey = sodium.crypto_box_seal_open(
    wrapped,
    keypair.publicKey,
    keypair.privateKey,
  );

  const dir = path.join(await keysDir(dataDir), 'workspaces');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, `${workspaceId}.key`), Buffer.from(teamKey), {
    mode: 0o600,
  });

  log.info(`Stored workspace key for ${workspaceId}`);
  return teamKey;
}

/**
 * Generate a fresh 32-byte team master key.
 */
export async function generateWorkspaceKey(): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.randombytes_buf(32);
}

/**
 * Wrap a team_master_key for a recipient's X25519 public key.
 * Returns hex-encoded crypto_box_seal ciphertext (48 bytes → 96 hex chars).
 */
export async function wrapKeyForRecipient(
  teamKey: Uint8Array,
  recipientPubkeyHex: string,
): Promise<string> {
  await sodium.ready;
  const recipientPub = sodium.from_hex(recipientPubkeyHex);
  const sealed = sodium.crypto_box_seal(teamKey, recipientPub);
  return sodium.to_hex(sealed);
}

/**
 * Delete a workspace key from local disk (after leaving the workspace).
 */
export async function deleteWorkspaceKey(
  dataDir: string,
  workspaceId: string,
): Promise<void> {
  const p = path.join(await keysDir(dataDir), 'workspaces', `${workspaceId}.key`);
  await fs.unlink(p).catch(() => {});
  log.info(`Deleted workspace key for ${workspaceId}`);
}
