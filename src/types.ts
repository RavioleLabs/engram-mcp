import { z } from 'zod';

export const MemoryPropertiesSchema = z.object({
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  created_at: z.string(),
  ingested_at: z.string(),
  source_url: z.string().optional(),
  author: z.string().optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  action_required: z.boolean().optional(),
  expires_at: z.string().optional(),
  custom: z.record(z.unknown()).optional(),
});

export type MemoryProperties = z.infer<typeof MemoryPropertiesSchema>;

export const MemoryItemSchema = z.object({
  id: z.string().length(26), // ULID
  type: z.string().min(1),
  source_id: z.string(),
  content: z.string(),
  content_hash: z.string(),
  properties: MemoryPropertiesSchema,
  wikilinks: z.array(z.string()),
  related_ids: z.array(z.string()),
  embedding_model: z.string(),
});

/** Runtime type for a memory item. scope is optional — defaults to 'personal'. */
export type MemoryItem = z.infer<typeof MemoryItemSchema> & {
  /** Scope: 'personal' (default) or 'workspace:<ulid>' for team shared memories. */
  scope?: string;
};

export interface IngestInput {
  // The raw text or structured content to ingest
  content: string;
  // Source identifier (file path, URL, message id, etc.)
  source_id: string;
  // Optional properties to override or pre-fill
  properties?: Partial<MemoryProperties>;
}

export interface SearchResult {
  memory: MemoryItem;
  score: number;
  snippet: string;
  /** Which retrieval paths surfaced this result. */
  match?: 'semantic' | 'keyword' | 'both';
  /** True when no path returned a strong signal — caller may want to suppress or warn. */
  weak?: boolean;
}
