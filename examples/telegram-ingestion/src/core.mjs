import { EngramCloud, endpointURL } from '../../../packages/cloud-sdk/src/index.mjs';

export function validateConfig(config) {
  endpointURL(config.endpoint);
  if (
    !/^\d+$/.test(config.botId) ||
    !Array.isArray(config.mappings) ||
    !config.mappings.length ||
    config.mappings.length > 100
  )
    throw Error('invalid_config');
  const routes = new Set();
  for (const mapping of config.mappings) {
    if (
      !/^-?\d+$/.test(mapping.chatId) ||
      !(
        mapping.topicId === null ||
        (Number.isSafeInteger(mapping.topicId) && mapping.topicId > 0)
      ) ||
      !['command', 'all'].includes(mapping.mode) ||
      typeof mapping.keyFile !== 'string' ||
      !mapping.keyFile
    )
      throw Error('invalid_mapping');
    if (mapping.mode === 'command' && !/^[a-z][a-z0-9_]{0,31}$/.test(mapping.command))
      throw Error('invalid_command');
    const route = JSON.stringify([mapping.chatId, mapping.topicId]);
    if (routes.has(route)) throw Error('duplicate_mapping');
    routes.add(route);
  }
  return config;
}
export function toMemory(update, config, botUsername, version) {
  const message =
    update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
  if (!message || message.from?.is_bot || message.has_protected_content) return null;
  const mapping = config.mappings.find(
    (m) =>
      m.chatId === String(message.chat?.id) && m.topicId === (message.message_thread_id ?? null),
  );
  if (!mapping) return null;
  let text = message.text ?? message.caption;
  if (typeof text !== 'string' || !text.trim()) return null;
  if (mapping.mode === 'command') {
    const match = text.match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
    if (
      !match ||
      match[1].toLowerCase() !== mapping.command ||
      (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase())
    )
      return null;
    text = match[3]?.trim();
    if (!text) return null;
  }
  if (text.length > 8000) throw Error('message_too_large');
  if (!Number.isSafeInteger(message.message_id)) throw Error('invalid_message');
  const externalId = 'telegram:' + config.botId + ':' + mapping.chatId + ':' + message.message_id;
  const url = String(message.chat.id).startsWith('-100')
    ? 'https://t.me/c/' + String(message.chat.id).slice(4) + '/' + message.message_id
    : undefined;
  return {
    mapping,
    record: {
      externalId,
      version,
      title: text.split('\n')[0].slice(0, 180),
      text,
      tags: [
        'telegram',
        update.edited_message || update.edited_channel_post ? 'edited' : 'message',
      ],
      ...(url ? { url } : {}),
    },
  };
}
export class TelegramAPI {
  #token;
  #fetch;
  constructor(token, fetchImpl = globalThis.fetch) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw Error('invalid_bot_token');
    this.#token = token;
    this.#fetch = fetchImpl;
  }
  async call(method, input = {}, signal) {
    if (!['getMe', 'getWebhookInfo', 'getUpdates'].includes(method))
      throw Error('unsupported_telegram_method');
    try {
      const timeout = AbortSignal.timeout(65000);
      const response = await this.#fetch(
        'https://api.telegram.org/bot' + this.#token + '/' + method,
        {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        },
      );
      const data = await response.json();
      if (!response.ok || !data.ok) throw Error('telegram_request_failed');
      return data.result;
    } catch {
      throw Error(signal?.aborted ? 'stopped' : 'telegram_request_failed');
    }
  }
}
export async function checkBot(api, config, signal) {
  const me = await api.call('getMe', {}, signal);
  if (String(me.id) !== config.botId) throw Error('bot_identity_mismatch');
  const webhook = await api.call('getWebhookInfo', {}, signal);
  if (webhook.url) throw Error('webhook_already_configured');
  return me;
}
export async function deliverUpdate({
  update,
  config,
  botUsername,
  state,
  save,
  clientFor,
  signal,
}) {
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0)
    throw Error('invalid_update');
  if (update.update_id < state.offset) return state;
  // Persist the assigned version BEFORE delivery. A crash replays the same version.
  // A global monotonic clock also handles multiple edits in the same Telegram second.
  const version =
    state.pending?.updateId === update.update_id
      ? state.pending.version
      : Math.max(Date.now(), state.lastVersion + 1);
  const memory = toMemory(update, config, botUsername, version);
  if (memory) {
    state = { ...state, pending: { updateId: update.update_id, version }, lastVersion: version };
    await save(state);
    try {
      await clientFor(memory.mapping).remember(memory.record, { signal });
    } catch (error) {
      // An intentional deletion/expiry must not block all subsequent chat messages.
      if (error.code !== 'record_deleted' || error.status !== 409) throw error;
    }
  }
  state = {
    ...state,
    offset: update.update_id + 1,
    pending: null,
    lastVersion: Math.max(state.lastVersion, version),
  };
  await save(state);
  return state;
}
export const makeClient = (config, key) => new EngramCloud({ endpoint: config.endpoint, key });
