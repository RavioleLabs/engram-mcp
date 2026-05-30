import { z } from 'zod';

export const EmbeddingsConfigSchema = z.object({
  provider: z
    .enum(['ollama', 'engram', 'engram-hosted', 'voyage', 'openai', 'openai-compatible'])
    .default('ollama'),
  baseUrl: z.string().url().optional(),
  // Default to bge-m3 — multilingual, 1024-d, recommended in stress test v3
  // (specs/2026-05-29-…-v3) for FR/multilingual content (+48 r@1 pts vs
  // nomic-embed-text). install.sh auto-detects RAM and writes the explicit
  // model when running on <8 GB machines (drops back to nomic), so this
  // default fires only for programmatic usage or hand-rolled configs that
  // omit the embeddings section entirely.
  model: z.string().default('bge-m3'),
  apiKey: z.string().optional(),
  dimensions: z.number().int().positive().default(1024),
});

export type EmbeddingsConfig = z.infer<typeof EmbeddingsConfigSchema>;

/**
 * Optional, off-by-default. EngramMCP does NOT run a local LLM for property
 * extraction by default — the calling agent (Claude/GPT/etc.) is already an
 * LLM and should provide `title` + `tags` when it calls `add_note` or
 * `remember_exchange`. Power users who want background auto-extraction can
 * enable this and point at a local Ollama instance; Pro users will get
 * hosted server-side extraction (Phase 2).
 */
export const PropertyExtractionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().default('http://localhost:11434'),
  model: z.string().default('llama3.2:3b'),
  apiKey: z.string().optional(),
  maxTokens: z.number().int().positive().default(300),
});

export type PropertyExtractionConfig = z.infer<typeof PropertyExtractionConfigSchema>;

/**
 * LLM rerank — second-stage ranking that asks an LLM to order RRF top
 * candidates by relevance. Off by default; requires an API key. Pushes
 * r@10 toward ~99% on FR fixtures (stress test §TODO-6, target 99%).
 */
export const RerankConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['anthropic', 'cohere', 'openai']).default('anthropic'),
  model: z.string().default('claude-haiku-4-5'),
  apiKey: z.string().optional(),
  topN: z.number().int().positive().default(20),
  timeoutMs: z.number().int().positive().default(15_000),
});

export type RerankConfig = z.infer<typeof RerankConfigSchema>;

/**
 * Query expansion — generates 2-3 alternate phrasings of the user query
 * via LLM, runs semantic search on each variant in parallel, fuses by
 * RRF. Off by default; same API key as rerank. Worth +2-4 pts r@10.
 */
export const ExpansionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['anthropic', 'openai']).default('anthropic'),
  model: z.string().default('claude-haiku-4-5'),
  apiKey: z.string().optional(),
  variants: z.number().int().min(1).max(5).default(3),
  timeoutMs: z.number().int().positive().default(10_000),
});

export type ExpansionConfig = z.infer<typeof ExpansionConfigSchema>;

export const DriveOAuthSchema = z
  .object({
    clientId: z.string(),
    clientSecret: z.string(),
    redirectPort: z.number().int().positive().default(7777),
  })
  .optional();

export const NotionOAuthSchema = z
  .object({
    clientId: z.string(),
    clientSecret: z.string(),
    redirectPort: z.number().int().positive().default(7777),
  })
  .optional();

export const WhisperConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /**
     * "local" = whisper.cpp via nodejs-whisper (default, free)
     * "engram-hosted" = Pro tier: POST audio to api.engram-mcp.com/api/whisper
     */
    provider: z.enum(['local', 'engram-hosted']).default('local').optional(),
    model: z
      .enum(['tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en', 'medium', 'medium.en'])
      .default('small.en'),
    language: z.string().default('auto'),
  })
  .default({
    enabled: true,
    provider: 'local',
    model: 'small.en',
    language: 'auto',
  });

export const YoutubeConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    preferLanguage: z.string().default('en'),
    fallbackToYtdlp: z.boolean().default(true),
    /** Channel RSS poll interval in ms. Configurable via config.json youtube.channelPollIntervalMs. Default 6h. */
    channelPollIntervalMs: z.number().int().positive().optional(),
    watchLaterPlaylistId: z.string().optional(),
  })
  .default({
    enabled: true,
    preferLanguage: 'en',
    fallbackToYtdlp: true,
  });

export type WhisperConfig = z.infer<typeof WhisperConfigSchema>;
export type YoutubeConfig = z.infer<typeof YoutubeConfigSchema>;

export const ModuleEnabledSchema = z.object({
  enabled: z.boolean().default(true),
});

/**
 * Engram cloud account config — populated by `engram-mcp pair`.
 * This section is optional; absence means the user has not paired and
 * all cloud features (transit poller, bridge relay) stay dormant.
 */
