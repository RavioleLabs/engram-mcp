# Security Policy

## Reporting a Vulnerability

If you've found a security issue in EngramMCP, please **do not** open a public
GitHub issue. Instead, email **`security@raviolelabs.com`** with:

- A description of the issue and its potential impact
- Steps to reproduce
- Your environment (OS, node version, EngramMCP version)
- (Optional) Suggested fix

We aim to acknowledge reports within 72 hours and provide a remediation
timeline within 7 days.

## Supported Versions

We patch the latest published version on npm. Older versions do not receive
security updates — please upgrade.

| Version | Supported |
|---------|-----------|
| Latest published on npm (`@raviolelabs/engram-mcp`) | ✅ |
| Older minor versions | ❌ |

## Scope

In scope:

- The `@raviolelabs/engram-mcp` package source in this repository
- The cloud-paired bridge client code (`src/cloud/`)
- Local HTTP server (`src/core/server/http.ts`, `src/core/server/mcp-http.ts`)
- Path validation, URI validation, token storage (`src/core/security/`)

Out of scope:

- Closed-source cloud workers (`engram-cloud`, the bridge relay at `api.engram-mcp.com`) — separate disclosure program, same email
- Dependency vulnerabilities — please report upstream first, but mention us if exploitation requires EngramMCP
- DoS via local-network requests when the user has explicitly enabled the HTTP server on a public interface (out of design)

## Disclosure

We follow responsible disclosure. We will credit the reporter in the release
notes for any reported issue, unless they prefer to remain anonymous. Public
disclosure happens after a fix is published.

## Encryption & Data Handling

EngramMCP is local-first. Memories live on the user's machine. Cloud-paired
features (bridge relay, multi-PC sync) handle **only encrypted blobs** —
server-side decryption is mathematically impossible (XChaCha20-Poly1305 +
Argon2id passphrase-derived keys). If you find a flaw in this assumption,
please report it — that's the most critical class of bug for us.
