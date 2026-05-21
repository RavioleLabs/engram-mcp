import { ulid } from 'ulid';
import { createHash } from 'crypto';
import path from 'path';
import type { MemoryItem, MemoryProperties } from '../../../types.js';
import { extractWikilinks } from '../../core/wikilinks.js';
import type { ObsidianFile } from './vault-reader.js';

export interface ObsidianIngestInput {
  file: ObsidianFile;
  vaultRoot: string;
  embeddingModel: string;
}

export function buildObsidianItem(input: ObsidianIngestInput): MemoryItem {
  const now = new Date().toISOString();
  const modifiedIso = new Date(input.file.modifiedAt).toISOString();
  const title = extractTitle(input.file.content) ?? path.basename(input.file.relativePath, '.md');

  // Optional: parse frontmatter for tags
  const tags = parseFrontmatterTags(input.file.content);

  const properties: MemoryProperties = {
    title,
    tags,
    created_at: modifiedIso,
    ingested_at: now,
    source_url: `file://${input.file.absolutePath}`,
    custom: {
      vault_root: input.vaultRoot,
      relative_path: input.file.relativePath,
    },
  };

  return {
    id: ulid(),
    type: 'obsidian',
    source_id: `obsidian:${input.file.absolutePath}`,
    content: input.file.content,
    content_hash: createHash('sha256').update(input.file.content).digest('hex'),
    properties,
    wikilinks: extractWikilinks(input.file.content),
    related_ids: [],
    embedding_model: input.embeddingModel,
  };
}

function extractTitle(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  // 1. YAML frontmatter title:
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') break;
      const m = lines[i].match(/^title:\s*(.+)$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  }
  // 2. First H1
  for (const line of lines) {
    const m = line.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return undefined;
}

function parseFrontmatterTags(content: string): string[] | undefined {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    // tags: [a, b, c]
    const inline = lines[i].match(/^tags:\s*\[([^\]]+)\]/);
    if (inline) {
      return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
    }
    // tags:\n  - a\n  - b
    if (/^tags:\s*$/.test(lines[i])) {
      const tags: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const m = lines[j].match(/^\s+-\s+(.+)$/);
        if (!m) break;
        tags.push(m[1].trim().replace(/^["']|["']$/g, ''));
      }
      return tags;
    }
  }
  return undefined;
}