export const EngramAccountConfigSchema = z
  .object({
    /** JWT for Plan J / Plan I auth — short-lived, refreshed automatically */
    jwt: z.string(),
    /** Refresh token — stored in oauth_tokens table, used to renew JWT */
    refreshToken: z.string(),
    /** Engram API key — issued by Plan I at pairing time */
    apiKey: z.string(),
    /**
     * ID of the master key envelope persisted in module_state.
     * The actual master key is derived at runtime from the user's passphrase
     * and a salt stored here (never plaintext in config).
     */
    masterKeySalt: z.string(), // hex-encoded 32-byte Argon2id salt
    /** Pairing timestamp (ISO) — informational */
    pairedAt: z.string().optional(),
    /** @deprecated baseUrl was previously configurable. It is now hardcoded
     *  to https://api.engram-mcp.com (see src/cloud/endpoints.ts) — this field
     *  is accepted for backward-compat parsing of older configs but ignored. */
    baseUrl: z.string().url().optional(),
  })
  .optional();

export type EngramAccountConfig = z.infer<typeof EngramAccountConfigSchema>;

export const SyncConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** @deprecated cloudBaseUrl is now hardcoded to https://api.engram-mcp.com
     *  (see src/cloud/endpoints.ts). Field kept for legacy config parsing only. */
    cloudBaseUrl: z.string().url().optional(),
  })
  .optional();

export type SyncConfig = z.infer<typeof SyncConfigSchema>;

export const EngramConfigSchema = z.object({
  dataDir: z.string().default('~/.engram'),
  // Default to local Ollama with bge-m3 (what install.sh sets up on ≥8 GB
  // machines — drops back to nomic-embed-text on lower-RAM hosts via
  // explicit config.json). Without a default here a config that only
  // contains engramAccount fails Zod parse → engram-mcp crashes (exit 78)
  // immediately on launch.
  embeddings: EmbeddingsConfigSchema.default({
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'bge-m3',
    dimensions: 1024,
  }),
  drive: DriveOAuthSchema,
  notion: NotionOAuthSchema,
  propertyExtraction: PropertyExtractionConfigSchema.default({
    enabled: false,
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:3b',
    maxTokens: 300,
  }),
  whisper: WhisperConfigSchema,
  youtube: YoutubeConfigSchema,
  modules: z.record(z.string(), ModuleEnabledSchema).default({}),
  mcp: z
    .object({
      stdio: z.boolean().default(true),
      httpPort: z.number().int().positive().default(7777),
    })
    .default({ stdio: true, httpPort: 7777 }),
  // Ingest tool config — currently just an allowlist of extra directories the
  // file:// URI validator will accept beyond the built-in ~/Documents,
  // ~/Downloads, ~/Desktop, ~/Movies, ~/Music defaults. Use absolute paths
  // (tilde expansion is the caller's job — node won't expand "~/foo").
  // Example: { ingest: { allowedPaths: ["/Users/me/code", "/Users/me/raviolelabs"] } }
  ingest: z
    .object({
      allowedPaths: z.array(z.string()).default([]),
    })
    .default({ allowedPaths: [] }),
  rerank: RerankConfigSchema.default({
    enabled: false,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    topN: 20,
    timeoutMs: 15_000,
  }),
  queryExpansion: ExpansionConfigSchema.default({
    enabled: false,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    variants: 3,
    timeoutMs: 10_000,
  }),
  // Plan K addition — optional; absence = not paired, all cloud features dormant
  engramAccount: EngramAccountConfigSchema,
  // Plan N addition — optional; ops-log bidirectional sync
  sync: SyncConfigSchema,
});

export type EngramConfig = z.infer<typeof EngramConfigSchema>;

export const defaultConfig: EngramConfig = {
  dataDir: process.env.DATA_DIR ?? '~/.engram',
  embeddings: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'bge-m3',
    dimensions: 1024,
  },
  propertyExtraction: {
    enabled: false,
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:3b',
    maxTokens: 300,
  },
  whisper: {
    enabled: true,
    provider: 'local',
    model: 'small.en',
    language: 'auto',
  },
  youtube: {
    enabled: true,
    preferLanguage: 'en',
    fallbackToYtdlp: true,
  },
  modules: {
    notes: { enabled: true },
    conversations: { enabled: true },
    drive: { enabled: true },
    notion: { enabled: true },
    audio: { enabled: true },
    youtube: { enabled: true },
  },
  mcp: { stdio: true, httpPort: 7777 },
  ingest: { allowedPaths: [] },
  rerank: {
    enabled: false,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    topN: 20,
    timeoutMs: 15_000,
  },
  queryExpansion: {
    enabled: false,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    variants: 3,
    timeoutMs: 10_000,
  },
};
