import { readFile, writeFile, rename, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validateConfig, TelegramAPI, checkBot, deliverUpdate, makeClient } from './core.mjs';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
let lockPath,
  ownsLock = false;
try {
  const config = validateConfig(
    JSON.parse(await readFile(process.env.ENGRAM_TELEGRAM_CONFIG || 'config.local.json', 'utf8')),
  );
  const stateFile = resolve(config.stateFile || 'data/checkpoint.json');
  lockPath = stateFile + '.lock';
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  // Fail closed if another instance, or a crashed instance's lock, exists.
  const lock = await open(lockPath, 'wx', 0o600);
  ownsLock = true;
  await lock.writeFile(String(process.pid));
  await lock.close();
  let state = {
    offset: 0,
    lastVersion: 0,
    pending: null,
    botId: config.botId,
    lastDeliveryAt: Date.now(),
  };
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw Error('invalid_checkpoint');
  }
  if (
    state.botId !== config.botId ||
    !Number.isSafeInteger(state.offset) ||
    state.offset < 0 ||
    !Number.isSafeInteger(state.lastVersion) ||
    !Number.isFinite(state.lastDeliveryAt) ||
    !(
      state.pending === null ||
      (Number.isSafeInteger(state.pending?.updateId) &&
        Number.isSafeInteger(state.pending?.version))
    )
  )
    throw Error('invalid_checkpoint');
  const save = async (next) => {
    const file = await open(stateFile + '.tmp', 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify(next));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(stateFile + '.tmp', stateFile);
    const dir = await open(dirname(stateFile), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    state = next;
  };
  const token = (
    process.env.TELEGRAM_BOT_TOKEN_FILE
      ? await readFile(process.env.TELEGRAM_BOT_TOKEN_FILE, 'utf8')
      : process.env.TELEGRAM_BOT_TOKEN || ''
  ).trim();
  const telegram = new TelegramAPI(token);
  const me = await checkBot(telegram, config, controller.signal);
  const clientFor = (mapping) => ({
    remember: async (record, options) => {
      // Re-read the key file for every delivery; atomic file rotation needs no process restart.
      const key = (await readFile(mapping.keyFile, 'utf8')).trim();
      return makeClient(config, key).remember(record, options);
    },
  });
  process.stderr.write(
    'Engram Telegram ingestion started. Only configured chats and topics will be collected.\n',
  );
  while (!controller.signal.aborted) {
    try {
      // Telegram may choose a random update_id after a week without new updates.
      // Its update backlog lasts at most 24 hours; discard the old high-water mark after six idle days.
      if (Date.now() - state.lastDeliveryAt > 6 * 86400000)
        await save({ ...state, offset: 0, pending: null, lastDeliveryAt: Date.now() });
      const updates = await telegram.call(
        'getUpdates',
        {
          offset: state.offset,
          timeout: 50,
          limit: 50,
          allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
        },
        controller.signal,
      );
      if (!Array.isArray(updates)) throw Error('invalid_updates');
      for (const update of updates) {
        if (controller.signal.aborted) break;
        state = await deliverUpdate({
          update,
          config,
          botUsername: me.username,
          state,
          save,
          clientFor,
          signal: controller.signal,
        });
        await save({ ...state, lastDeliveryAt: Date.now() });
      }
    } catch (error) {
      if (controller.signal.aborted) break;
      const known = [
        'invalid_or_expired_key',
        'context_capacity_reached',
        'record_deleted',
        'context_access_denied',
      ];
      const code = known.includes(error.code) ? error.code : 'delivery_failed';
      process.stderr.write(
        'Engram ingestion: ' +
          code +
          '. Check credentials, permissions, capacity and connectivity. Retrying without acknowledging the failed update.\n',
      );
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, 10000);
        controller.signal.addEventListener('abort', done, { once: true });
      });
    }
  }
} catch {
  if (!controller.signal.aborted) {
    process.stderr.write(
      'Engram ingestion could not start. Check config, secret files, bot ID, existing webhook, and checkpoint lock. Never remove the lock while another instance is running.\n',
    );
    process.exitCode = 1;
  }
} finally {
  if (ownsLock) await unlink(lockPath).catch(() => {});
}
