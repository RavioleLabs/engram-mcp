#!/usr/bin/env node
import { loadConfig } from '../config/index.js';
import { initDb } from '../db/index.js';
import { initVectorStore } from '../vector/store.js';
import { reindexAll } from '../memory/core/reindex.js';
import { createLogger } from '../logger.js';

const log = createLogger('reindex-cli');

async function main() {
  const config = loadConfig();
  initDb(config.dataDir);
  initVectorStore(config.dataDir);

  log.info(
    `Reindexing all memories against ${config.embeddings.provider}/${config.embeddings.model}…`,
  );

  const result = await reindexAll(config.embeddings, (p) => {
    process.stdout.write(`\r[${p.type}] ${p.processed}/${p.total}    `);
  });
  process.stdout.write('\n');
  log.info(`Done. ${result.total} memories reindexed across ${result.types.length} types.`);
}

main().catch((e) => {
  log.error(`Reindex failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
