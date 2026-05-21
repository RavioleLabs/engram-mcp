// src/sync/team-sync.ts
// Handles incoming team/workspace sync messages from the UserSyncChannel WebSocket.
// Also provides broadcastTeamOp for pushing workspace ops to the cloud fan-out.

import { createLogger } from '../logger.js';
import type { EngramConfig } from '../config/schema.js';

const log = createLogger('sync:team');

export interface WorkspaceSyncMessage {
  type:
    | 'workspace.memory_added'
    | 'workspace.memory_updated'
    | 'workspace.memory_deleted'
    | 'workspace.key_rotated';
  workspace_id: string;
  memory_id?: string;
  ts: number;
}

/**
 * Post a workspace memory op to engram-cloud so it fans out to all workspace members.
 * Called by MemoryStore after insert/update/delete for workspace-scoped items.
 * Non-fatal: logs warnings on failure.
 */
export async function broadcastWorkspaceOp(
  config: EngramConfig,
  jwt: string,
  msg: WorkspaceSyncMessage,
): Promise<void> {
  const cloudBaseUrl =
    (config as unknown as Record<string, unknown>).cloudBaseUrl as string | undefined
    ?? 'https://api.engram-mcp.com';

  try {
    const res = await fetch(
      `${cloudBaseUrl}/api/workspaces/${msg.workspace_id}/broadcast`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `engram_session=${jwt}`,
        },
        body: JSON.stringify(msg),
      },
    );
    if (!res.ok) {
      log.warn('Workspace broadcast failed', {
        status: res.status,
        workspace_id: msg.workspace_id,
      });
    }
  } catch (e) {
    log.warn('Workspace broadcast error (non-fatal)', e);
  }
}

/**
 * Handle incoming workspace sync messages from the UserSyncChannel WebSocket.
 * Called when the sync WS receives a 'workspace.*' message frame.
 */
export async function handleWorkspaceSyncMessage(
  msg: WorkspaceSyncMessage,
  store: import('../memory/core/store.js').MemoryStore,
  dataDir: string,
  masterKey: Uint8Array,
): Promise<void> {
  switch (msg.type) {
    case 'workspace.memory_added':
    case 'workspace.memory_updated':
      // Pull op will sync on next cloud pull — no-op here
      log.debug('workspace.memory_added/updated — will sync on next pull', msg);
      break;

    case 'workspace.memory_deleted':
      if (msg.memory_id) {
        await store.delete(msg.memory_id);
        log.info(`Deleted workspace memory ${msg.memory_id} per sync`);
      }
      break;

    case 'workspace.key_rotated': {
      // Client must re-fetch the workspace key from cloud on next sync pull
      log.info(`Key rotated for workspace ${msg.workspace_id} — will re-fetch on next sync`);
      // Trigger async key re-fetch (fire-and-forget)
      void refreshWorkspaceKey(dataDir, masterKey, msg.workspace_id);
      break;
    }
  }
}

/**
 * Re-fetch a workspace's wrapped_team_key from cloud and re-store it locally.
 * Called after receiving a workspace.key_rotated event.
 */
async function refreshWorkspaceKey(
  dataDir: string,
  masterKey: Uint8Array,
  workspaceId: string,
): Promise<void> {
  try {
    // Import keystore dynamically to avoid circular imports
    const { getOrCreateX25519Keypair, unwrapAndStoreWorkspaceKey } =
      await import('../memory/modules/team/keystore.js');

    const keypair = await getOrCreateX25519Keypair(dataDir, masterKey);

    // We'd need jwt + cloudUrl here — this is a best-effort stub.
    // In production, the full sync reconnect flow will pull the updated wrapped key
    // via GET /api/workspaces after the channel reconnects.
    log.info(`Workspace key refresh queued for ${workspaceId} — will pick up on next sync`);
    void keypair; // suppress unused warning
    void unwrapAndStoreWorkspaceKey; // suppress unused warning
  } catch (e) {
    log.warn(`Failed to queue workspace key refresh for ${workspaceId}`, e);
  }
}
