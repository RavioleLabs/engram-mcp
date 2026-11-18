import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngramError } from '../../../packages/cloud-sdk/src/index.mjs';
import { validateConfig, toMemory, deliverUpdate, checkBot, TelegramAPI } from '../src/core.mjs';
const config = {
  endpoint: 'https://memory.example',
  botId: '123',
  mappings: [
    { chatId: '-10077', topicId: null, keyFile: '/secret', mode: 'command', command: 'remember' },
  ],
};
const update = {
  update_id: 10,
  message: {
    message_id: 4,
    date: 1700000000,
    chat: { id: -10077 },
    from: { id: 44 },
    text: '/remember Ship in December',
  },
};
const state = () => ({ offset: 0, lastVersion: 0, pending: null });
test('intentional Engram deletion is acknowledged without restoring or blocking subsequent messages', async () => {
  const next = await deliverUpdate({
    update, config, botUsername: 'mybot', state: state(), save: async () => {},
    clientFor: () => ({ remember: async () => { throw new EngramError('record_deleted', 409); } }),
  });
  assert.equal(next.offset, update.update_id + 1);
  assert.equal(next.pending, null);
});
test('configuration fails closed on duplicate routes, insecure destinations and wildcards', () => {
  assert.equal(validateConfig(config), config);
  assert.throws(() =>
    validateConfig({ ...config, mappings: [config.mappings[0], config.mappings[0]] }),
  );
  assert.throws(() => validateConfig({ ...config, endpoint: 'http://example.com' }));
  assert.throws(() =>
    validateConfig({ ...config, mappings: [{ ...config.mappings[0], chatId: '*' }] }),
  );
});
test('only the exact chat/topic and explicit command are collected by default', () => {
  const result = toMemory(update, config, 'mybot', 1);
  assert.equal(result.record.text, 'Ship in December');
  assert.equal(result.record.externalId, 'telegram:123:-10077:4');
  for (const patch of [
    { chat: { id: -10088 } },
    { message_thread_id: 6 },
    { text: 'Private conversation' },
    { text: '/remember@otherbot hi' },
    { from: { is_bot: true } },
    { has_protected_content: true },
  ])
    assert.equal(
      toMemory({ ...update, message: { ...update.message, ...patch } }, config, 'mybot', 1),
      null,
    );
  assert.equal(
    toMemory(
      { ...update, message: { ...update.message, text: '/remember@mybot hello' } },
      config,
      'mybot',
      1,
    ).record.text,
    'hello',
  );
});
test('edited messages update the same external record with their assigned version', () => {
  const result = toMemory(
    {
      update_id: 11,
      edited_message: {
        ...update.message,
        edit_date: 1700000001,
        text: '/remember Ship in January',
      },
    },
    config,
    'mybot',
    2,
  );
  assert.equal(result.record.externalId, 'telegram:123:-10077:4');
  assert.equal(result.record.version, 2);
  assert.ok(result.record.tags.includes('edited'));
});
test('a failed delivery does not advance the checkpoint; restart retries the exact version', async () => {
  let saved = state();
  let firstRecord;
  const save = async (value) => {
    saved = structuredClone(value);
  };
  await assert.rejects(() =>
    deliverUpdate({
      update,
      config,
      botUsername: 'mybot',
      state: saved,
      save,
      clientFor: () => ({
        remember: async (r) => {
          firstRecord = r;
          throw Error('offline');
        },
      }),
    }),
  );
  assert.equal(saved.offset, 0);
  assert.equal(saved.pending.updateId, 10);
  let retry;
  saved = await deliverUpdate({
    update,
    config,
    botUsername: 'mybot',
    state: saved,
    save,
    clientFor: () => ({
      remember: async (r) => {
        retry = r;
      },
    }),
  });
  assert.deepEqual(retry, firstRecord);
  assert.equal(saved.offset, 11);
  assert.equal(saved.pending, null);
  let calls = 0;
  await deliverUpdate({
    update,
    config,
    botUsername: 'mybot',
    state: saved,
    save,
    clientFor: () => ({ remember: async () => calls++ }),
  });
  assert.equal(calls, 0);
});
test('unmapped messages are acknowledged without contacting Engram', async () => {
  const result = await deliverUpdate({
    update: { ...update, message: { ...update.message, chat: { id: 123 } } },
    config,
    botUsername: 'mybot',
    state: state(),
    save: async () => {},
    clientFor: () => {
      throw Error('must not call');
    },
  });
  assert.equal(result.offset, 11);
});
test('a configured webhook is never removed or taken over', async () => {
  const calls = [];
  await assert.rejects(
    () =>
      checkBot(
        {
          call: async (method) => {
            calls.push(method);
            return method === 'getMe'
              ? { id: 123, username: 'mybot' }
              : { url: 'https://company.example/webhook' };
          },
        },
        config,
      ),
    /webhook_already_configured/,
  );
  assert.deepEqual(calls, ['getMe', 'getWebhookInfo']);
});
test('bot identity mismatch blocks startup and credentials never escape errors', async () => {
  await assert.rejects(
    () => checkBot({ call: async () => ({ id: 999 }) }, config),
    /bot_identity_mismatch/,
  );
  const token = '123:top_secret';
  const api = new TelegramAPI(token, async () => {
    throw Error(token);
  });
  await assert.rejects(
    () => api.call('getMe'),
    (e) => !e.message.includes(token),
  );
  assert.equal(JSON.stringify(api), '{}');
});
