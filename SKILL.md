---
name: engram-semantic-memory
description: Use EngramMCP to give yourself persistent semantic memory — write what matters with remember(), retrieve later with recall(), build connections with relate(). Works locally via 768-dim embeddings + FTS5.
---

# EngramMCP — Calling Agent Guide

> **Tool naming note:** Tool names in this doc are written WITHOUT a client prefix. Your runtime may expose them as `mcp__engram__<name>` (Claude Code) or bare `<name>` (Anthropic API, OpenAI, generic MCP client). Use whichever form your runtime exposes.

## Avoiding tool loops

The agent MUST NOT call any single tool more than 3 times in a single turn on the same input.

If a tool returns:
- **success** → done, move on
- **empty result** → the answer is genuinely 'no' or the input is wrong; do not retry with the same input
- **error** → retry once with adjusted input; if still fails, surface to user
- **'pending' (jobs)** → respect `retry_after_ms` hint, stop after `should_give_up: true` (10 polls)

### Idempotent tools (safe to call multiple times — will not create duplicates)

| Tool | Idempotency key |
|---|---|
| `remember` | content_hash + type |
| `update` | returns `{updated: false}` if no-op |
| `forget` | returns success even if already deleted |
| `watch` | returns `{already_watching: true}` if already registered |
| `create_type` | returns `{created: false}` if type already exists |

### Non-retryable tools (require user action — calling again creates orphan state)

| Tool | Reason |
|---|---|
| `connect_drive` | Starts OAuth flow — wait for user browser action |
| `connect_notion` | Starts OAuth flow — wait for user browser action |

### Cache within turn (call once, reuse result)

- `list_types` — cheap but stable within a conversation
- `list_sources` — slow on large workspaces

### If you find yourself about to call the same tool with the same args 2+ times: STOP, surface to user.

## When to use this skill

Use Engram whenever you want information to outlast the current context window.

- User shares preferences, facts, decisions, contact info, project context
- User describes their workflow, what they're building, what they care about
- User mentions documents or URLs that should be ingested for later context
- Start of every conversation: call `recent({limit: 10})` to refresh stale context
- User explicitly asks to "remember" or "save" something

## Anti-patterns

- **DON'T** `remember()` ephemeral chitchat. Memory should be high-signal.
- **DON'T** `remember()` your own outputs unless the user explicitly says "remember this".
- **DON'T** skip tags — untagged memories rarely surface in `recall`.
- **DON'T** call `recall()` with the literal user question. Extract the *topic*. "What did I say about Alice?" → `recall({query: "alice"})`.
- **DON'T** call `recall()` when you already have an id — use `get(id)`.
- **DON'T** call `get()` when searching by concept — use `recall()`.

## The 24 tools — quick reference

All tools are public — no `--admin` flag needed.

| Tool | Use when |
|---|---|
| `remember(content, title, tags, type?)` | User shares anything worth keeping. Idempotent on content_hash. |
| `recall(query, types?, limit?)` | Surface past memories on a topic. Don't retry with same query if empty. |
| `get(id)` | You already have an id and need the full record. Don't retry on not_found. |
| `update(id, ...)` | User corrects a fact or wants to retag/rename. No-op if unchanged. |
| `forget(id)` | User explicitly asks to erase something. Idempotent. |
| `relate(id, limit?)` | "What else is connected to this?" Don't retry if empty. |
| `list_types()` | First call when joining an existing Engram. Cache result for turn. |
| `recent(limit?, types?)` | Start of conversation — fetch fresh context. |
| `ingest(uri, type?)` | User mentions a file path, YouTube URL, Drive doc, etc. |
| `get_ingest_status(job_id)` | Check status of async audio/video ingest. Respect retry_after_ms. |
| `suggest_properties(id)` | A memory came in without title/tags. Call once, then update(). |
| `watch(source_type, target_id, opts?)` | Start continuous sync. Idempotent. |
| `unwatch(source_type?, target_id?, source_id?)` | Stop syncing a source (memories kept). Idempotent. |
| `list_sources(source_type?)` | See what sources are being auto-synced. Cache for turn. |
| `create_type(name, display_name?, schema?)` | Create a user-defined memory type. Idempotent on name. |
| `delete_type(name, confirm: true)` | Remove a custom type definition. Requires confirm; shows summary first. |
| `connect_drive` | Initiate Google Drive OAuth. Requires user browser action — DO NOT retry. |
| `list_drive_files(query?, limit?)` | List Drive files. Cache result per query per turn. |
| `connect_notion` | Initiate Notion OAuth. Requires user browser action — DO NOT retry. |
| `list_notion_pages(query?, limit?)` | Search Notion workspace. Cache result per query per turn. |
| `import_watch_later(playlistUrl, limit?)` | Bulk import YouTube playlist. Slow — never call twice. |
| `analyze_patterns(topic, types?, limit?, lookback_days?)` | Cross-memory pattern synthesis on a topic. Returns bundle + instruction. Idempotent. |
| `summarize_recent(days?, types?, limit?)` | Recent memory digest. Returns bundle + summarization instruction. Idempotent. |
| `find_gaps(topic, lookback_days?)` | Gap analysis on a topic. Returns bundle + gap-finding instruction. Idempotent. |

