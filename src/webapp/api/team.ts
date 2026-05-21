// src/webapp/api/team.ts
// Local HTTP endpoints for workspace (team) key operations.
// Called by the engram-mcp.com browser UI to perform key wrapping
// (the browser cannot hold the master key — it lives in this local process).

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import {
  loadWorkspaceKey,
  wrapKeyForRecipient,
  getOrCreateX25519Keypair,
} from '../../memory/modules/team/keystore.js';

const log = createLogger('api:team');

export interface TeamRouterOptions {
  dataDir: string;
  masterKey: Uint8Array;
}

export function buildTeamRouter(opts: TeamRouterOptions): Router {
  const router = Router();

  // POST /api/team/wrap-key
  // Body: { workspace_id: string; recipient_pubkey: string }  (hex)
  // Returns: { wrapped_team_key: string }  (hex)
  // Used by engram-mcp.com to wrap the workspace master key before sending an invitation.
  router.post('/wrap-key', async (req, res) => {
    try {
      const { workspace_id, recipient_pubkey } = req.body as {
        workspace_id?: string;
        recipient_pubkey?: string;
      };

      if (!workspace_id || !recipient_pubkey) {
        return res.status(400).json({ error: 'workspace_id and recipient_pubkey required' });
      }
      if (!/^[0-9a-f]{64}$/i.test(recipient_pubkey)) {
        return res.status(400).json({ error: 'recipient_pubkey must be 64 hex chars (32 bytes)' });
      }

      const teamKey = await loadWorkspaceKey(opts.dataDir, workspace_id);
      if (!teamKey) {
        return res.status(404).json({
          error: 'workspace_key_not_found',
          message: 'Local workspace key not found. Are you the owner?',
        });
      }

      const wrappedHex = await wrapKeyForRecipient(teamKey, recipient_pubkey);
      log.info(`Wrapped workspace key for workspace ${workspace_id}`);
      return res.json({ wrapped_team_key: wrappedHex });
    } catch (e: unknown) {
      log.error('wrap-key error', e);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // GET /api/team/pubkey
  // Returns the local X25519 public key (hex).
  // Used for registration with engram-cloud after pairing.
  router.get('/pubkey', async (_req, res) => {
    try {
      const keypair = await getOrCreateX25519Keypair(opts.dataDir, opts.masterKey);
      const { default: sodium } = await import('libsodium-wrappers');
      await sodium.ready;
      return res.json({ x25519_pubkey: sodium.to_hex(keypair.publicKey) });
    } catch (e: unknown) {
      log.error('pubkey error', e);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}
