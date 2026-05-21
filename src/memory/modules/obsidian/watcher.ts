import fs from 'fs';
import path from 'path';
import { createLogger } from '../../../logger.js';
import { sourceRegistry } from '../../core/source-registry.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { buildObsidianItem } from './ingest.js';

const log = createLogger('obsidian:watcher');

const watchers = new Map<string, fs.FSWatcher>();
const pendingByPath = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 1500;

export function startObsidianWatchers(store: MemoryStore, config: EngramConfig): void {
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;
  const sources = sourceRegistry.listEnabled('obsidian');
  for (const s of sources) {
    const vaultPath = s.external_id;
    try {
      const w = fs.watch(vaultPath, { recursive: true }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.md')) return;
        const abs = path.join(vaultPath, filename);
        scheduleReingest(abs, vaultPath, store, embeddingModel, s.id);
      });
      watchers.set(vaultPath, w);
      log.info(`Watching Obsidian vault ${vaultPath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`Failed to watch ${vaultPath}: ${msg}`);
    }
  }
}

export function stopObsidianWatchers(): void {
  for (const [p, w] of watchers) {
    try {
      w.close();
      log.info(`Stopped watching ${p}`);
    } catch {
      // ignore close errors
    }
  }
  watchers.clear();
  for (const t of pendingByPath.values()) clearTimeout(t);
  pendingByPath.clear();
}

function scheduleReingest(
  abs: string,
  vaultPath: string,
  store: MemoryStore,
  embeddingModel: string,
  sourceRegistryId: string,
): void {
  const existing = pendingByPath.get(abs);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    pendingByPath.delete(abs);
    try {
      if (!fs.existsSync(abs)) {
        await store.deleteBySourceId(`obsidian:${abs}`);
        log.info(`Removed deleted file: ${abs}`);
        sourceRegistry.recordSync(sourceRegistryId, new Date().toISOString());
        return;
      }
      const stats = await fs.promises.stat(abs);
      const content = await fs.promises.readFile(abs, 'utf-8');
      const item = buildObsidianItem({
        file: {
          absolutePath: abs,
          relativePath: path.relative(vaultPath, abs),
          content,
          modifiedAt: stats.mtimeMs,
        },
        vaultRoot: vaultPath,
        embeddingModel,
      });
      await store.deleteBySourceId(item.source_id);
      await store.insert(item);
      sourceRegistry.recordSync(sourceRegistryId, new Date().toISOString());
      log.info(`Re-ingested ${abs}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`Re-ingest failed for ${abs}: ${msg}`);
    }
  }, DEBOUNCE_MS);

  pendingByPath.set(abs, timer);
}