## Wikilinks

Mention related memories by `[[id]]` or `[[title]]` in your `remember` content. The system auto-extracts these as graph edges.

```
remember({
  content: "Met with [[Alice]] today about [[Project Atlas]]. She prefers async over standups.",
  title: "Alice 1:1 May 17",
  tags: ["alice", "atlas", "preferences"]
})
```

When you recall a memory that mentions Atlas, `relate({id: atlasId})` will surface Alice's 1:1 as a related node.

## Tagging strategy

Tags are how memories cluster and surface. Good tags:

- **Entities**: people (`alice`, `bob`), companies (`anthropic`), projects (`atlas`)
- **Domains**: `programming`, `finance`, `health`, `family`
- **Event types**: `decision`, `blocker`, `todo`, `idea`

Bad tags:
- Vague: `stuff`, `misc`, `thing`
- Singletons that will never recur
- Sentence fragments

Aim for 2-5 tags per memory. A memory with zero tags is retrievable only by exact semantic match — it will miss topical queries.

## Recall strategy

`recall` does **hybrid retrieval** — semantic embedding search + FTS5 keyword search, fused via Reciprocal Rank Fusion (RRF) — then layers per-type weights, recency boost, MMR diversity, and recall signals (importance/decay/pinned) on top. Tips:

- Restrict `types` if you know the type — it's significantly faster.
- Use short, topic-y queries. `"alice preferences"` not `"what does alice prefer about how we work together"`.
- Default limit 10 is enough for most lookups; bump to 20-30 for exhaustive sweeps.
- After recall, if a snippet looks relevant but incomplete, call `get(id)` for full content.

### Result fields

Each hit carries:
- `score` — raw semantic similarity (0..1). A practical "confidence" indicator.
- `match` — which path surfaced this: `"semantic"`, `"keyword"`, or `"both"`. `"both"` is the strongest signal.
- `weak` — `true` when no path returned a strong signal (semantic-only with `score < 0.3` and no keyword match). Treat these as low-confidence — they often appear when the user query has no real affinity to any stored memory.
- `snippet`, `title`, `tags`, `created_at` — usual context.

If your top hit has `weak: true` and `match: "semantic"`, treat it like "no real match" — tell the user rather than presenting it as a fact.

### `min_score` parameter

Pass `min_score: 0.3` (or similar) to drop semantic-only hits below that threshold. Keyword hits (any FTS path) are always kept because BM25 scores aren't directly comparable to cosine similarity.

## Conversation pattern

```
[user opens chat]
→ recent({limit: 10})            -- see what's fresh, prime context

[user mentions a topic]
→ recall({query: "<noun>"})      -- retrieve relevant past memories

[user shares new info]
→ remember({content, title, tags})

[user mentions a file/URL]
→ ingest({uri: "<path or url>"})

[end of conversation, milestone reached]
→ remember({                     -- optional: capture session summary
    content: "Summary: ...",
    title: "Session YYYY-MM-DD",
    tags: ["summary", "<project>"]
  })
```

## Ingest URI routing + async behavior

`ingest()` auto-routes based on the URI. No need to pick the module manually.

| URI pattern | Routed to | Sync? |
|---|---|---|
| `file://*.md`, `*.txt` | notes (read file content) | Sync |
| `file://*.mp3`, `*.wav`, `*.m4a`, `*.ogg`, `*.webm` | audio (Whisper transcription) | **Async** |
| `file://*.pdf` | notes (pdf-parse text extraction) | Sync |
| `file://*.png`, `*.jpg`, `*.gif` | images type | Sync |
| `https://www.youtube.com/watch?*`, `https://youtu.be/*` | youtube (transcript fetch) | Sync if <5min, **Async** otherwise |
| `https://docs.google.com/document/d/*` | drive | Sync |
| `https://*.notion.so/*` | notion | Sync |
| `obsidian://vault/<vault>/<path>` | obsidian | Sync |
| Any other `https://` URL | fetch + store as note | Sync |

You can override routing with `type: "audio"` etc.

### Async ingest pattern

`ingest()` returns one of two shapes:

```ts
// Fast paths (markdown, small pages, Drive, Notion) — synchronous:
{ id: "01JXY...", type: "notes", title: "My Note", status: "completed" }

// Slow paths (audio, YouTube) — async job:
{ job_id: "job_01JXY...", status: "pending", estimated_ms: 30000 }
```

For async jobs, poll `get_ingest_status(job_id)` every few seconds:

```
get_ingest_status("job_01JXY...")
// → { job_id, status: "processing", progress: 45 }
// → { job_id, status: "completed", memory_id: "01JXZ..." }
```

Once `status === "completed"`, the `memory_id` is searchable via `recall()`.

**Tip:** You can also just fire `ingest()` and move on — the job completes in the background and becomes searchable automatically. Only poll if you need the result immediately.

## Scope selection (Team workspaces)

When the user is in a Team workspace, the `remember` and `recall` tools accept an optional `scope` parameter:
- `scope: "personal"` → stored in user's personal memory (default for ambiguous content)
- `scope: "team:<id>"` → stored in shared team workspace

