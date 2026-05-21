import cron, { type ScheduledTask } from 'node-cron';
import { createLogger } from '../../../logger.js';
import { sourceRegistry } from '../../core/source-registry.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { getFileMetadata, downloadFileContent } from './connector.js';
import { buildDriveItem } from './ingest.js';

const log = createLogger('drive:watcher');

let task: ScheduledTask | null = null;

export function startDriveWatcher(store: MemoryStore, config: EngramConfig): void {
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  task = cron.schedule('*/15 * * * *', async () => {
    const sources = sourceRegistry.listEnabled('drive');
    for (const s of sources) {
      try {
        const meta = await getFileMetadata(s.external_id, config);
        if (s.last_modified_remote && meta.modifiedTime === s.last_modified_remote) {
          continue;
        }
        const content = await downloadFileContent(s.external_id, meta.mimeType, config);
        if (!content) {
          sourceRegistry.recordSync(s.id, meta.modifiedTime, 'unsupported mimeType');
          continue;
        }
        await store.deleteBySourceId(`drive:${s.external_id}`);
        const item = buildDriveItem({ metadata: meta, content, embeddingModel });
        await store.insert(item);
        sourceRegistry.recordSync(s.id, meta.modifiedTime);
        log.info(`Re-synced drive:${s.external_id} (${meta.name})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        sourceRegistry.recordSync(s.id, s.last_modified_remote, msg);
        log.warn(`Drive watcher error on ${s.external_id}: ${msg}`);
      }
    }
  });
  task.start();
  log.info('Drive watcher started (every 15min)');
}

export function stopDriveWatcher(): void {
  if (task) {
    task.stop();
    task = null;
    log.info('Drive watcher stopped');
  }
}
