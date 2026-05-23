import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../../../logger.js';

const log = createLogger('obsidian:vault-reader');

export interface ObsidianFile {
  absolutePath: string;
  relativePath: string; // relative to vault root
  content: string;
  modifiedAt: number; // ms epoch
}

export async function readVault(vaultRoot: string): Promise<ObsidianFile[]> {
  const root = path.resolve(vaultRoot);
  const ignorePatterns = await loadIgnore(root);
  const files: ObsidianFile[] = [];
  await walk(root, root, ignorePatterns, files);
  log.info(`Read ${files.length} markdown files from ${root}`);
  return files;
}

async function loadIgnore(root: string): Promise<RegExp[]> {
  const ignoreFile = path.join(root, '.obsidianignore');
  try {
    const content = await fs.readFile(ignoreFile, 'utf-8');
    return content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map(globToRegex);
  } catch {
    return [];
  }
}

function globToRegex(glob: string): RegExp {
  let escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (!escaped.startsWith('/')) escaped = `(^|/)${escaped}`;
  return new RegExp(`${escaped}$`);
}

function isIgnored(rel: string, patterns: RegExp[]): boolean {
  // Always ignore Obsidian config + system folders
  if (rel.includes('/.obsidian/') || rel.startsWith('.obsidian/') || rel === '.obsidian')
    return true;
  if (rel.includes('/.trash/') || rel.startsWith('.trash/') || rel === '.trash') return true;
  for (const p of patterns) {
    if (p.test(rel)) return true;
  }
  return false;
}

async function walk(
  root: string,
  current: string,
  ignore: RegExp[],
  out: ObsidianFile[],
): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (e) {
    log.warn(`Failed to read ${current}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const e of entries) {
    const abs = path.join(current, e.name);
    const rel = path.relative(root, abs);
    if (isIgnored(rel, ignore)) continue;
    if (e.isDirectory()) {
      await walk(root, abs, ignore, out);
    } else if (e.isFile() && abs.endsWith('.md')) {
      try {
        const content = await fs.readFile(abs, 'utf-8');
        const stats = await fs.stat(abs);
        out.push({
          absolutePath: abs,
          relativePath: rel,
          content,
          modifiedAt: stats.mtimeMs,
        });
      } catch (e) {
        log.warn(`Failed to read ${abs}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