### Default behavior: agent decides

If the user did NOT explicitly say "share with team" or "this is personal", the agent decides based on content:

**Team-scoped signals:**
- Mentions colleagues by name (other workspace members)
- References shared projects (workspace project tags)
- Work decisions, meeting notes, internal policies
- "We decided", "the team agreed", "our X"

**Personal-scoped signals:**
- "I", "my", "me" (personal preferences, opinions, plans)
- Health, family, finance (personal-sensitive)
- Random personal ideas not work-related

**Ambiguous → ask user.** If the content could plausibly be either:
- DON'T just default. Reply "Should I add this to your personal memory or the team workspace?"
- Wait for user response before calling remember()

### Override via tags

If the agent sees `[[team:<name>]]` or `[[personal]]` wikilinks in content, treat them as explicit scope directives.

### Multi-workspace user

If user is in multiple teams, the agent must pick the RIGHT team based on content. List workspaces with `list_workspaces()` first. If unclear which team, ask user.

## Watching sources

`watch()` is now on the public surface — no `--admin` flag needed. It requires that the source is already authenticated (run `connect_drive` / `connect_notion` once via admin or the install wizard).

```ts
// Watch a YouTube channel for new videos
watch({ source_type: "youtube", target_id: "UCxxxxxx", opts: { channelName: "My Channel" } })

// Watch an Obsidian vault
watch({ source_type: "obsidian", target_id: "/path/to/vault" })

// List all watched sources
list_sources()
list_sources({ source_type: "youtube" })

// Stop watching
unwatch({ source_id: "<id from watch()>" })
```

## Custom types

```ts
// Create a new memory type
create_type({ name: "books", display_name: "Books" })

// Now use it:
remember({ content: "...", type: "books", title: "Dune", tags: ["sci-fi"] })
recall({ query: "space opera", types: ["books"] })

// Remove type schema (memories kept):
delete_type({ name: "books", confirm: true })
```

## Pattern analysis tools

For high-level synthesis beyond single recall:
- `analyze_patterns(topic, types?, limit?, lookback_days?)` — "what patterns in my notes about X?" Returns matching memories + pre-computed aggregations (tag freq, timeline, type distribution) + a structured instruction. You (the agent) then perform the actual analysis using the bundled data. DON'T re-call `recall()` — `analyze_patterns` already includes the matching memories.
- `summarize_recent(days?, types?, limit?)` — "summarize my last week". Returns recent memories + summarization instruction for a digest.
- `find_gaps(topic, lookback_days?)` — "what's missing or unanswered about X?" Returns memories on a topic + gap-analysis instruction.

All three tools are **IDEMPOTENT** on their inputs — calling twice in the same turn returns the same bundle. DO NOT re-call with the same args.

```ts
// Analyze patterns across memories on a topic
analyze_patterns({ topic: "project atlas" })
// → { topic, memories_found, date_range, memories, aggregations, instruction }
// You then synthesize the analysis from the bundled data.

// Summarize recent activity
summarize_recent({ days: 7 })
// → { period, memories_count, memories, instruction }

// Find gaps in documentation on a topic
find_gaps({ topic: "alice", lookback_days: 90 })
// → { topic, memories_found, date_range, memories, aggregations, instruction }
```

## suggest_properties workflow

For memories ingested without metadata (audio drops, Drive files named `Untitled`):

```
1. suggest_properties({id})      -- returns content + extraction instruction
2. Extract title, tags, sentiment from the returned content (you are the LLM)
3. update({id, title, tags, sentiment})
```

## Type semantics

| Type | Content |
|---|---|
| `notes` | Free-form notes, text files, web pages |
| `conversations` | Full exchanges (`"user: X\nassistant: Y"`) |
| `audio` | Whisper transcript from audio files |
| `youtube` | YouTube video transcript |
| `drive` | Google Drive documents |
| `notion` | Notion pages |
| `obsidian` | Obsidian markdown notes |
| `images` | Image metadata (no OCR yet) |
| custom | User-defined via admin `create_custom_type` — use `remember({type: "books", ...})` once created |

## Error handling

| Error | Cause | Fix |
|---|---|---|
| `not_found` from `get`/`update`/`forget` | Stale id | Re-recall to get fresh id |
| `embedding_failed` | Ollama is offline | Inform user, don't retry in a loop |
| `ingest` returns `error` key | URI routing failed or module error | Check URI format, confirm OAuth if Drive/Notion |

## OAuth tools — browser action required

`connect_drive` and `connect_notion` initiate OAuth flows. The agent CANNOT complete these autonomously — the user must open the returned `auth_url` in a browser.

**Correct flow:**
1. Agent calls `connect_drive()` → gets `{auth_url, instructions}`
2. Agent tells user: "Please open this URL in your browser: [auth_url]"
3. User completes authorization
4. User tells agent "Done" (or drive tools start working)
5. Agent verifies by calling `list_drive_files()`

The install wizard (`engram-mcp-install`) handles OAuth interactively. The dashboard at `localhost:7777` also has OAuth buttons.

**Total tool count: 24 (all public — no --admin flag needed).**
