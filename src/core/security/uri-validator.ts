// URI validation for ingest() — prevents SSRF + arbitrary local file reads.
//
// File:// URIs must be inside the allowlist (~/Documents, ~/Downloads, ~/Desktop,
// ~/Movies, ~/Music, and any user-configured paths). Dotfiles are always rejected.
//
// HTTP(S) URIs must resolve to a public IP — loopback, link-local, private
// RFC1918, and unique-local IPv6 are all rejected (blocks AWS IMDS, internal
// services, etc.).

import { resolve as dnsResolve } from 'node:dns/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

const DEFAULT_ALLOWED_FILE_DIRS = [
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Downloads'),
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'Movies'),
  path.join(HOME, 'Music'),
];

const BLOCKED_HOSTS = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  '0.0.0.0',
  'metadata.google.internal', // GCP IMDS
]);

export class UriValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'UriValidationError';
  }
}

export function validateFileUri(fileUri: string, extraAllowedDirs: string[] = []): string {
  if (!fileUri.startsWith('file://')) {
    throw new UriValidationError(`Not a file URI: ${fileUri}`, 'NOT_FILE_URI');
  }
  let filePath = fileUri.slice('file://'.length);
  // Strip optional host (file:///foo vs file://localhost/foo)
  if (filePath.startsWith('localhost/')) filePath = '/' + filePath.slice('localhost/'.length);
  filePath = path.resolve(filePath);

  // Reject dotfiles anywhere in the path
  const segments = filePath.split(path.sep);
  for (const seg of segments) {
    if (seg.startsWith('.') && seg !== '.' && seg !== '..') {
      throw new UriValidationError(
        `Dotfile/dotdir not allowed in ingest path: ${filePath}`,
        'DOTFILE_BLOCKED',
      );
    }
  }

  const allowed = [...DEFAULT_ALLOWED_FILE_DIRS, ...extraAllowedDirs.map((p) => path.resolve(p))];
  const isAllowed = allowed.some((dir) => filePath === dir || filePath.startsWith(dir + path.sep));

  if (!isAllowed) {
    throw new UriValidationError(
      `File path not in allowed directories. Allowed: ${allowed.join(', ')}. ` +
        `Got: ${filePath}. ` +
        `Add to config.ingest.allowedPaths to permit additional directories.`,
      'PATH_NOT_ALLOWED',
    );
  }

  return filePath;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  // 0.0.0.0/8 — broadcast / "this network"
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 100.64.0.0/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (AWS/Azure IMDS lives at 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved
  if (a >= 240) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped IPv6: ::ffff:a.b.c.d
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    if (isIP(v4) === 4) return isPrivateIPv4(v4);
  }
  return false;
}

export async function validateHttpUri(httpUri: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(httpUri);
  } catch {
    throw new UriValidationError(`Invalid URL: ${httpUri}`, 'INVALID_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UriValidationError(
      `Only http:// and https:// allowed (got ${url.protocol})`,
      'BAD_PROTOCOL',
    );
  }

  const hostname = url.hostname.toLowerCase();

  if (BLOCKED_HOSTS.has(hostname)) {
    throw new UriValidationError(`Host blocked (internal target): ${hostname}`, 'BLOCKED_HOST');
  }

  // If hostname is a literal IP, check it directly
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    if (isPrivateIPv4(hostname)) {
      throw new UriValidationError(
        `Refusing to fetch private/internal IPv4: ${hostname}`,
        'PRIVATE_IP',
      );
    }
    return url;
  }
  if (ipVersion === 6) {
    if (isPrivateIPv6(hostname)) {
      throw new UriValidationError(
        `Refusing to fetch private/internal IPv6: ${hostname}`,
        'PRIVATE_IP',
      );
    }
    return url;
  }

  // Resolve hostname → check every returned IP. Blocks DNS rebinding to
  // private targets at validate time. The fetch may still be racy if the DNS
  // changes between this call and the actual request — for hardening that we'd
  // need a custom socket dialer.
  let addresses: string[];
  try {
    const [a, aaaa] = await Promise.allSettled([
      dnsResolve(hostname, 'A'),
      dnsResolve(hostname, 'AAAA'),
    ]);
    addresses = [
      ...(a.status === 'fulfilled' ? a.value : []),
      ...(aaaa.status === 'fulfilled' ? aaaa.value : []),
    ];
  } catch (e) {
    throw new UriValidationError(
      `DNS resolution failed for ${hostname}: ${e instanceof Error ? e.message : String(e)}`,
      'DNS_FAIL',
    );
  }

  if (addresses.length === 0) {
    throw new UriValidationError(`Hostname ${hostname} did not resolve to any IP`, 'NO_IP');
  }

  for (const ip of addresses) {
    const v = isIP(ip);
    if (v === 4 && isPrivateIPv4(ip)) {
      throw new UriValidationError(
        `Hostname ${hostname} resolves to private IPv4 ${ip} — refusing to fetch`,
        'PRIVATE_IP',
      );
    }
    if (v === 6 && isPrivateIPv6(ip)) {
      throw new UriValidationError(
        `Hostname ${hostname} resolves to private IPv6 ${ip} — refusing to fetch`,
        'PRIVATE_IP',
      );
    }
  }

  return url;
}
