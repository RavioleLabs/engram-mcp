# EngramMCP

> Local-first semantic memory layer for AI agents.

[![npm](https://img.shields.io/npm/v/@raviolelabs/engram-mcp?label=npm)](https://www.npmjs.com/package/@raviolelabs/engram-mcp)
[![License: Elastic 2.0](https://img.shields.io/badge/License-Elastic%202.0-005571.svg)](LICENSE)

EngramMCP is the memory layer your agents need — ingests from your real sources (notes, conversations, Drive, Notion, YouTube, Obsidian, audio, custom types) and exposes a standard MCP server for any agent runtime (Claude Code, Cursor, custom Anthropic/OpenAI runtimes).

**Local-first**: vectors + content live on your machine. Embeddings via Ollama by default. No cloud required for the local server.

---

## Install

### One command (recommended)

Get an invite at **[engram-mcp.com](https://engram-mcp.com)** (signup is free + open). You'll receive a personalized install command by email:

```bash
curl -fsSL https://engram-mcp.com/install/<INVITE_TOKEN> | sh
```

This `npm install`s the package, sets up Ollama (auto-installed if missing), pulls `nomic-embed-text`, writes `~/.engram/config.json`, links your account, registers a background service (LaunchAgent on macOS, systemd-user on Linux, NSSM on Windows), updates `~/.claude/mcp.json` + `~/.cursor/mcp.json`, and opens your dashboard at engram-mcp.com — all in under 60 seconds.

### Manual install (no cloud account needed)

The local server is source-available under the Elastic License 2.0 and works fully offline. Install via npm:

```bash
npm install -g @raviolelabs/engram-mcp
# or via npx (no global install):
npx -y @raviolelabs/engram-mcp --no-http
```

Then add to your agent's MCP config (`~/.claude/mcp.json` for Claude Code, similar for Cursor):

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "@raviolelabs/engram-mcp", "--no-http"]
    }
  }
}
```

Restart your agent. You're done — 29 memory tools are now available.

### Via AI agent (installer MCP server)

Your agent (Claude Code / Cursor / any MCP-aware runtime) can install EngramMCP autonomously:

```json
{
  "mcpServers": {
    "engram-installer": {
      "url": "https://installer.engram-mcp.com/mcp",
      "transport": "http"
    }
  }
}
```

Then ask: *"Install EngramMCP on this machine."* The agent calls `install_engram_mcp` and `verify_engram_installed` and runs the script.

---

## Pricing

### Engram Core — free, forever

- Local MCP server, 29 tools
- All memory types (notes, conversations, Drive, Notion, YouTube, Obsidian, audio)
- Local embeddings via Ollama (auto-installed)
- Local Whisper transcription
- Dashboard via local bridge (engram-mcp.com reads your local store via E2E-encrypted WSS)
- BYO premium embeddings (Voyage / OpenAI / OpenAI-compatible)

### Engram Pro — $9 / month

Everything in Core, plus:

- **iOS + Android capture** (voice notes, text, link sharing)
- **Multi-PC encrypted sync** (E2E — we never see your data in clear)
- **Always-online cloud dashboard** (view your memory even when your PC is off)
- **Hosted embeddings** (no Ollama needed) — 10M tokens / month included
- **Hosted Whisper** transcription — 5h audio / month included
- **Overage** opt-in at $0.05/M embedding tokens, $0.20/h Whisper. Default: auto-fallback to local Ollama when quota exhausted — no surprise bills.

### Engram Team — *coming soon*

Multi-user shared encrypted memory (teams, projects, organizations). Not on sale yet — backend ready, polishing UX.

Billing via [Polar](https://polar.sh) (Merchant of Record, handles EU VAT). Cancel anytime.

---

## Open / Closed boundary

- **Local server**: Elastic License 2.0, source-available, in this repo. Anyone can audit, fork, self-host for their own use. Offering a competing hosted/managed Engram service is prohibited. No telemetry, no phone-home for the local-only path.
- **Cloud workers** (`engram-cloud`): proprietary, source-closed. The bridge relay, hosted embeddings, billing, and multi-PC sync are paid SaaS. They handle only encrypted blobs — server-side decryption is mathematically impossible (XChaCha20-Poly1305 + Argon2id passphrase-derived keys).
- **Browser extension + Mobile apps**: distributed via Chrome Web Store, Apple App Store, Google Play. Source is closed.
- **Skill plugin** (`engram-skill`): Elastic License 2.0, source-available — separate repo, optional install for Claude Code users.

---

## Run

```bash
engram-mcp --no-http
```

Starts the MCP stdio server (consumed by your agent runtime). `--no-http` is the recommended default — no local web UI, minimal footprint.

### Official dashboard

Visit **[engram-mcp.com/dashboard](https://engram-mcp.com)** to browse your memories from any browser. Sign up free, pair your PC, and the dashboard reads your local store via the E2E-encrypted Bridge Relay.

### Local dev UI (opt-in)

```bash
engram-mcp
```

Without `--no-http`, also starts:
- Local web UI: http://localhost:7777 (dev / admin tool)
- HTTP MCP transport: http://localhost:7777/mcp

---

## Quick start for agents

EngramMCP exposes **29 agent-friendly MCP tools** with anti-loop contracts. The 10 core memory verbs:

| Tool | Purpose |
|---|---|
| `remember(content, title, tags, scope?, type?)` | Store anything worth keeping |
| `recall(query, types?, scope?, limit?)` | Semantic search across all memory |
| `get(id)` | Fetch full memory by id |
| `update(id, ...)` | Edit title/tags/sentiment |
| `forget(id)` | Delete |
| `relate(id, limit?)` | Find related memories (wikilinks + semantic) |
| `recent(limit?, types?)` | Most recent items |
| `list_types()` | Discover available memory types |
| `ingest(uri, type?)` | Auto-route a file / URL to the right module |
| `suggest_properties(id)` | Get extraction template for the LLM |

Plus 3 cross-memory inference tools (unique in the agent-memory space):
- `analyze_patterns(topic)` — synthesis across many memories
- `summarize_recent(days?)` — period digest
- `find_gaps(topic)` — what's missing from your notes

Full documentation in [SKILL.md](SKILL.md) — drop it in your agent's context for optimal usage.

---

## Architecture

```
                ┌─ stdio  ─┐
agent runtime ──┤          ├──▶ MCP server (engram-mcp)
                └─ HTTP    ─┘         │
                                      ▼
                            ┌─ ToolRouter ─┐
                            │ 29 tools     │
                            └──────┬───────┘
                                   ▼
                            ┌─ ModuleRegistry ─┐
                            │  notes, conv,    │
                            │  drive, notion,  │
                            │  youtube, audio, │
                            │  obsidian,       │
                            │  custom types    │
                            └────────┬─────────┘
                                     ▼
                              ┌─ MemoryStore ─┐
                              │  insert       │  ──▶ chunk + embed (Ollama)
                              │  recall       │  ──▶ LanceDB per-type tables
                              │  get/update   │  ──▶ SQLite + FTS5
                              │  forget       │  ──▶ ops log (sync source of truth)
                              │  relate       │
                              └────────┬──────┘
                                       │ events: memory.added/deleted/updated
                                       ▼
                                  Optional WebSocket → dashboard
```

For Pro users, ops are signed (ed25519) + encrypted (XChaCha20-Poly1305) and pushed to the cloud sync channel. The cloud holds only ciphertext + signed metadata.

---

## Tech stack

- Node.js >= 22, TypeScript 5.7 strict, ESM
- MCP SDK 1.28 (stdio + StreamableHTTP)
- LanceDB 0.27 (per-type vector tables)
- better-sqlite3 + FTS5
- Embeddings: Ollama (default), Voyage, OpenAI, OpenAI-compatible, or Engram-hosted
- Audio: nodejs-whisper (whisper.cpp) or Engram-hosted
- YouTube: watch-page scrape + yt-dlp fallback
- Zod everywhere, ULID ids

---

## Status

- ✅ **Phase 1**: local MCP server with all memory types
- ✅ **Phase 2**: mobile + cloud transit + billing + hosted Engram embeddings + multi-PC encrypted sync
- ⏳ **Phase 3**: Team workspaces — backend ready, UX polish in progress

---

## Contributing

Issues, PRs, and Discord chat welcome.

- Issues: [github.com/RavioleLabs/engram-mcp/issues](https://github.com/RavioleLabs/engram-mcp/issues)
- Discord: [discord.com/invite/rkgzfnUx](https://discord.com/invite/rkgzfnUx)
- Maintained by [RavioleLabs](https://raviolelabs.com)

---

## License

[Elastic License 2.0](LICENSE) — source-available. You may use, fork, modify, and self-host EngramMCP for your own use. You may **not** offer it as a hosted or managed service that provides users access to a substantial set of its features (this is what RavioleLabs offers as the paid cloud — the bridge relay, hosted embeddings, multi-PC sync, and dashboard at engram-mcp.com). For competing service licensing, contact `hello@raviolelabs.com`.
