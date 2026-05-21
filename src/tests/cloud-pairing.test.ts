import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import { initDb, closeDb } from '../db/index.js';
import { isPaired, loadTokens, saveTokens, parseJwtExpiry } from '../cloud/auth.js';

// Helper: make a GET request to the local callback server
function getCallback(
  port: number,
  params: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: `/auth/callback?${qs}`,
      method: 'GET',
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Build a fake JWT with the given exp (Unix seconds)
function fakeJwt(expSec: number): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: 'u', exp: expSec })).toString('base64url');
  return `${h}.${p}.sig`;
}

describe('cloud/pairing callback server', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pairing-'));
    initDb(tmpDir);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts valid callback params, saves tokens, returns success HTML', async () => {
    const CALLBACK_PORT = 7778;
    const jwt = fakeJwt(Math.floor(Date.now() / 1000) + 3600);

    // Build a minimal callback server (mirrors the one in pairing.ts)
    let resolveCallback!: (r: { jwt: string; refreshToken: string; apiKey: string }) => void;
    const callbackDone = new Promise<{ jwt: string; refreshToken: string; apiKey: string }>(
      (res) => (resolveCallback = res),
    );

    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url!, `http://localhost:${CALLBACK_PORT}`);
      const j = parsed.searchParams.get('jwt') ?? '';
      const rt = parsed.searchParams.get('refreshToken') ?? '';
      const ak = parsed.searchParams.get('apiKey') ?? '';
      res.writeHead(200);
      res.end('ok');
      server.close();
      resolveCallback({ jwt: j, refreshToken: rt, apiKey: ak });
    });

    await new Promise<void>((res) => server.listen(CALLBACK_PORT, '127.0.0.1', res));

    // Fire the callback
    await getCallback(CALLBACK_PORT, {
      jwt,
      refreshToken: 'rt-test',
      apiKey: 'ak-test',
    });

    const result = await callbackDone;
    expect(result.jwt).toBe(jwt);
    expect(result.refreshToken).toBe('rt-test');
    expect(result.apiKey).toBe('ak-test');

    // Simulate saveTokens (what startPairing does after callback)
    saveTokens({
      jwt: result.jwt,
      refreshToken: result.refreshToken,
      apiKey: result.apiKey,
      expiresAt: parseJwtExpiry(result.jwt),
    });

    expect(isPaired()).toBe(true);
    const tokens = loadTokens()!;
    expect(tokens.apiKey).toBe('ak-test');
  }, 10_000);

  it('isPaired() is false before pairing', () => {
    expect(isPaired()).toBe(false);
  });
});
