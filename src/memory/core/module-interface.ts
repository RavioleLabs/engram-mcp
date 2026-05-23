import type { MemoryItem, IngestInput } from '../../types.js';
import type { MemoryStore } from './store.js';

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: object; // JSON Schema object
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface MemoryModuleContext {
  // Provided by the registry at boot
  store: MemoryStore;
}

export interface MemoryModule {
  id: string; // 'notes', 'conversations', ...
  displayName: string;
  isCustom: boolean;

  onBoot(ctx: MemoryModuleContext): Promise<void>;
  onShutdown(): Promise<void>;

  ingest(input: IngestInput): Promise<MemoryItem[]>;

  tools: MCPToolDefinition[];

  startWatcher?(): void;
  stopWatcher?(): void;
}
