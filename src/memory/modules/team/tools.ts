// src/memory/modules/team/tools.ts
// Workspace MCP tools: list_workspaces, create_workspace, leave_workspace,
// invite_to_workspace, accept_workspace_invite.
// These are registered alongside the public tools.

import sodium from 'libsodium-wrappers';
import { createLogger } from '../../../logger.js';
import type { MCPToolDefinition } from '../../core/module-interface.js';
import type { EngramConfig } from '../../../config/schema.js';
import {
  generateWorkspaceKey,
  wrapKeyForRecipient,
  unwrapAndStoreWorkspaceKey,
  deleteWorkspaceKey,
  getOrCreateX25519Keypair,
  getX25519PubkeyHex,
} from './keystore.js';

const log = createLogger('team:tools');

export interface WorkspaceToolsContext {
  config: EngramConfig;
  masterKey: Uint8Array;
  /** Optional: pre-resolved jwt for cloud API calls. */
  getJwt: () => Promise<string | null>;
}

export function buildWorkspaceTools(ctx: WorkspaceToolsContext): MCPToolDefinition[] {
  const cloudUrl =
    ((ctx.config as unknown as Record<string, unknown>).cloudBaseUrl as string | undefined) ??
    'https://api.engram-mcp.com';
  const dataDir = ctx.config.dataDir;

  async function cloudFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const jwt = await ctx.getJwt();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (jwt) headers['Cookie'] = `engram_session=${jwt}`;
    return fetch(`${cloudUrl}${path}`, { ...init, headers });
  }

  return [
    // ── list_workspaces ───────────────────────────────────────────────────────
    {
      name: 'list_workspaces',
      description: [
        'Return all team workspaces the current user belongs to.',
        'WHEN: you need workspace IDs for use with scope parameter, or to show the user their teams.',
        'Returns personal workspace plus all team workspaces with name, role, and workspace_id.',
        'RETURNS: { workspaces: [{ id, name, role, is_personal }] }.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { getDb } = await import('../../../db/index.js');
        const db = getDb();
        const rows = db
          .prepare(
            'SELECT id, name, role, owner_email, joined_at FROM workspaces ORDER BY joined_at ASC',
          )
          .all() as Array<{
          id: string;
          name: string;
          role: string;
          owner_email: string | null;
          joined_at: string;
        }>;

        return {
          workspaces: [
            { id: 'personal', name: 'Personal', role: 'owner', is_personal: true },
            ...rows.map((r) => ({
              id: r.id,
              name: r.name,
              role: r.role,
              is_personal: false,
              owner_email: r.owner_email,
              joined_at: r.joined_at,
            })),
          ],
        };
      },
    },

    // ── create_workspace ──────────────────────────────────────────────────────
    {
      name: 'create_workspace',
      description: [
        'Create a new team workspace. Generates a team master key locally, wraps it for the owner, and registers with engram-cloud.',
        'WHEN: user wants to start a shared team memory space.',
        'After creation, use invite_to_workspace to add members.',
        'Requires an active cloud session (engram pair must have been run).',
        'RETURNS: { workspace_id, name } or { error }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Display name for the workspace (e.g. "Acme Research").',
          },
        },
        required: ['name'],
      },
      handler: async (args) => {
        const name = (args.name as string).trim();
        if (!name) return { error: 'name_required' };

        await sodium.ready;
        const keypair = await getOrCreateX25519Keypair(dataDir, ctx.masterKey);
        const ownerPubkeyHex = await getX25519PubkeyHex(dataDir);
        if (!ownerPubkeyHex) return { error: 'keypair_not_found', hint: 'Run engram pair first.' };

        // Generate fresh team master key + wrap it for the owner
        const teamKey = await generateWorkspaceKey();
        const wrappedForOwner = await wrapKeyForRecipient(teamKey, ownerPubkeyHex);

        // Create workspace on cloud
        const res = await cloudFetch('/api/workspaces', {
          method: 'POST',
          body: JSON.stringify({ name, wrapped_team_key: wrappedForOwner }),
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as Record<string, string>;
          log.error('create_workspace cloud error', err);
          return { error: err.error ?? `cloud_error_${res.status}`, message: err.message };
        }

        const data = (await res.json()) as { id: string; name: string };

        // Store team master key + register workspace locally
        const { getDb } = await import('../../../db/index.js');
        const db = getDb();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR REPLACE INTO workspaces (id, name, role, joined_at) VALUES (?, ?, 'owner', ?)`,
        ).run(data.id, data.name, now);

        // Persist decrypted team key
        await unwrapAndStoreWorkspaceKey(dataDir, data.id, wrappedForOwner, keypair);

        log.info(`Created workspace ${data.id} "${data.name}"`);
        return { workspace_id: data.id, name: data.name };
      },
    },

    // ── leave_workspace ───────────────────────────────────────────────────────
    {
      name: 'leave_workspace',
      description: [
        'Remove yourself from a team workspace. Deletes the local team key.',
        'WHEN: user wants to leave a team or the workspace is being decommissioned.',
        'Requires confirm: true to prevent accidental removal.',
        'RETURNS: { ok: true } or { error }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Workspace id to leave.' },
          confirm: {
            type: 'boolean',
            description: 'Must be true to confirm leaving. Prevents accidental removal.',
          },
        },
        required: ['workspace_id', 'confirm'],
      },
      handler: async (args) => {
        if (!args.confirm) {
          return {
            error: 'confirm_required',
            message: 'Pass confirm: true to leave the workspace.',
          };
        }

        const workspaceId = args.workspace_id as string;

        // Remove from local SQLite registry
        const { getDb } = await import('../../../db/index.js');
        const db = getDb();
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);

        // Delete local team key
        await deleteWorkspaceKey(dataDir, workspaceId);

        log.info(`Left workspace ${workspaceId}`);
        return { ok: true };
      },
    },

    // ── invite_to_workspace ───────────────────────────────────────────────────
    {
      name: 'invite_to_workspace',
      description: [
        'Invite a user to a team workspace by email. Fetches their X25519 pubkey from cloud, wraps the team key for them, and sends an invitation email.',
        'WHEN: workspace owner or admin wants to add a new member.',
        'The invitee must have a paired engram-mcp device (their pubkey must be registered).',
        'RETURNS: { ok: true, invitation_id } or { error }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Workspace id (from list_workspaces).' },
          email: { type: 'string', description: 'Email address of the invitee.' },
          role: {
            type: 'string',
            enum: ['member', 'admin'],
            description: 'Role to assign. Default: "member".',
            default: 'member',
          },
        },
        required: ['workspace_id', 'email'],
      },
      handler: async (args) => {
        const workspaceId = args.workspace_id as string;
        const email = (args.email as string).trim().toLowerCase();
        const role = (args.role as string | undefined) ?? 'member';

        await sodium.ready;
        const keypair = await getOrCreateX25519Keypair(dataDir, ctx.masterKey);

        // Load local team key
        const { loadWorkspaceKey } = await import('./keystore.js');
        const teamKey = await loadWorkspaceKey(dataDir, workspaceId);
        if (!teamKey) {
          return {
            error: 'team_key_not_found',
            message: 'You do not have a local key for this workspace. Are you the owner?',
          };
        }

        // Fetch invitee's pubkey from cloud
        const pubkeyRes = await cloudFetch(`/api/users/pubkey?email=${encodeURIComponent(email)}`);
        if (!pubkeyRes.ok) {
          const err = (await pubkeyRes.json().catch(() => ({}))) as Record<string, string>;
          return { error: err.error ?? 'pubkey_fetch_failed', message: err.message };
        }
        const { x25519_pubkey: inviteePubkeyHex } = (await pubkeyRes.json()) as {
          x25519_pubkey: string;
        };

        // Wrap team key for invitee
        const wrappedForInvitee = await wrapKeyForRecipient(teamKey, inviteePubkeyHex);

        // Send invitation
        const invRes = await cloudFetch(`/api/workspaces/${workspaceId}/invite`, {
          method: 'POST',
          body: JSON.stringify({ email, role, wrapped_team_key: wrappedForInvitee }),
        });

        if (!invRes.ok) {
          const err = (await invRes.json().catch(() => ({}))) as Record<string, string>;
          return { error: err.error ?? 'invite_failed', message: err.message };
        }

        const data = (await invRes.json()) as { invitation_id: string };
        log.info(`Invited ${email} to workspace ${workspaceId}`);
        return { ok: true, invitation_id: data.invitation_id };

        void keypair; // keypair loaded to ensure keys are ready — not used directly for wrapping
      },
    },

    // ── accept_workspace_invite ───────────────────────────────────────────────
    {
      name: 'accept_workspace_invite',
      description: [
        'Accept a team workspace invitation using the token from the invitation email.',
        'Decrypts the wrapped team key using your local X25519 private key and stores it.',
        'WHEN: you received an invitation link and want to join a team workspace.',
        'RETURNS: { ok: true, workspace_id } or { error }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'Invitation token from the email link.' },
        },
        required: ['token'],
      },
      handler: async (args) => {
        const token = args.token as string;
        await sodium.ready;
        const keypair = await getOrCreateX25519Keypair(dataDir, ctx.masterKey);

        const res = await cloudFetch('/api/workspaces/invitations/accept', {
          method: 'POST',
          body: JSON.stringify({ token }),
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as Record<string, string>;
          return { error: err.error ?? 'accept_failed', message: err.message };
        }

        const data = (await res.json()) as {
          workspace_id: string;
          wrapped_team_key?: string;
        };

        if (data.wrapped_team_key) {
          await unwrapAndStoreWorkspaceKey(
            dataDir,
            data.workspace_id,
            data.wrapped_team_key,
            keypair,
          );
        }

        // Register workspace locally
        const workspaceInfoRes = await cloudFetch('/api/workspaces');
        if (workspaceInfoRes.ok) {
          const { workspaces } = (await workspaceInfoRes.json()) as {
            workspaces: Array<{ id: string; name: string; role: string; joined_at: string }>;
          };
          const ws = workspaces.find((w) => w.id === data.workspace_id);
          if (ws) {
            const { getDb } = await import('../../../db/index.js');
            const db = getDb();
            db.prepare(
              `INSERT OR REPLACE INTO workspaces (id, name, role, joined_at) VALUES (?, ?, ?, ?)`,
            ).run(ws.id, ws.name, ws.role, ws.joined_at);
          }
        }

        log.info(`Accepted invite for workspace ${data.workspace_id}`);
        return { ok: true, workspace_id: data.workspace_id };
      },
    },
  ];
}
