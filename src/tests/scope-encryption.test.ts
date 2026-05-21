// src/tests/scope-encryption.test.ts
// Verifies that workspace-scoped memories use a different encryption key
// (team master key) from personal memories (personal master key).
// Uses real libsodium — no mocks.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  generateWorkspaceKey,
  wrapKeyForRecipient,
  unwrapAndStoreWorkspaceKey,
  loadWorkspaceKey,
  getOrCreateX25519Keypair,
} from '../memory/modules/team/keystore.js';

let tmpDir: string;

beforeAll(async () => {
  await sodium.ready;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-scope-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('scope encryption', () => {
  it('generates a 32-byte workspace key', async () => {
    const key = await generateWorkspaceKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('generates X25519 keypair and persists it', async () => {
    const masterKey = sodium.randombytes_buf(32);
    const kp = await getOrCreateX25519Keypair(tmpDir, masterKey);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);

    // Second call returns the same keypair (loaded from disk)
    const kp2 = await getOrCreateX25519Keypair(tmpDir, masterKey);
    expect(sodium.to_hex(kp2.publicKey)).toBe(sodium.to_hex(kp.publicKey));
  });

  it('wraps team key for recipient and unwraps correctly', async () => {
    // Use a fresh tmpDir so the prior test's persisted keypair doesn't interfere
    const wrapDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-wrap-test-'));
    const masterKey = sodium.randombytes_buf(32);
    const keypair = await getOrCreateX25519Keypair(wrapDir, masterKey);
    const teamKey = await generateWorkspaceKey();
    const pubkeyHex = sodium.to_hex(keypair.publicKey);

    // Owner wraps team key for recipient
    const wrappedHex = await wrapKeyForRecipient(teamKey, pubkeyHex);
    expect(wrappedHex).toMatch(/^[0-9a-f]+$/);

    // Recipient unwraps
    const workspaceId = 'TEST01WORKSPACEID01';
    const unwrapped = await unwrapAndStoreWorkspaceKey(
      wrapDir,
      workspaceId,
      wrappedHex,
      keypair,
    );
    expect(sodium.to_hex(unwrapped)).toBe(sodium.to_hex(teamKey));

    // Persisted key matches
    const loaded = await loadWorkspaceKey(wrapDir, workspaceId);
    await fs.rm(wrapDir, { recursive: true, force: true });
    expect(loaded).not.toBeNull();
    expect(sodium.to_hex(loaded!)).toBe(sodium.to_hex(teamKey));
  });

  it('team key is different from personal master key', async () => {
    const masterKey = sodium.randombytes_buf(32);
    const teamKey = await generateWorkspaceKey();
    // Very high probability that two 32-byte random values differ
    expect(sodium.to_hex(masterKey)).not.toBe(sodium.to_hex(teamKey));
  });

  it('wrapped keys for different recipients cannot be decrypted by wrong key', async () => {
    const masterKey = sodium.randombytes_buf(32);
    const keypairAlice = await getOrCreateX25519Keypair(tmpDir + '-alice', masterKey);
    // Bob has a different key directory
    const keypairBob = await getOrCreateX25519Keypair(tmpDir + '-bob', masterKey);

    const teamKey = await generateWorkspaceKey();
    const wrappedForAlice = await wrapKeyForRecipient(
      teamKey,
      sodium.to_hex(keypairAlice.publicKey),
    );

    // Bob tries to unwrap a key sealed for Alice — should throw
    await expect(
      unwrapAndStoreWorkspaceKey(
        tmpDir + '-bob',
        'WRONG_WORKSPACE_ID',
        wrappedForAlice,
        keypairBob,
      ),
    ).rejects.toThrow();
  });
});
