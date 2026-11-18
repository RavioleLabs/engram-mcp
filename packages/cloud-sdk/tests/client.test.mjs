import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngramCloud, EngramError, endpointURL } from '../src/index.mjs';
const key = 'egc_' + 'a'.repeat(43);
test('SDK binds requests to the configured origin and keeps secrets out of serialized objects', async () => {
  let request;
  const client = new EngramCloud({
    endpoint: 'https://memory.example',
    key,
    fetch: async (url, init) => {
      request = { url, init };
      return Response.json({ changed: true });
    },
  });
  assert.deepEqual(
    await client.remember({ externalId: 'note', version: 1, title: 'Test', text: 'Decision' }),
    { changed: true },
  );
  assert.equal(request.url, 'https://memory.example/v1/records');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers.authorization, 'Bearer ' + key);
  assert.equal(JSON.stringify(client), '{}');
});
test('unsafe endpoints are rejected', () => {
  for (const value of [
    'http://public.example',
    'https://user:secret@memory.example',
    'https://memory.example/path',
    'https://memory.example/?token=x',
  ])
    assert.throws(() => endpointURL(value));
  assert.equal(endpointURL('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
});
test('authorization failures are not retried and unexpected response text is sanitized', async () => {
  let calls = 0;
  const client = new EngramCloud({
    endpoint: 'https://memory.example',
    key,
    fetch: async () => {
      calls++;
      return Response.json({ error: 'secret=' + key }, { status: 401 });
    },
  });
  await assert.rejects(
    () => client.recall('decision'),
    (e) => e instanceof EngramError && e.code === 'request_failed' && !e.message.includes(key),
  );
  assert.equal(calls, 1);
});
test('network failures do not expose credentials in errors', async () => {
  const client = new EngramCloud({
    endpoint: 'https://memory.example',
    key,
    retries: 0,
    fetch: async () => {
      throw Error('failed ' + key);
    },
  });
  await assert.rejects(
    () => client.forget('note'),
    (e) => e.code === 'connection_failed' && !e.message.includes(key),
  );
});
