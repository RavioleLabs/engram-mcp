// GET /api/version — returns the installed engram-mcp version.
// Used by the cloud dashboard to detect when an update is available
// (compares with `https://registry.npmjs.org/@raviolelabs/engram-mcp/latest`).
// Manual install only — we never auto-update.

import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let cachedVersion: string | null = null;

function loadVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    // package.json sits two dirs above dist/server/api/version.js → ../../../package.json
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of ['../../../package.json', '../../package.json', '../package.json']) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(here, candidate), 'utf-8')) as {
          version?: string;
        };
        if (pkg.version) {
          cachedVersion = pkg.version;
          return cachedVersion;
        }
      } catch {
        /* try next */
      }
    }
  } catch {
    /* fall through */
  }
  cachedVersion = 'unknown';
  return cachedVersion;
}

export function versionApi(): Router {
  const r = Router();
  r.get('/', (_req: Request, res: Response) => {
    res.json({
      version: loadVersion(),
      package: '@raviolelabs/engram-mcp',
      registry_url: 'https://registry.npmjs.org/@raviolelabs/engram-mcp/latest',
      changelog_url: 'https://github.com/RavioleLabs/engram-mcp/releases',
      update_command: 'npm install -g @raviolelabs/engram-mcp@latest',
    });
  });
  return r;
}
