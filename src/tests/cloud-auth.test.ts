import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb } from '../db/index.js';
import {
  saveTokens,
  loadTokens,
  clearTokens,
  isPaired,
  parseJwtExpiry,
  getApiKey,
} from '../cloud/auth.js';

// Minimal JWT with exp claim — not a real signed JWT but parseJwtExpiry only
// reads the payload, so this is fine for unit tests.
function makeTestJwt(expUnix: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'user_test', exp: expUnix })).toString(
    'base64url',
  );
  return `${header}.${payload}.fakesig`;
}

describe('cloud/auth', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-auth-'));
    initDb(tmpDir);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('isPaired() returns false before any save', () => {
    expect(isPaired()).toBe(false);
  });

  it('saveTokens + loadTokens round-trips all fields', () => {
    const expMs = Date.now() + 3600_000;
    const jwt = makeTestJwt(Math.floor(expMs / 1000));
    saveTokens({ jwt, refreshToken: 'rt-abc', apiKey: 'ak-xyz', expiresAt: expMs });
    expect(isPaired()).toBe(true);
    const loaded = loadTokens();
    expect(loaded).not.toBeNull();
    expect(loaded!.jwt).toBe(jwt);
    expect(loaded!.refreshToken).toBe('rt-abc');
    expect(loaded!.apiKey).toBe('ak-xyz');
    expect(loaded!.expiresAt).toBe(expMs);
  });

  it('saveTokens is idempotent — overwrites on second call', () => {
    const exp1 = Date.now() + 1000;
    const exp2 = Date.now() + 9999;
    saveTokens({ jwt: 'jwt1', refreshToken: 'rt1', apiKey: 'ak1', expiresAt: exp1 });
    saveTokens({ jwt: 'jwt2', refreshToken: 'rt2', apiKey: 'ak2', expiresAt: exp2 });
    const t = loadTokens()!;
    expect(t.jwt).toBe('jwt2');
    expect(t.apiKey).toBe('ak2');
  });

  it('clearTokens removes the row', () => {
    saveTokens({ jwt: 'j', refreshToken: 'r', apiKey: 'a', expiresAt: 1 });
    clearTokens();
    expect(isPaired()).toBe(false);
    expect(loadTokens()).toBeNull();
  });

  it('parseJwtExpiry extracts exp in ms', () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeTestJwt(expSec);
    expect(parseJwtExpiry(jwt)).toBe(expSec * 1000);
  });

  it('parseJwtExpiry throws on malformed JWT', () => {
    expect(() => parseJwtExpiry('notajwt')).toThrow(/Malformed/);
  });

  it('getApiKey throws when not paired', () => {
    expect(() => getApiKey()).toThrow(/Not paired/);
  });

  it('getApiKey returns stored key when paired', () => {
    saveTokens({
      jwt: makeTestJwt(Math.floor(Date.now() / 1000) + 3600),
      refreshToken: 'rt',
      apiKey: 'my-api-key',
      expiresAt: Date.now() + 3600_000,
    });
    expect(getApiKey()).toBe('my-api-key');
  });
});
