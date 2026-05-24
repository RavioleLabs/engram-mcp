/**
 * TLS issuer pinning for connections to api.engram-mcp.com.
 *
 * Why: a corporate-MitM proxy can install a rogue root CA in the OS trust
 * store. Node's default fetch / tls trusts everything the OS trusts, so the
 * MitM cert validates successfully. Pinning the *issuer organization* on top
 * of the default validation rejects that path while staying robust against
 * Cloudflare's regular leaf-cert rotation (no fingerprint pinning here).
 *
 * Override: `ENGRAM_TLS_PIN_DISABLE=1` returns vanilla fetch / no extra check.
 * Use only when you control the proxy (corp network where you intentionally
 * intercept your own traffic) and accept the trust trade-off.
 */
import tls from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';

// Cloudflare issuers seen in production for engram-mcp.com.
// Add to this list if you see a legitimate issuer rotation in `openssl s_client`.
const PINNED_ISSUER_ORGS = [
  "Let's Encrypt",
  'Google Trust Services',
  'Google Trust Services LLC',
  'Cloudflare, Inc.',
  'Internet Security Research Group', // ISRG (Let's Encrypt root)
];

export function isPinDisabled(): boolean {
  return process.env.ENGRAM_TLS_PIN_DISABLE === '1';
}

/**
 * Returns a checkServerIdentity callback enforcing the issuer allowlist on
 * top of Node's default name + chain validation. Suitable for passing to
 * `new WebSocket(url, { checkServerIdentity })` or `tls.connect` options.
 */
export function makeCheckServerIdentity(): (
  host: string,
  cert: tls.PeerCertificate,
) => Error | undefined {
  return (host, cert) => {
    // Default checks first — name match, chain validity, expiry
    const defaultErr = tls.checkServerIdentity(host, cert);
    if (defaultErr) return defaultErr;

    if (isPinDisabled()) return undefined;

    // Walk the chain — accept any ancestor whose issuer matches the allowlist.
    type CertWithIssuer = tls.PeerCertificate & {
      issuerCertificate?: tls.PeerCertificate;
    };
    const seen = new Set<string>();
    let current: CertWithIssuer | undefined = cert as CertWithIssuer;
    while (current && !seen.has(current.fingerprint)) {
      seen.add(current.fingerprint);
      const o = current.issuer?.O ?? '';
      const cn = current.issuer?.CN ?? '';
      if (PINNED_ISSUER_ORGS.some((allowed) => o.includes(allowed) || cn.includes(allowed))) {
        return undefined;
      }
      const next: CertWithIssuer | undefined = current.issuerCertificate as
        | CertWithIssuer
        | undefined;
      if (!next || next === current) break;
      current = next;
    }

    const issuerO = cert.issuer?.O ?? '<unknown>';
    const issuerCN = cert.issuer?.CN ?? '<unknown>';
    return new Error(
      `TLS pin: rejecting unexpected issuer O="${issuerO}" CN="${issuerCN}" for ${host}. ` +
        `Set ENGRAM_TLS_PIN_DISABLE=1 to override (use only if you trust the network).`,
    );
  };
}

// Lazy-init dispatcher so `pinnedFetch` doesn't create connections in modules
// that just import the symbol.
let dispatcher: Agent | null = null;
function getDispatcher(): Agent {
  if (!dispatcher) {
    dispatcher = new Agent({
      connect: {
        // checkServerIdentity is the only undici-supported way to extend
        // TLS verification per-connection.
        checkServerIdentity: makeCheckServerIdentity(),
      },
    });
  }
  return dispatcher;
}

/**
 * fetch() variant that enforces issuer pinning on api.engram-mcp.com. Falls
 * back to the global fetch when ENGRAM_TLS_PIN_DISABLE=1. Always use this
 * for any HTTPS call to api.engram-mcp.com that transmits or receives
 * credentials (JWT, API keys, refresh tokens).
 */
export async function pinnedFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (isPinDisabled()) {
    return fetch(input, init);
  }
  // undici fetch supports the dispatcher option; cast through unknown
  // because the public Web fetch types don't carry that field.
  return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: getDispatcher(),
  }) as unknown as Response;
}
