import cron, { type ScheduledTask } from 'node-cron';
import { createLogger } from '../../../logger.js';
import { sourceRegistry } from '../../core/source-registry.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { getPageMetadata, fetchPageText } from './connector.js';
import { buildNotionItem } from './ingest.js';

const log = createLogger('notion:watcher');

let task: ScheduledTask | null = null;

export function startNotionWatcher(store: MemoryStore, config: EngramConfig): void {
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  task = cron.schedule('*/15 * * * *', async () => {
    const sources = sourceRegistry.listEnabled('notion');
    for (const s of sources) {
      try {
        const meta = await getPageMetadata(s.external_id);
        if (s.last_modified_remote && meta.last_edited_time === s.last_modified_remote) continue;
        const content = await fetchPageText(meta.id);
        await store.deleteBySourceId(`notion:${meta.id}`);
        const item = buildNotionItem({ metadata: meta, content, embeddingModel });
        await store.insert(item);
        sourceRegistry.recordSync(s.id, meta.last_edited_time);
        log.info(`Re-synced notion:${meta.id} (${meta.title})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        sourceRegistry.recordSync(s.id, s.last_modified_remote, msg);
        log.warn(`Notion watcher error on ${s.external_id}: ${msg}`);
      }
    }
  });
  task.start();
  log.info('Notion watcher started (every 15min)');
}

export function stopNotionWatcher(): void {
  if (task) {
    task.stop();
    task = null;
    log.info('Notion watcher stopped');
  }
}
