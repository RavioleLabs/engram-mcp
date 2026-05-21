import { ulid } from 'ulid';
import { createHash } from 'crypto';
import type { MemoryItem, MemoryProperties } from '../../../types.js';
import { extractWikilinks } from '../../core/wikilinks.js';

export interface ExchangeInput {
  user_message: string;
  assistant_message: string;
  source_id?: string;
  agent?: string;             // e.g. "claude-code", "cursor"
  properties?: Partial<MemoryProperties>;
}

export function buildExchangeItem(input: ExchangeInput, embeddingModel: string): MemoryItem {
  const now = new Date().toISOString();
  const content = formatExchange(input.user_message, input.assistant_message);

  const properties: MemoryProperties = {
    created_at: input.properties?.created_at ?? now,
    ingested_at: now,
    title: input.properties?.title,
    tags: input.properties?.tags,
    source_url: input.properties?.source_url,
    author: input.agent ?? input.properties?.author,
    sentiment: input.properties?.sentiment,
    action_required: input.properties?.action_required,
    expires_at: input.properties?.expires_at,
    custom: {
      ...(input.properties?.custom ?? {}),
      user_msg_length: input.user_message.length,
      assistant_msg_length: input.assistant_message.length,
    },
  };

  return {
    id: ulid(),
    type: 'conversations',
    source_id: input.source_id ?? `agent:${input.agent ?? 'unknown'}:${Date.now()}`,
    content,
    content_hash: createHash('sha256').update(content).digest('hex'),
    properties,
    wikilinks: extractWikilinks(content),
    related_ids: [],
    embedding_model: embeddingModel,
  };
}

function formatExchange(userMsg: string, assistantMsg: string): string {
  return `User: ${userMsg.trim()}\n\nAssistant: ${assistantMsg.trim()}`;
}

