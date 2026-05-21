import { describe, it, expect } from 'vitest';
import {
  generateMasterKeySalt,
  deriveMasterKey,
  encryptBlob,
  decryptBlob,
  generateEphemeralKeypair,
  deriveSessionKey,
} from '../cloud/crypto.js';

describe('cloud/crypto', () => {
  it('generateMasterKeySalt returns 64-char hex string (32 bytes)', async () => {
    const salt = await generateMasterKeySalt();
    expect(typeof salt).toBe('string');
    expect(salt).toHaveLength(64);
    expect(/^[0-9a-f]+$/i.test(salt)).toBe(true);
  });

  it('deriveMasterKey produces 32-byte key deterministically', async () => {
    const salt = await generateMasterKeySalt();
    const key1 = await deriveMasterKey('correct horse battery staple', salt);
    const key2 = await deriveMasterKey('correct horse battery staple', salt);
    expect(key1.length).toBe(32);
    expect(Buffer.from(key1).toString('hex')).toBe(Buffer.from(key2).toString('hex'));
  });

  it('deriveMasterKey differs for different passphrases', async () => {
    const salt = await generateMasterKeySalt();
    const k1 = await deriveMasterKey('passA', salt);
    const k2 = await deriveMasterKey('passB', salt);
    expect(Buffer.from(k1).toString('hex')).not.toBe(Buffer.from(k2).toString('hex'));
  });

  it('encryptBlob + decryptBlob round-trips cleanly', async () => {
    const salt = await generateMasterKeySalt();
    const key = await deriveMasterKey('test passphrase', salt);
    const plaintext = new TextEncoder().encode('Hello, Engram transit!');
    const wire = await encryptBlob(plaintext, key);
    // wire length = 24 (nonce) + plaintext + 16 (Poly1305 MAC)
    expect(wire.length).toBe(24 + plaintext.length + 16);
    const recovered = await decryptBlob(wire, key);
    expect(new TextDecoder().decode(recovered)).toBe('Hello, Engram transit!');
  });

  it('decryptBlob throws on wrong key', async () => {
    const salt = await generateMasterKeySalt();
    const keyGood = await deriveMasterKey('right', salt);
    const keyBad = await deriveMasterKey('wrong', salt);
    const wire = await encryptBlob(new TextEncoder().encode('secret'), keyGood);
    await expect(decryptBlob(wire, keyBad)).rejects.toThrow(/[Dd]ecryption failed/);
  });

  it('decryptBlob throws on truncated input', async () => {
    const salt = await generateMasterKeySalt();
    const key = await deriveMasterKey('pass', salt);
    await expect(decryptBlob(new Uint8Array(10), key)).rejects.toThrow(/too short/);
  });

  it('generateEphemeralKeypair returns valid 32-byte keys', async () => {
    const { publicKey, privateKey } = await generateEphemeralKeypair();
    expect(publicKey.length).toBe(32);
    expect(privateKey.length).toBe(32);
  });

  it('deriveSessionKey is commutative (DH)', async () => {
    const alice = await generateEphemeralKeypair();
    const bob = await generateEphemeralKeypair();
    const s1 = await deriveSessionKey(alice.privateKey, bob.publicKey);
    const s2 = await deriveSessionKey(bob.privateKey, alice.publicKey);
    expect(Buffer.from(s1).toString('hex')).toBe(Buffer.from(s2).toString('hex'));
  });
});
