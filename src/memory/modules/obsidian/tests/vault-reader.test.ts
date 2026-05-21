import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readVault } from '../vault-reader.js';

describe('vault-reader', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-vault-'));
    fs.writeFileSync(path.join(vault, 'note1.md'), '# First note\n[[note2]] reference');
    fs.mkdirSync(path.join(vault, 'sub'));
    fs.writeFileSync(path.join(vault, 'sub', 'note2.md'), '# Second\nlots of content');
    // Files that should be ignored
    fs.mkdirSync(path.join(vault, '.obsidian'));
    fs.writeFileSync(path.join(vault, '.obsidian', 'workspace.json'), '{}');
    fs.writeFileSync(path.join(vault, 'photo.png'), 'not markdown');
    // .obsidianignore
    fs.writeFileSync(path.join(vault, '.obsidianignore'), 'archive/*\nprivate/**\n');
    fs.mkdirSync(path.join(vault, 'archive'));
    fs.writeFileSync(path.join(vault, 'archive', 'old.md'), 'should not appear');
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('returns markdown files only, respecting .obsidianignore + .obsidian/', async () => {
    const files = await readVault(vault);
    const rels = files.map((f) => f.relativePath).sort();
    expect(rels).toEqual(['note1.md', 'sub/note2.md']);
  });

  it('reads content correctly', async () => {
    const files = await readVault(vault);
    const note1 = files.find((f) => f.relativePath === 'note1.md');
    expect(note1?.content).toContain('First note');
    expect(note1?.content).toContain('[[note2]]');
  });
});
