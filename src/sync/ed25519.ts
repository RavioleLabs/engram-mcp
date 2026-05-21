// src/sync/ed25519.ts
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import { createLogger } from '../logger.js';
import type { DeviceIdentity } from './types.js';

const log = createLogger('sync:ed25519');
const ulid = monotonicFactory();

/**
 * Generate a new ed25519 keypair.
 * Returns { pubkeyHex, privkeyHex } where both are raw key bytes as hex strings.
 * Raw = the 32-byte public key and 32-byte private key seed.
 */
export function generateKeypair(): { pubkeyHex: string; privkeyHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  // Export raw bytes
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' });
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' });

  // Last 32 bytes of PKCS8 DER = the private seed
  // Last 32 bytes of SPKI DER  = the public key
  const privHex = Buffer.from(privRaw).subarray(-32).toString('hex');
  const pubHex = Buffer.from(pubRaw).subarray(-32).toString('hex');

  log.debug('generated new ed25519 keypair', { pubHex: pubHex.slice(0, 8) + '…' });
  return { pubkeyHex: pubHex, privkeyHex: privHex };
}

/**
 * Sign `data` with the ed25519 private key (raw 32-byte hex seed).
 * Returns the 64-byte signature as a hex string.
 *
 * We reconstruct the PKCS8 DER key from the raw seed.
 * PKCS8 DER for ed25519 private key is:
 *   30 2e         SEQUENCE (46 bytes)
 *     02 01 00    INTEGER 0 (version)
 *     30 05       SEQUENCE (5 bytes)
 *       06 03 2b 65 70  OID 1.3.101.112 (Ed25519)
 *     04 22       OCTET STRING (34 bytes)
 *       04 20     OCTET STRING (32 bytes) — the raw seed
 *       <32 bytes seed>
 */
export function signBytes(data: Buffer, privkeyHex: string): string {
  const seed = Buffer.from(privkeyHex, 'hex');
  if (seed.length !== 32) throw new Error('privkeyHex must be 32 raw bytes (64 hex chars)');

  // Build PKCS8 DER for ed25519 from raw seed
  const pkcs8 = buildEd25519Pkcs8(seed);
  const privKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });

  const sig = sign(null, data, privKey);
  return Buffer.from(sig).toString('hex');
}

/**
 * Build a PKCS8 DER buffer for an ed25519 private key from a 32-byte seed.
 * This is a fixed-layout encoding — no ASN.1 parser needed.
 */
function buildEd25519Pkcs8(seed: Buffer): Buffer {
  // PKCS8 structure for Ed25519:
  // SEQUENCE {
  //   INTEGER 0
  //   SEQUENCE { OID 1.3.101.112 }
  //   OCTET STRING { OCTET STRING { seed } }
  // }
  const oid = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]); // OID Ed25519
  const innerOctet = Buffer.concat([Buffer.from([0x04, 0x20]), seed]); // OCTET STRING(seed)
  const outerOctet = Buffer.concat([
    Buffer.from([0x04, innerOctet.length]),
    innerOctet,
  ]);
  const algSeq = Buffer.concat([Buffer.from([0x30, oid.length]), oid]);
  const version = Buffer.from([0x02, 0x01, 0x00]); // INTEGER 0
  const body = Buffer.concat([version, algSeq, outerOctet]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/**
 * Verify an ed25519 signature.
 * @param data       - original bytes that were signed
 * @param sigHex     - 64-byte signature as hex string
 * @param pubkeyHex  - 32-byte public key as hex string
 */
export function verifySignature(data: Buffer, sigHex: string, pubkeyHex: string): boolean {
  try {
    const pubKey = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(pubkeyHex, 'hex').toString('base64url'),
      },
      format: 'jwk',
    });
    return verify(null, data, pubKey, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Build the canonical bytes that are signed for an op.
 * Format: `{op_id}|{device_id}|{lamport_ts}|{op_type}|{memory_id}|{payload_enc}|{nonce}`
 * All fields are UTF-8. payload_enc and nonce are base64 strings here.
 */
export function opCanonicalBytes(fields: {
  op_id: string;
  device_id: string;
  lamport_ts: number;
  op_type: string;
  memory_id: string;
  payload_enc: string;
  nonce: string;
}): Buffer {
  const str = [
    fields.op_id,
    fields.device_id,
    String(fields.lamport_ts),
    fields.op_type,
    fields.memory_id,
    fields.payload_enc,
    fields.nonce,
  ].join('|');
  return Buffer.from(str, 'utf8');
}

/**
 * Return the existing device identity or generate a new one and persist it.
 * The private key is stored in the local SQLite DB (protected by filesystem perms + WAL).
 * For higher assurance, this can be replaced with OS keychain calls via keytar.
 */
export function getOrCreateDeviceIdentity(db: Database.Database): DeviceIdentity {
  const existing = db
    .prepare(`SELECT * FROM device_identity LIMIT 1`)
    .get() as DeviceIdentity | undefined;

  if (existing) return existing;

  const { pubkeyHex, privkeyHex } = generateKeypair();
  const deviceId = pubkeyHex; // device_id IS the pubkey — no separate UUID needed
  const createdAt = Date.now();
  // Generate a stable ULID seed — not used here but keeps import alive
  void ulid;

  db.prepare(
    `INSERT INTO device_identity (device_id, pubkey_hex, privkey_hex, lamport_ts, created_at)
     VALUES (?, ?, ?, 0, ?)`,
  ).run(deviceId, pubkeyHex, privkeyHex, createdAt);

  log.info('created new device identity', { deviceId: deviceId.slice(0, 8) + '…' });
  return {
    device_id: deviceId,
    pubkey_hex: pubkeyHex,
    privkey_hex: privkeyHex,
    lamport_ts: 0,
    created_at: createdAt,
  };
}
