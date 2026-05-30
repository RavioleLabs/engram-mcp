import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../logger.js';
import { initDb, getDb } from '../db/index.js';
import { initVectorStore } from '../../vector/store.js';
import { MemoryStore } from '../../memory/core/store.js';
import { moduleRegistry } from '../../memory/core/module-registry.js';
import { createNotesModule } from '../../memory/modules/notes/module.js';
import { createConversationsModule } from '../../memory/modules/conversations/module.js';
import { createDriveModule } from '../../memory/modules/drive/module.js';
import { createNotionModule } from '../../memory/modules/notion/module.js';
import { createAudioModule } from '../../memory/modules/audio/module.js';
import { createYoutubeModule } from '../../memory/modules/youtube/module.js';
import { buildPublicTools } from '../../memory/public/tools.js';
import { createObsidianModule } from '../../memory/modules/obsidian/module.js';
import { loadAndRegisterCustomTypes } from '../../memory/modules/_custom/tools.js';
import { buildWorkspaceTools } from '../../memory/modules/team/tools.js';
import { ToolRouter } from './tool-router.js';
import { ENGRAM_INSTRUCTIONS } from './instructions.js';
import type { EngramConfig } from '../../config/schema.js';
import { startTransitPoller } from '../../cloud/transit-poller.js';
import { deriveMasterKey } from '../../cloud/crypto.js';
import { getOrCreateDeviceIdentity } from '../../sync/ed25519.js';
import { OpsLogger } from '../../sync/ops-log.js';
import { ReplayApplier } from '../../sync/apply.js';
import { ChannelClient } from '../../sync/channel-client.js';
import { replayFromCloud } from '../../sync/replay.js';

const log = createLogger('mcp-server');

// ─── Algorithm + Prompt override registry (populated by src/private/index.ts) ─

export interface EngramAlgorithms {
  /** Smart findRelated: wikilinks + semantic search with dedup. */
  findRelated?: (
    store: MemoryStore,
    id: string,
    limit: number,
  ) => Promise<import('../../types.js').SearchResult[]>;
  /** Smart searchAll: per-type weighting, recency boost, MMR diversification. */
  searchAll?: (
    store: MemoryStore,
    query: string,
    limit: number,
    types?: string[],
  ) => Promise<Array<{ id: string; type: string; score: number; snippet: string; title?: string }>>;
  /** Semantic-boundary chunking via local Ollama topic-shift detection. */
  chunkText?: (
    text: string,
    opts?: import('../../memory/core/chunker.js').ChunkOptions,
  ) => string[] | Promise<string[]>;
  /** Pairwise cosine semantic edges for memory graph (capped at 50 nodes). */
  graphSemanticEdges?: (
    store: MemoryStore,
    nodeIds: string[],
  ) => Promise<Array<import('../../webapp/api/graph.js').GraphEdge>>;
}

export interface EngramPrompts {
  /** Full 5-field extraction system prompt (title, tags, sentiment, action_required, summary). */
  extractionSystemPrompt?: string;
  /** Verbose 4-field suggest-properties instruction template. */
  suggestPropertiesInstruction?: (
    memoryId: string,
    content: string,
    currentProps: object,
  ) => string;
}

export interface EngramRuntime {
  store: MemoryStore;
  router: ToolRouter;
  algorithms: EngramAlgorithms;
  prompts: EngramPrompts;
  shutdown: () => Promise<void>;
}

export interface BuildEngramRuntimeOptions {
  /** @deprecated All tools are now always public. This flag is ignored. */
  adminMode?: boolean;
}

