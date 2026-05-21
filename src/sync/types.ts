// src/sync/types.ts
import { z } from 'zod';

export const OpTypeSchema = z.enum([
  'add_memory',
  'update_properties',
  'delete_memory',
  'add_relation',
]);
export type OpType = z.infer<typeof OpTypeSchema>;

/** Raw op as stored in ops_log (pre-decryption on the wire). */
export const WireOpSchema = z.object({
  op_id: z.string(), // ULID
  device_id: z.string(), // ed25519 pubkey hex
  lamport_ts: z.number().int(),
  op_type: OpTypeSchema,
  memory_id: z.string(),
  payload_enc: z.string(), // base64 of secretbox ciphertext
  nonce: z.string(), // base64 of 24-byte nonce (or 12-byte for AES-GCM)
  sig: z.string(), // hex of ed25519 sig
  created_at: z.number().int(),
});
export type WireOp = z.infer<typeof WireOpSchema>;

/** Decrypted payload shapes per op_type. */
export const AddMemoryPayloadSchema = z.object({
  item: z.record(z.unknown()), // serialised MemoryItem (JSON)
});

export const UpdatePropertiesPayloadSchema = z.object({
  memory_id: z.string(),
  delta: z.record(z.unknown()), // partial properties patch
});

export const DeleteMemoryPayloadSchema = z.object({
  memory_id: z.string(),
});

export const AddRelationPayloadSchema = z.object({
  from_id: z.string(),
  to_id: z.string(),
  relation_type: z.string().default('related'),
});

export type AddMemoryPayload = z.infer<typeof AddMemoryPayloadSchema>;
export type UpdatePropertiesPayload = z.infer<typeof UpdatePropertiesPayloadSchema>;
export type DeleteMemoryPayload = z.infer<typeof DeleteMemoryPayloadSchema>;
export type AddRelationPayload = z.infer<typeof AddRelationPayloadSchema>;

/** Device identity row. */
export interface DeviceIdentity {
  device_id: string; // pubkey hex (also serves as stable device ID)
  pubkey_hex: string;
  privkey_hex: string; // stored in local SQLite DB
  lamport_ts: number;
  created_at: number;
}
