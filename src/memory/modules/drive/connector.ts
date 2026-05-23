import { createLogger } from '../../../logger.js';
import { getValidAccessToken } from './oauth.js';
import type { EngramConfig } from '../../../config/schema.js';

const log = createLogger('drive:connector');

const EXPORTABLE: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
}

export async function getFileMetadata(
  fileId: string,
  config: EngramConfig,
): Promise<DriveFileMetadata> {
  const token = await getValidAccessToken(config);
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Drive metadata fetch failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DriveFileMetadata;
}

export async function downloadFileContent(
  fileId: string,
  mimeType: string,
  config: EngramConfig,
): Promise<string | null> {
  const token = await getValidAccessToken(config);

  let url: string;
  if (EXPORTABLE[mimeType]) {
    url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId,
    )}/export?mimeType=${encodeURIComponent(EXPORTABLE[mimeType])}`;
  } else if (mimeType.startsWith('text/')) {
    url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  } else {
    log.warn(`Drive file ${fileId} has unsupported mimeType ${mimeType} — skipping`);
    return null;
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Drive content fetch failed: ${res.status}`);
  }
  return await res.text();
}

export async function listFiles(
  config: EngramConfig,
  options: { pageToken?: string; pageSize?: number; query?: string } = {},
): Promise<{ files: DriveFileMetadata[]; nextPageToken?: string }> {
  const token = await getValidAccessToken(config);
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,size),nextPageToken');
  url.searchParams.set('pageSize', String(options.pageSize ?? 50));
  if (options.query) url.searchParams.set('q', options.query);
  if (options.pageToken) url.searchParams.set('pageToken', options.pageToken);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
  return (await res.json()) as { files: DriveFileMetadata[]; nextPageToken?: string };
}
