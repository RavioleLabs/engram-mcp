import { Client } from '@notionhq/client';
import { createLogger } from '../../../logger.js';
import { getNotionToken } from './oauth.js';

const log = createLogger('notion:connector');

const DEFAULT_DEPTH = 3;
const BLOCK_BUDGET = 500;
const CONTENT_CAP = 50_000;

interface FetchCtx {
  blocksFetched: number;
}

function client(): Client {
  return new Client({ auth: getNotionToken() });
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as { status?: number; headers?: Record<string, string> };
      if (err.status === 429) {
        const retryAfter = Number(err.headers?.['retry-after'] ?? 5);
        const waitMs = retryAfter * 1000 * Math.pow(2, attempt);
        log.warn(`[notion] 429 on ${label} — retry ${attempt + 1}/3 after ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`${label} failed after retries`);
}

export interface NotionPageMetadata {
  id: string;
  title: string;
  last_edited_time: string;
  url: string;
}

export async function getPageMetadata(pageId: string): Promise<NotionPageMetadata> {
  const c = client();
  const page = (await withRetry(() => c.pages.retrieve({ page_id: pageId }), 'pages.retrieve')) as {
    id: string;
    last_edited_time: string;
    url: string;
    properties: Record<string, { title?: Array<{ plain_text: string }>; type?: string }>;
  };
  const titleProp = Object.values(page.properties).find((p) => p.type === 'title');
  const title = titleProp?.title?.map((t) => t.plain_text).join('') ?? '(untitled)';
  return {
    id: page.id,
    title,
    last_edited_time: page.last_edited_time,
    url: page.url,
  };
}

export async function fetchPageText(pageId: string, depth = DEFAULT_DEPTH): Promise<string> {
  const c = client();
  const ctx: FetchCtx = { blocksFetched: 0 };
  return await fetchBlocks(c, pageId, depth, ctx);
}

async function fetchBlocks(
  c: Client,
  blockId: string,
  remainingDepth: number,
  ctx: FetchCtx,
): Promise<string> {
  if (remainingDepth < 0 || ctx.blocksFetched > BLOCK_BUDGET) return '';

  let cursor: string | undefined;
  const parts: string[] = [];

  do {
    const res = await withRetry(
      () =>
        c.blocks.children.list({
          block_id: blockId,
          start_cursor: cursor,
          page_size: 100,
        }),
      'blocks.children.list',
    );
    cursor = res.has_more ? (res.next_cursor as string | undefined) : undefined;

    for (const b of res.results as Array<Record<string, unknown>>) {
      ctx.blocksFetched++;
      if (ctx.blocksFetched > BLOCK_BUDGET) break;
      parts.push(blockToText(b));

      if ((b.has_children as boolean) && remainingDepth > 0) {
        parts.push(await fetchBlocks(c, b.id as string, remainingDepth - 1, ctx));
      }
    }
  } while (cursor);

  return parts.join('\n').slice(0, CONTENT_CAP);
}

function blockToText(b: Record<string, unknown>): string {
  const type = b.type as string;
  const data = b[type] as Record<string, unknown> | undefined;
  if (!data) return '';
  const richText = (data.rich_text as Array<{ plain_text: string }> | undefined) ?? [];
  const text = richText.map((rt) => rt.plain_text).join('');

  switch (type) {
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
      return `### ${text}`;
    case 'bulleted_list_item':
      return `- ${text}`;
    case 'numbered_list_item':
      return `1. ${text}`;
    case 'to_do':
      return `[${data.checked ? 'x' : ' '}] ${text}`;
    case 'paragraph':
    case 'quote':
    case 'callout':
      return text;
    case 'code': {
      const language = (data.language as string) ?? '';
      return `\`\`\`${language}\n${text}\n\`\`\``;
    }
    default:
      return text;
  }
}

export async function searchPages(query: string, limit = 25): Promise<NotionPageMetadata[]> {
  const c = client();
  const res = (await withRetry(
    () =>
      c.search({
        query,
        filter: { property: 'object', value: 'page' },
        page_size: limit,
      }),
    'search',
  )) as {
    results: Array<{
      id: string;
      last_edited_time: string;
      url: string;
      properties: Record<string, { title?: Array<{ plain_text: string }>; type?: string }>;
    }>;
  };

  return res.results.map((page) => {
    const titleProp = Object.values(page.properties).find((p) => p.type === 'title');
    return {
      id: page.id,
      title: titleProp?.title?.map((t) => t.plain_text).join('') ?? '(untitled)',
      last_edited_time: page.last_edited_time,
      url: page.url,
    };
  });
}
