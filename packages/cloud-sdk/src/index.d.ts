export interface MemoryRecord {
  externalId: string;
  version: number;
  title: string;
  text: string;
  tags?: string[];
  url?: string;
}
export interface RetrievedRecord extends MemoryRecord {
  sourceId: string;
  updatedAt: number;
  score: number;
}
export class EngramError extends Error {
  code: string;
  status: number;
  constructor(code: string, status?: number);
}
export function endpointURL(value: string): string;
export class EngramCloud {
  constructor(options: {
    endpoint: string;
    key: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    retries?: number;
  });
  remember(
    record: MemoryRecord,
    options?: { signal?: AbortSignal },
  ): Promise<{ externalId: string; version: number; changed: boolean }>;
  recall(
    query: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<{
    contextId: string;
    search: 'lexical';
    untrustedSourceContent: true;
    records: RetrievedRecord[];
  }>;
  forget(
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ externalId: string; deleted: true }>;
}