export async function buildEngramRuntime(
  config: EngramConfig,
  _opts: BuildEngramRuntimeOptions = {},
): Promise<EngramRuntime> {
  initDb(config.dataDir);
  initVectorStore(config.dataDir, config.embeddings.dimensions);

  // Soft dim-mismatch check: if any vector table already exists at a
  // different dimension than the configured embeddings.dimensions, log a
  // loud warning. Common cause: user changed provider via setup-embeddings
  // but never ran `engram-mcp rebuild` (or `npm run reindex`). Without
  // rebuild the new embeddings won't fit the old tables and writes will
  // throw at indexChunksBatch.
  try {
    const { detectVectorDimMismatch } = await import('../../vector/store.js');
    const mismatch = await detectVectorDimMismatch(config.embeddings.dimensions);
    if (mismatch) {
      const log = (await import('../logger.js')).createLogger('boot');
      log.warn(
        `Vector dim mismatch: tables at ${mismatch.tableDim}-d, config says ${mismatch.configDim}-d. ` +
          `Run \`engram-mcp-setup-embeddings\` then \`engram-mcp rebuild\` to migrate, or revert the config.`,
      );
    }
  } catch {
    // Non-critical — soft check only.
  }

  // Register builtin parsers (BNP releve, etc.) before any module boots so
  // remember() calls during module init also benefit from parsing. Idempotent.
  const { registerBuiltinParsers } = await import('../../memory/modules/parsers/index.js');
  registerBuiltinParsers();

  // Startup GC: sweep ingest jobs older than 7 days
  try {
    const { gcJobsOnStartup } = await import('../../ingest/jobs.js');
    gcJobsOnStartup();
  } catch {
    // Non-critical
  }

  const algorithms: EngramAlgorithms = {};
  const prompts: EngramPrompts = {};

  const store = new MemoryStore({
    embeddings: config.embeddings,
    propertyExtraction: config.propertyExtraction,
    rerank: config.rerank,
    queryExpansion: config.queryExpansion,
    algorithms,
    prompts,
  });

  // Register modules
  moduleRegistry.register(createNotesModule(config));
  moduleRegistry.register(createConversationsModule(config));
  moduleRegistry.register(createDriveModule(config));
  moduleRegistry.register(createNotionModule(config));
  moduleRegistry.register(createAudioModule(config));
  moduleRegistry.register(createYoutubeModule(config));
  moduleRegistry.register(createObsidianModule(config));
  await moduleRegistry.bootAll({ store });

  // Build tool router — all tools always registered (no admin flag needed)
  const router = new ToolRouter();
  router.registerMany(buildPublicTools(store, config));
  loadAndRegisterCustomTypes(store, config, router);

  // Workspace (team) tools — registered only when cloud sync is configured
  // (requires masterKey; falls back gracefully if no passphrase set)
  let workspaceMasterKey: Uint8Array | null = null;
  if (config.engramAccount) {
    const passphrase = process.env.ENGRAM_PASSPHRASE ?? '';
    if (passphrase) {
      try {
        const mk = await deriveMasterKey(passphrase, config.engramAccount.masterKeySalt);
        workspaceMasterKey = Buffer.from(mk);
      } catch {
        // Non-critical
      }
    }
  }
  if (workspaceMasterKey) {
    const wsMasterKey = workspaceMasterKey;
    const wsJwt = config.engramAccount?.jwt ?? null;
    const workspaceTools = buildWorkspaceTools({
      config,
      masterKey: wsMasterKey,
      getJwt: async () => wsJwt,
    });
    router.registerMany(workspaceTools);
    log.info(`Workspace tools registered (${workspaceTools.length} tools)`);
  }

  // --- Cloud transit poller (opt-in, only if user has paired) ---
  let pollerStop: (() => void) | null = null;
  if (config.engramAccount) {
    const passphrase = process.env.ENGRAM_PASSPHRASE ?? '';
    if (!passphrase) {
      log.warn(
        'engramAccount configured but ENGRAM_PASSPHRASE env var not set — ' +
          'cloud transit poller will not start. Set ENGRAM_PASSPHRASE to activate.',
      );
    } else {
      try {
        const masterKey = await deriveMasterKey(passphrase, config.engramAccount.masterKeySalt);
        const poller = startTransitPoller({ store, config, masterKey });
        pollerStop = poller.stop;
        log.info('Cloud transit poller activated');
      } catch (e) {
        log.error(`Failed to start transit poller: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // --- Plan N: Ops-log bidirectional sync (opt-in via config.sync.enabled) ---
  let channelClientStop: (() => void) | null = null;
  if (config.sync?.enabled) {
    const db = getDb();
    const identity = getOrCreateDeviceIdentity(db);

    const passphrase = process.env.ENGRAM_PASSPHRASE ?? '';
    if (!passphrase) {
      log.warn(
        'sync.enabled is true but ENGRAM_PASSPHRASE env var not set — ' +
          'ops logger requires a master key. Set ENGRAM_PASSPHRASE to activate sync.',
      );
    } else if (!config.sync.cloudBaseUrl) {
      log.warn('sync.enabled is true but sync.cloudBaseUrl is not set — sync deactivated.');
    } else {
      try {
        // Derive master key from passphrase (same derivation as Plan K)
        const masterKeySalt = config.engramAccount?.masterKeySalt ?? '';
        if (!masterKeySalt) throw new Error('sync requires engramAccount.masterKeySalt');

        const masterKeyRaw = await deriveMasterKey(passphrase, masterKeySalt);
        const masterKey = Buffer.from(masterKeyRaw);
        const opsLogger = new OpsLogger(db, identity, masterKey);
        store.setOpsLogger(opsLogger);
        log.info('ops logger wired — all writes will be logged for sync');

        const applier = new ReplayApplier(db, store, masterKey);
        const jwtToken = config.engramAccount?.jwt ?? '';

        const channelClient = new ChannelClient({
          cloudBaseUrl: config.sync.cloudBaseUrl,
          jwtToken,
          deviceId: identity.device_id,
          opsLogger,
          applier,
          localDeviceId: identity.device_id,
        });

        // Wire push-on-write events
        store.events.on('memory.added', () => channelClient.pushNow().catch(() => {}));
        store.events.on('memory.deleted', () => channelClient.pushNow().catch(() => {}));
        store.events.on('memory.updated', () => channelClient.pushNow().catch(() => {}));

        // Boot catch-up replay before starting live subscription
        log.info('starting boot catch-up replay…');
        replayFromCloud({
          cloudBaseUrl: config.sync.cloudBaseUrl,
          jwtToken,
          localDeviceId: identity.device_id,
          opsLogger,
          applier,
        })
          .then(({ applied }) => {
            log.info('boot catch-up done', { applied });
            channelClient.start();
          })
          .catch((err) => {
            log.warn('boot catch-up failed, starting live sub anyway', { err });
            channelClient.start();
          });

        channelClientStop = () => channelClient.stop();
        log.info('sync channel client configured', {
          deviceId: identity.device_id.slice(0, 8) + '…',
          cloudBaseUrl: config.sync.cloudBaseUrl,
        });
      } catch (e) {
        log.error(`Failed to start sync: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const shutdown = async () => {
    channelClientStop?.();
    pollerStop?.();
    await moduleRegistry.shutdownAll();
  };

  const runtime: EngramRuntime = { store, router, algorithms, prompts, shutdown };

  // Load private extensions (gitignored — only present on hosted Engram deployments).
  // The path is computed at runtime so TypeScript won't fail when src/private/ is absent.
  try {
    const privatePath = new URL('../../private/index.js', import.meta.url).href;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import(/* @vite-ignore */ privatePath)) as any;
    await (mod.registerPrivateExtensions as (r: EngramRuntime) => Promise<void>)(runtime);
    log.info('Private extensions loaded');
  } catch {
    log.debug('No private extensions — OSS build');
  }

  return runtime;
}

export async function startStdioMcpServer(runtime: EngramRuntime): Promise<void> {
  const { router } = runtime;

  const server = new Server(
    {
      name: 'engram-mcp',
      version: '0.2.0',
    },
    {
      capabilities: { tools: {} },
      instructions: ENGRAM_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: router.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await router.call(name, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`Tool ${name} failed: ${msg}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('EngramMCP server listening on stdio');
}
