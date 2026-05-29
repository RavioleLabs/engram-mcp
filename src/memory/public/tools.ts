// src/memory/public/tools.ts
// Full public surface: 21 tools — all agent-callable, no admin flag needed.
// Includes OAuth-initiating tools (connect_drive, connect_notion) with agent-safe descriptions.
import { ulid } from 'ulid';
import { createHash } from 'crypto';
import { createLogger } from '../../logger.js';
import type { MCPToolDefinition } from '../core/module-interface.js';
import type { MemoryStore } from '../core/store.js';
import type { EngramConfig } from '../../config/schema.js';
import { extractWikilinks } from '../core/wikilinks.js';

const log = createLogger('public-tools');

// ── Per-type weights for OSS recall calibration ───────────────────────────────
const TYPE_WEIGHTS: Record<string, number> = {
  notes: 1.0, // user-curated, high signal
  conversations: 0.95, // recent, dialog context
  drive: 0.9, // structured documents
  notion: 0.9,
  obsidian: 0.95, // user notes, high signal
  audio: 0.8, // transcripts can be noisy
  youtube: 0.75, // longer, lower signal density
};

// Recency boost (exp decay, half-life ~180 days)
function recencyBoost(createdAtMs: number): number {
  const ageDays = (Date.now() - createdAtMs) / (1000 * 60 * 60 * 24);
  return Math.exp(-ageDays / 260); // ln(2)/180 ≈ 1/260
}

// ── Recall envelope: confidence label + hallucination guard hints ───────────
// See specs/2026-05-25-engram-remaining-problems-v0.6.1.md §R3 + the empirical
// study at specs/2026-05-25-engram-hallucination-study.md.
//
// EMPIRICAL CALIBRATION — measured on the 244-query v0.6.1 stress-test eval:
//   - top-1 `score` ALONE is nearly useless as confidence: hits mean 0.47,
//     misses mean 0.43 (huge overlap).
//   - The discriminating signals are:
//       * `match = 'both'` (FTS5 corroboration) — necessary but not sufficient
//       * `gap = top1.score − top2.score` — hits p50=0.10, misses p50=0.04
//       * `std_top5` (cluster tightness) — hits p50=0.07, misses p50=0.04
//   - Gate `match='both' AND gap≥0.18 AND std≥0.09` achieves 100% precision
//     (zero false positives) on the corpus but only fires for 8% of queries.
//   - Gate `match='both' AND gap≥0.10` achieves 79% precision at 21% recall —
//     reasonable default for "high" confidence.

interface RecallHit {
  id: string;
  type: string;
  score: number;
  match?: 'semantic' | 'keyword' | 'both';
  weak?: boolean;
  snippet: string;
  title?: string;
  tags?: string[];
  created_at: string;
}

interface RecallEnvelopeContext {
  query: string;
  totalCandidates: number;
  requestedLimit: number;
  searchedTypes: string[];
  allTypes: string[];
  /** Minimum confidence the caller is willing to surface. Anything below is dropped. */
  minConfidence: 'none' | 'low' | 'medium' | 'high';
}

// Empirical thresholds — see study at specs/2026-05-25-engram-hallucination-study.md
const HIGH_GAP_MIN = 0.1;
const HIGH_SCORE_MIN = 0.3;
const STRICT_GAP_MIN = 0.18;
const STRICT_STD_MIN = 0.09;
const LOW_SCORE_MAX = 0.25;
const VERY_LOW_SCORE_MAX = 0.15;

const CONFIDENCE_ORDER: Record<'none' | 'low' | 'medium' | 'high', number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function stdev(vals: number[]): number {
  if (vals.length < 2) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / (vals.length - 1);
  return Math.sqrt(variance);
}

/**
 * Decide a confidence label and (when risk is elevated) a one-line hint for
 * the agent. Calibrated against the v0.6.1 stress-test data:
 *
 *   high   → match='both' AND gap≥0.10 AND score≥0.30   (79% precision in study)
 *            STRICT mode (min_confidence='high') additionally requires
 *            gap≥0.18 AND std≥0.09 → 100% precision (zero hallucination)
 *   medium → match='both' OR score≥0.30                  (35% precision in study)
 *   low    → weak, or very-low score, or no FTS corroboration
 *   none   → empty result set
 *
 * If `min_confidence` is provided, results below that bar are DROPPED and
 * replaced with an empty array + a hint pointing the agent at describe_types
 * or query refinement. This is the "refuse mode" — better empty than wrong.
 */
function buildRecallEnvelope(
  results: RecallHit[],
  ctx: RecallEnvelopeContext,
): {
  results: RecallHit[];
  confidence: 'high' | 'medium' | 'low' | 'none';
  hint?: string;
  filtered?: number;
} {
  if (results.length === 0) {
    return {
      results,
      confidence: 'none',
      hint: buildEmptyHint(ctx),
    };
  }

  const top = results[0];
  const second = results[1];
  const allWeak = results.every((r) => r.weak === true);

  // Gap and cluster tightness — the two signals that actually discriminate
  // hits from confident misses in the eval data.
  const gap = second ? top.score - second.score : 1;
  const stdTop5 = stdev(results.slice(0, 5).map((r) => r.score));

  // High: dual signal (both) + meaningful gap + decent absolute score.
  // The empirical "score >= 0.5 alone" rule was wrong — that catches as many
  // misses as hits. Always require FTS corroboration for 'high'.
  const baseHigh =
    top.match === 'both' && gap >= HIGH_GAP_MIN && (top.score ?? 0) >= HIGH_SCORE_MIN;

  // STRICT high (only used when min_confidence='high'): the zero-FP rule.
  // gap ≥ 0.18 AND std_top5 ≥ 0.09 AND match='both' — empirically zero misses.
  const strictHigh = baseHigh && gap >= STRICT_GAP_MIN && stdTop5 >= STRICT_STD_MIN && !top.weak;

  const isLow =
    allWeak ||
    top.weak === true ||
    (top.match === 'semantic' && (top.score ?? 0) < LOW_SCORE_MAX) ||
    (top.score ?? 0) < VERY_LOW_SCORE_MAX;

  let confidence: 'high' | 'medium' | 'low' = baseHigh ? 'high' : isLow ? 'low' : 'medium';

  // ── min_confidence refuse mode ────────────────────────────────────────────
  // If caller demanded 'high', enforce the strict zero-FP gate. Otherwise the
  // base 'high' check is enough.
  const effectiveHigh = ctx.minConfidence === 'high' ? strictHigh : baseHigh;
  if (ctx.minConfidence === 'high' && !effectiveHigh) {
    confidence = baseHigh ? 'medium' : confidence; // demote base-high to medium
  }

  if (ctx.minConfidence !== 'none' && ctx.minConfidence !== undefined) {
    const minRank = CONFIDENCE_ORDER[ctx.minConfidence];
    const currentRank = CONFIDENCE_ORDER[confidence];
    if (currentRank < minRank) {
      // Refuse mode: drop the results entirely, return a hint instead.
      return {
        results: [],
        confidence,
        hint: buildRefuseHint(ctx, top, confidence, gap, stdTop5),
        filtered: results.length,
      };
    }
  }

  let hint: string | undefined;
  if (confidence === 'low') {
    hint = buildLowConfidenceHint(ctx, top);
  } else if (confidence === 'medium' && gap < 0.05 && results.length >= 2) {
    hint =
      `Top ${Math.min(3, results.length)} results are very close in score (Δ=${gap.toFixed(3)}, ` +
      `cluster std=${stdTop5.toFixed(3)}). Result may be ambiguous. To disambiguate: add ` +
      `distinguishing entity tokens to the query (names, dates, identifiers), or restrict with ` +
      `types=[${top.type}]. For zero-hallucination mode pass min_confidence="high".`;
  } else if (
    results.length === ctx.requestedLimit &&
    ctx.totalCandidates > ctx.requestedLimit * 3
  ) {
    hint =
      `Result limit (${ctx.requestedLimit}) reached with many more candidates available. ` +
      `If your target isn't in the list, narrow with types=[<type>], add specific tag tokens to ` +
      `the query, or bump limit (max 50).`;
  }

  const out: ReturnType<typeof buildRecallEnvelope> = { results, confidence };
  if (hint) out.hint = hint;
  return out;
}

function buildRefuseHint(
  ctx: RecallEnvelopeContext,
  top: RecallHit,
  confidence: 'high' | 'medium' | 'low',
  gap: number,
  std: number,
): string {
  const parts: string[] = [
    `Refused: top result is "${confidence}" confidence, below min_confidence="${ctx.minConfidence}".`,
  ];
  parts.push(
    `Top-1 signals: score=${(top.score ?? 0).toFixed(2)}, match=${top.match ?? 'none'}, ` +
      `gap_to_2=${gap.toFixed(3)}, cluster_std=${std.toFixed(3)}.`,
  );
  parts.push(
    `Likely cause: many similar documents — the model can't single one out. To get a high-confidence answer: ` +
      `(a) add specific entity tokens to the query (names, dates, identifiers), ` +
      `(b) call describe_types(query="${ctx.query}") and retry with types=[<top type>], ` +
      `(c) if the user's question is exploratory rather than factual, lower min_confidence to "medium" and verify manually with get(id).`,
  );
  return parts.join(' ');
}

function buildEmptyHint(ctx: RecallEnvelopeContext): string {
  const restricted = ctx.searchedTypes.length < ctx.allTypes.length;
  if (restricted) {
    return (
      `No matches in types=[${ctx.searchedTypes.join(', ')}]. ` +
      `Try (a) recall without types= to search everything, ` +
      `(b) describe_types(query="${ctx.query}") to see which types actually match this query, ` +
      `(c) recent({limit: 20}) to browse what's there.`
    );
  }
  return (
    `No matches across any type. The store may not contain anything about this topic — ` +
    `DO NOT retry recall with the same query (anti-loop). ` +
    `Try (a) a synonym / broader topic, (b) describe_types() to see what is stored and pick a likely-relevant type, ` +
    `(c) recent({limit: 20}) to browse.`
  );
}

function buildLowConfidenceHint(ctx: RecallEnvelopeContext, top: RecallHit): string {
  const parts: string[] = ['Low-confidence match — top result may not be relevant.'];

  // What signals does the top hit have? Steer the agent to the cheapest fix.
  if (top.match === 'semantic' && top.score < 0.25) {
    parts.push(
      `Top is semantic-only with weak similarity (${top.score.toFixed(2)}). ` +
        `Try adding specific entity tokens (names, project codes, dates) to hit the keyword path.`,
    );
  }

  if (ctx.searchedTypes.length === ctx.allTypes.length && ctx.allTypes.length > 1) {
    parts.push(
      `Call describe_types(query="${ctx.query}") to see which types are likely relevant, then retry with types=[<that>].`,
    );
  }

  parts.push(
    `VERIFY before citing as fact: call get(id) on the top result and check it actually answers the query.`,
  );

  return parts.join(' ');
}

export function buildPublicTools(store: MemoryStore, config: EngramConfig): MCPToolDefinition[] {
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  return [
    // ── remember ─────────────────────────────────────────────────────────────
    {
      name: 'remember',
      description: [
        'Store a memory (note, audio transcript, conversation, document, bank statement, invoice) for later semantic retrieval.',
        'INPUTS: content (required, free text). Optionally provide title (improves retrieval — 3-7 words), tags (array of strings — topics/people/projects this memory is about), type (default: auto-detected from content via registered parsers, falls back to "notes"; you can also pass any custom type), and properties (object — any extra key/value metadata).',
        'AUTO-TYPE: when type is omitted, engram scans registered parsers (bank statements, invoices, etc.) and auto-routes. The response echoes `type` and `type_auto_detected` so you can confirm.',
        'STRUCTURED CONTENT: when type matches a registered parser (e.g. "releve_bancaire"), engram parses the content into structured fields (operations, amounts, holder, period) BEFORE indexing — each row becomes its own searchable chunk. Massively improves recall on tabular content.',
        'PARSE-HINT: when type has a parser but content didn\'t match (e.g. unknown bank format), the response includes `parse_hint` — you should then extract the fields yourself (you are the LLM) and re-call remember() with properties.custom populated. See SKILL.md "Ingesting tabular content".',
        'SCOPE: use scope="personal" (default) for private memories, or scope="workspace:<id>" to store in a team workspace (get id from list_workspaces).',
        'WHEN: call after user shares anything worth remembering (preferences, facts, decisions, exchanges). Always include title + 2-5 tags so it surfaces in future recall.',
        'WIKILINKS: mention related memories by [[id]] or [[title]] in content — edges are auto-extracted.',
        'IDEMPOTENT on (content_hash, type): calling twice with identical content returns the same id with {created: false}.',
        'DO NOT retry on success — store the returned id and move on.',
        'If you get an error: retry at most once with adjusted input; if still fails, surface to user.',
        'RETURNS: { id, created, type, wikilinks_extracted, type_auto_detected?, detected_by?, parsed_by?, parse_hint? }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The memory text verbatim. Required.',
          },
          title: {
            type: 'string',
            description: '3-7 word summary — improves future recall significantly.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '2-5 lowercase keywords: people, projects, domains, event types.',
          },
          type: {
            type: 'string',
            description: 'Memory type: "notes" (default), "conversations", or any custom type.',
            default: 'notes',
          },
          scope: {
            type: 'string',
            description:
              'Visibility scope: "personal" (default, private to you) or "workspace:<id>" for a team workspace.',
            default: 'personal',
          },
          properties: {
            type: 'object',
            description:
              'Optional extra metadata: source_url, author, sentiment, action_required, custom fields.',
          },
        },
        required: ['content'],
      },
      handler: async (args) => {
        const content = args.content as string;
        const title = args.title as string | undefined;
        const tags = args.tags as string[] | undefined;
        const explicitType = args.type as string | undefined;
        const scope = (args.scope as string | undefined) ?? 'personal';
        const extraProps = (args.properties as Record<string, unknown> | undefined) ?? {};

        // SECURITY: cap content size to 1 MB. Prevents OOM from a single
        // remember() call and avoids embedding/chunking absurd inputs (each
        // embedding call is a heavy Ollama round-trip).
        const MAX_CONTENT_BYTES = 1_000_000;
        if (typeof content !== 'string') {
          throw new Error('content must be a string');
        }
        const contentBytes = Buffer.byteLength(content, 'utf-8');
        if (contentBytes > MAX_CONTENT_BYTES) {
          throw new Error(
            `content too large (${Math.round(contentBytes / 1024)} KB) — max ${
              MAX_CONTENT_BYTES / 1024
            } KB. ` + `Split into multiple remember() calls or use ingest() for large files.`,
          );
        }

        // ── Auto-detect type when not explicitly provided ───────────────────
        // If the caller didn't pass `type`, scan registered parsers' canParse()
        // and route to the matching type. This makes raw remember(content) work
        // sensibly for bank statements / invoices / other parser-known formats
        // without requiring the agent to pre-classify. See specs/2026-05-25-engram-
        // hallucination-study.md for why type routing matters for recall.
        const { detectType } = await import('../core/parsers.js');
        const detected = !explicitType ? detectType(content) : null;
        const type = explicitType ?? detected?.type ?? 'notes';

        const contentHash = createHash('sha256').update(content).digest('hex');

        // Idempotency: check for existing memory with same content_hash + type
        const { getDb } = await import('../../db/index.js');
        const db = getDb();
        const existing = db
          .prepare(`SELECT id FROM memories WHERE content_hash = ? AND type = ? LIMIT 1`)
          .get(contentHash, type) as { id: string } | undefined;
        if (existing) {
          log.debug(`remember: duplicate detected, returning existing ${existing.id}`);
          // `cached: true` is the explicit signal benches/observability should
          // filter on for real throughput numbers — `created: false +
          // reason: "duplicate"` was easy to miss (stress test §R10).
          return {
            id: existing.id,
            created: false,
            cached: true,
            reason: 'duplicate',
            wikilinks_extracted: [],
          };
        }

        const wikilinks = extractWikilinks(content);
        const now = new Date().toISOString();

        const item = {
          id: ulid(),
          type,
          scope,
          source_id: `manual:${Date.now()}`,
          content,
          content_hash: contentHash,
          properties: {
            created_at: now,
            ingested_at: now,
            title,
            tags,
            source_url: extraProps.source_url as string | undefined,
            author: extraProps.author as string | undefined,
            sentiment: extraProps.sentiment as 'positive' | 'neutral' | 'negative' | undefined,
            action_required: extraProps.action_required as boolean | undefined,
            custom: extraProps.custom as Record<string, unknown> | undefined,
          },
          wikilinks,
          related_ids: [] as string[],
          embedding_model: embeddingModel,
        };

        // Pre-insert parse-hint check: if the type has a registered parser
        // but none of them matches this content, the agent should consider
        // doing LLM-side parsing first. We compute this BEFORE insert (the
        // insert itself also applies parsing, but only emits side effects).
        const { hasParserForType, findParser } = await import('../core/parsers.js');
        const parseHint =
          hasParserForType(type) && !findParser(type, content)
            ? {
                parse_hint:
                  `Type "${type}" has a registered parser but this content didn't match. ` +
                  `For best recall, parse it yourself (you are the LLM): extract the key fields ` +
                  `(holder, dates, amounts, distinctive operations) and pass them in properties.custom ` +
                  `with structured tags. Then call remember() again. ` +
                  `See SKILL.md "Ingesting tabular content" for the pattern.`,
              }
            : {};

        await store.insert(item);
        const itemAfter = store.getById(item.id);
        const parsedBy = (itemAfter?.properties.custom as Record<string, unknown> | undefined)
          ?.parsed_by;
        log.debug(
          `remember: stored ${item.id} type=${type}${
            parsedBy ? ` parsed_by=${parsedBy as string}` : ''
          }`,
        );

        const response: Record<string, unknown> = {
          id: item.id,
          created: true,
          type, // echo back so the agent knows what type was used (esp. on auto-detect)
          wikilinks_extracted: wikilinks,
          ...(detected
            ? { type_auto_detected: detected.type, detected_by: detected.parser_id }
            : {}),
          ...(parsedBy ? { parsed_by: parsedBy } : {}),
          ...parseHint,
        };
        if (!title || !tags || tags.length === 0) {
          response.hint =
            'No title and/or tags provided. Call update() with a 3-7 word title and 2-5 tags to improve future recall.';
        }
        return response;
      },
    },

    // ── recall ────────────────────────────────────────────────────────────────
    {
      name: 'recall',
      description: [
        'Retrieve past memories by HYBRID search (semantic embedding + FTS5 keyword) fused with RRF, then reranked by tag overlap.',
        'INPUTS: query (required, short topic — NOT the full user question), optional types (array to restrict scope), optional limit (default 10, max 50), optional min_score (drop semantic-only weak matches below this threshold; default 0 = no filter).',
        'SCOPE: use scope="personal" (default) to search only personal memories, scope="workspace:<id>" for a specific team workspace, or scope="all" to search across personal + all joined workspaces.',
        'WHEN: you need to surface past information on a topic. Use recall instead of recent when you have a specific subject in mind.',
        'TIP: extract the topic noun from the user message. "what did I say about alice?" → query: "alice".',
        'ANTI-LOOP: if results is empty, the answer is genuinely "no matching memories" — DO NOT call recall again with the same query.',
        'Try a different query (synonym, broader topic, related entity) at most twice before telling the user "no matches".',
        'RETURNS: { results, confidence, hint?, filtered? }.',
        '  - results: array of { id, type, score, match, weak, snippet, title, tags, created_at }. `match` is "semantic"|"keyword"|"both"; `weak: true` means no path returned a strong signal.',
        '  - confidence: "high"|"medium"|"low"|"none" — calibrated overall trust of the top hit (do NOT trust raw `score` alone — see specs §R3).',
        '  - hint: present when confidence < high OR results were refused by min_confidence. One-line actionable suggestion (narrow with types=, add tag tokens, call describe_types) — read it before citing a result as fact.',
        '  - filtered: present when min_confidence triggered refuse mode — number of results dropped. results=[] in this case.',
        'HALLUCINATION GUARD: for factual queries where the wrong answer is unacceptable, pass min_confidence="high". Engram will return empty + hint rather than risk a confident-looking miss. Empirically zero false positives on the stress-test corpus.',
        'GUARD: if confidence is "low" or "none", VERIFY before citing: call get(top.id) and check the content actually answers the question.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Short topic string — NOT the full user question. Extract the key noun/concept.',
          },
          types: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Restrict to these memory types (default: all). Faster when type is known.',
          },
          scope: {
            type: 'string',
            description:
              '"personal" (default), "workspace:<id>", or "all" (personal + all workspaces).',
            default: 'personal',
          },
          limit: {
            type: 'number',
            default: 10,
            description: 'Max results (default 10). Use 20 for exhaustive sweeps.',
          },
          min_score: {
            type: 'number',
            default: 0,
            description:
              'Drop semantic-only results whose similarity is below this threshold. 0 = no filter (default). Set to 0.3 to suppress weak matches.',
          },
          min_confidence: {
            type: 'string',
            enum: ['none', 'low', 'medium', 'high'],
            default: 'none',
            description:
              'HALLUCINATION GUARD. When the top hit\'s calibrated confidence is below this threshold, recall returns empty results + a hint instead of risking a confident-looking wrong answer. Use "high" for factual queries where citing the wrong doc is unacceptable (empirically zero false positives but rare hits, ~8% of queries). Use "medium" for general use. "none" (default) returns everything with a confidence label.',
          },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const query = args.query as string;
        const limit = (args.limit as number) ?? 10;
        const minScore = (args.min_score as number) ?? 0;
        const minConfidence =
          (args.min_confidence as 'none' | 'low' | 'medium' | 'high' | undefined) ?? 'none';
        const types = (args.types as string[] | undefined) ?? store.listTypes();

        // Use private smart version if loaded (per-type weights + recency boost + MMR)
        if (store.algorithms.searchAll) {
          return store.algorithms.searchAll(store, query, limit, types);
        }

        // ── OSS calibrated fallback ──────────────────────────────────────────
        // store.search() now runs hybrid retrieval (semantic + FTS5 via RRF) and
        // returns per-result `match` and `weak` fields. This layer adds per-type
        // weights, recency decay, and MMR diversification on top.
        const perTypeLimit = Math.max(8, Math.ceil(limit * 1.5));
        const allResults = await Promise.all(
          types.map(async (t) => {
            try {
              const hits = await store.search(t, query, perTypeLimit);
              return hits
                .filter((h) => {
                  // min_score only applies to semantic-only weak matches; keyword
                  // hits (any FTS path) are kept regardless because BM25 score is
                  // not directly comparable to cosine similarity.
                  if (h.match === 'semantic' && h.score < minScore) return false;
                  return true;
                })
                .map((h) => ({
                  ...h,
                  // Calibrated rank = semantic_score * type_weight * recency_boost.
                  // We keep h.score (raw semantic similarity) untouched in the
                  // response so the caller has a calibrated confidence signal.
                  _rank:
                    Math.max(h.score, 0.05) *
                    (TYPE_WEIGHTS[t] ?? 0.85) *
                    recencyBoost(Date.parse(h.memory.properties.created_at)),
                }));
            } catch {
              return [];
            }
          }),
        );

        const candidates = allResults.flat().sort((a, b) => b._rank - a._rank);

        // MMR diversification — penalize results too similar to already-picked ones
        const picked: typeof candidates = [];
        const LAMBDA = 0.7; // 0=pure diversity, 1=pure relevance
        const remaining = [...candidates];

        while (picked.length < limit && remaining.length > 0) {
          let bestIdx = 0;
          let bestMmr = -Infinity;

          for (let i = 0; i < remaining.length; i++) {
            const cand = remaining[i];
            let maxSim = 0;
            for (const p of picked) {
              if (cand.memory.source_id === p.memory.source_id) {
                maxSim = Math.max(maxSim, 0.6);
              }
              const candTags = cand.memory.properties.tags ?? [];
              const pTags = p.memory.properties.tags ?? [];
              const sharedTags = candTags.filter((t) => pTags.includes(t)).length;
              const minTags = Math.min(candTags.length, pTags.length) || 1;
              maxSim = Math.max(maxSim, (sharedTags / minTags) * 0.5);
            }
            const mmr = LAMBDA * cand._rank - (1 - LAMBDA) * maxSim;
            if (mmr > bestMmr) {
              bestMmr = mmr;
              bestIdx = i;
            }
          }

          picked.push(remaining[bestIdx]);
          remaining.splice(bestIdx, 1);
        }

        const final = picked.slice(0, limit);
        const results = final.map((h) => ({
          id: h.memory.id,
          type: h.memory.type,
          score: h.score,
          match: h.match,
          weak: h.weak,
          snippet: h.snippet,
          title: h.memory.properties.title,
          tags: h.memory.properties.tags,
          created_at: h.memory.properties.created_at,
        }));

        // ── Hallucination guard: confidence label + actionable hint ──────────
        // The v0.6.1 stress test (§R3) showed scores overlap heavily between
        // real hits and confident misses (a wrong doc can come back at 0.65;
        // a real hit can come back at 0.06). The agent has no reliable way to
        // tell whether to trust the result. This envelope gives a structured
        // hint when the result set looks risky — the agent can then retry with
        // narrower scope (types, tag tokens in the query) before citing as fact.
        const envelope = buildRecallEnvelope(results, {
          query,
          totalCandidates: candidates.length,
          requestedLimit: limit,
          searchedTypes: types,
          allTypes: store.listTypes(),
          minConfidence,
        });
        return envelope;
      },
    },

    // ── get ───────────────────────────────────────────────────────────────────
    {
      name: 'get',
      description: [
        'Fetch a single memory by id, returning full content + all properties.',
        'WHEN: you already have an id (from recall or relate) and need the complete record.',
        'Use recall instead of get when you are searching by topic.',
        'ANTI-LOOP: returns {error: "not_found"} if id does not exist — DO NOT retry.',
        'The memory was deleted or the id was wrong. Call recall to find an alternative.',
        'RETURNS: full MemoryItem or { error: "not_found" }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Memory id (ULID).' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const item = store.getById(args.id as string);
        if (!item) return { error: 'not_found' };
        return item;
      },
    },

    // ── update ────────────────────────────────────────────────────────────────
    {
      name: 'update',
      description: [
        'Edit metadata of an existing memory: title, tags, sentiment, action_required, or custom fields.',
        'WHEN: user corrects a fact, retags, or you want to enrich an ingested memory after suggest_properties.',
        'Only fields you pass are changed — other fields are untouched.',
        'IDEMPOTENT: if the patch equals existing values, returns {updated: false} — no DB write.',
        'If {updated: false}: the patch was redundant — DO NOT retry.',
        'RETURNS: { updated: true|false, id } or { error: "not_found" }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Memory id to update.' },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
          action_required: { type: 'boolean' },
          custom: { type: 'object', description: 'Merged into existing custom properties.' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const id = args.id as string;
        const existing = store.getById(id);
        if (!existing) return { error: 'not_found' };

        const patch = {
          title: args.title as string | undefined,
          tags: args.tags as string[] | undefined,
          sentiment: args.sentiment as 'positive' | 'neutral' | 'negative' | undefined,
          action_required: args.action_required as boolean | undefined,
          custom: args.custom as Record<string, unknown> | undefined,
        };
        // Strip undefined keys so we don't clobber existing values
        const clean = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        ) as Record<string, unknown>;

        // No-op diff: if all provided fields equal existing, skip the write
        const isNoOp = Object.entries(clean).every(([k, v]) => {
          const existingVal = (existing.properties as Record<string, unknown>)[k];
          return JSON.stringify(existingVal) === JSON.stringify(v);
        });
        if (isNoOp) return { updated: false, id };

        const ok = store.setProperties(id, clean);
        if (!ok) return { error: 'not_found' };
        return { updated: true, id };
      },
    },

    // ── forget ────────────────────────────────────────────────────────────────
    {
      name: 'forget',
      description: [
        'Delete a memory by id. Removes from SQLite, FTS5, and vector index.',
        'WHEN: user explicitly asks to forget something. Prefer update to just untag/retitle.',
        'IDEMPOTENT: returns {deleted: id} even if the id never existed — DO NOT retry.',
        'Calling again on the same id is a no-op.',
        'RETURNS: { deleted: id }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Memory id to delete.' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        await store.delete(args.id as string);
        return { deleted: args.id };
      },
    },

    // ── relate ────────────────────────────────────────────────────────────────
    {
      name: 'relate',
      description: [
        'Find memories related to a given memory by id, using wikilinks + semantic similarity.',
        'WHEN: "what else is connected to this?", building a memory graph, or exploring a topic cluster.',
        'Use recall instead of relate when starting from a query string.',
        'ANTI-LOOP: if returns empty, this memory has no semantic neighbors above the threshold — DO NOT retry.',
        "Try recall with the memory's tags instead.",
        'RETURNS: array of { id, type, score, snippet, title }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Memory id to find related memories for.' },
          limit: { type: 'number', default: 10 },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const hits = await store.findRelated(args.id as string, (args.limit as number) ?? 10);
        return hits.map((h) => ({
          id: h.memory.id,
          type: h.memory.type,
          score: h.score,
          snippet: h.snippet,
          title: h.memory.properties.title,
        }));
      },
    },

    // ── list_types ────────────────────────────────────────────────────────────
    {
      name: 'list_types',
      description: [
        'List all memory types that currently have at least one item.',
        'WHEN: first call when joining an existing Engram instance to discover what is stored.',
        'Also useful before a recall to decide whether to restrict types.',
        'CACHE: this is a cheap call but cache the result for the duration of the conversation — DO NOT call repeatedly in the same turn.',
        'RETURNS: { types: string[] }.',
        'TIP: for rich per-type metadata (counts, top tags, last activity) use describe_types instead.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        return { types: store.listTypes() };
      },
    },

    // ── describe_types ────────────────────────────────────────────────────────
    {
      name: 'describe_types',
      description: [
        'List memory types WITH rich metadata: count, top tags, last activity, and (if query given) keyword-match counts.',
        'INPUTS: optional query (free text) — when provided, each type also reports how many memories match via FTS5, ordered by match count.',
        'WHEN: before recall on an unfamiliar Engram instance, or when recall returned a hint asking to narrow. The output tells you which types are worth restricting to.',
        'CACHE: re-call once per conversation turn at most — it scans all rows per type.',
        'RETURNS: { types: Array<{ name, count, top_tags: string[], last_activity_at, query_matches? }> }. Sorted by query_matches desc when query is given, else by count desc.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Optional. If provided, also returns FTS5-match count per type so you can pick the most relevant scope to recall against.',
          },
        },
      },
      handler: async (args) => {
        const { getDb } = await import('../../db/index.js');
        const { buildFtsMatch } = await import('../core/fts.js');
        const db = getDb();
        const query = args.query as string | undefined;
        const ftsMatch = query ? buildFtsMatch(query) : null;

        const typeRows = db
          .prepare(
            `SELECT type, COUNT(*) AS count, MAX(created_at) AS last_activity
             FROM memories
             GROUP BY type`,
          )
          .all() as Array<{ type: string; count: number; last_activity: number }>;

        const tagFreqStmt = db.prepare(
          `SELECT properties_json FROM memories WHERE type = ? LIMIT 500`,
        );

        const out = typeRows.map((row) => {
          // Top tags: count tag frequency across (up to) the latest 500 rows of this type.
          // 500 is a soft cap to keep this O(n) for big tables; the top tags converge fast.
          const tagCounts = new Map<string, number>();
          const sample = tagFreqStmt.all(row.type) as Array<{ properties_json: string }>;
          for (const r of sample) {
            try {
              const props = JSON.parse(r.properties_json) as { tags?: string[] };
              for (const tag of props.tags ?? []) {
                tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
              }
            } catch {
              // skip malformed rows
            }
          }
          const top_tags = [...tagCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([tag]) => tag);

          let query_matches: number | undefined;
          if (ftsMatch) {
            try {
              const r = db
                .prepare(
                  `SELECT COUNT(*) AS n
                   FROM memories_fts
                   JOIN memories m ON m.id = memories_fts.id
                   WHERE memories_fts MATCH ? AND m.type = ?`,
                )
                .get(ftsMatch, row.type) as { n: number };
              query_matches = r.n;
            } catch {
              query_matches = 0;
            }
          }

          return {
            name: row.type,
            count: row.count,
            top_tags,
            last_activity_at:
              row.last_activity > 0 ? new Date(row.last_activity).toISOString() : null,
            ...(query_matches !== undefined ? { query_matches } : {}),
          };
        });

        // Sort: by query_matches desc when query given (zero-match types last);
        // else by count desc.
        out.sort((a, b) => {
          if (query) {
            return (b.query_matches ?? 0) - (a.query_matches ?? 0) || b.count - a.count;
          }
          return b.count - a.count;
        });

        return { types: out };
      },
    },

    // ── recent ────────────────────────────────────────────────────────────────
    {
      name: 'recent',
      description: [
        'Return the most recently created memories, sorted by created_at desc.',
        'SCOPE: use scope="personal" (default) for private memories, scope="workspace:<id>" for team memories, or scope="all" for all scopes.',
        'WHEN: start of a conversation — call recent({limit: 10}) to refresh context before answering.',
        'Use recall instead of recent when you have a specific topic in mind.',
        'ANTI-LOOP: returns at most limit items (default 20). If fewer returned, the store has fewer memories — DO NOT call again with a larger limit hoping for more.',
        'RETURNS: array of { id, type, title, tags, snippet, created_at, scope }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            default: 20,
            description: 'Max results (default 20).',
          },
          types: {
            type: 'array',
            items: { type: 'string' },
            description: 'Restrict to these memory types (optional).',
          },
          scope: {
            type: 'string',
            description:
              '"personal" (default), "workspace:<id>", or "all" (personal + all workspaces).',
            default: 'personal',
          },
        },
      },
      handler: async (args) => {
        const limit = (args.limit as number) ?? 20;
        const types = args.types as string[] | undefined;
        const scope = (args.scope as string | undefined) ?? 'personal';
        const { getDb } = await import('../../db/index.js');
        const db = getDb();

        const conditions: string[] = [];
        const params: unknown[] = [];

        if (types && types.length > 0) {
          conditions.push(`type IN (${types.map(() => '?').join(',')})`);
          params.push(...types);
        }

        if (scope !== 'all') {
          conditions.push('scope = ?');
          params.push(scope);
        }

        let sql = `SELECT id, type, content, properties_json, created_at, scope FROM memories`;
        if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);

        const rows = db.prepare(sql).all(...params) as Array<{
          id: string;
          type: string;
          content: string;
          properties_json: string;
          created_at: number;
          scope: string;
        }>;

        return rows.map((r) => {
          const props = JSON.parse(r.properties_json) as Record<string, unknown>;
          return {
            id: r.id,
            type: r.type,
            scope: r.scope ?? 'personal',
            title: props.title,
            tags: props.tags,
            snippet: r.content.slice(0, 200),
            created_at: new Date(r.created_at).toISOString(),
          };
        });
      },
    },

    // ── ingest ────────────────────────────────────────────────────────────────
    {
      name: 'ingest',
      description: [
        'Auto-route a URI to the right ingestion module and store the result.',
        'WHEN: user mentions a file path, YouTube URL, Google Drive doc, Notion page, or Obsidian vault.',
        'URI schemes handled:',
        '• file://*.md|.txt — reads as note (synchronous).',
        '• file://*.mp3|.wav|.m4a|.ogg|.webm — Whisper transcription (ASYNC — returns job_id).',
        '• file://*.pdf — full text extraction via pdf-parse (synchronous; encrypted/corrupted PDFs get error message as content + tag pdf_extraction_failed).',
        '• file://*.png|.jpg|.jpeg|.gif — stores as "images" type.',
        '• https://www.youtube.com/watch?*|https://youtu.be/* — YouTube transcript (sync if <5 min via oEmbed probe, ASYNC otherwise).',
        '• https://docs.google.com/document/d/* — Google Drive.',
        '• https://*.notion.so/* — Notion page.',
        '• obsidian://vault/<vault>/<path> — Obsidian vault.',
        'Override routing with explicit type param.',
        'IDEMPOTENT on (uri, content_hash): same URI returns same job_id or memory_id — DO NOT retry on conflict.',
        'RETURNS: { id, type, title, status: "completed" } for fast paths, or { job_id, status: "pending", estimated_ms } for slow paths (audio, large videos).',
        'For pending jobs, call get_ingest_status(job_id) to check progress. Completed jobs are automatically searchable via recall().',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          uri: {
            type: 'string',
            description: 'File path (absolute) or URL to ingest.',
          },
          type: {
            type: 'string',
            description: 'Force a specific memory type (overrides auto-routing).',
          },
          title: {
            type: 'string',
            description: 'Override the auto-detected title.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags to attach to the ingested memory.',
          },
        },
        required: ['uri'],
      },
      handler: async (args) => {
        const uri = args.uri as string;
        const forceType = args.type as string | undefined;
        const titleOverride = args.title as string | undefined;
        const tagsOverride = args.tags as string[] | undefined;

        const normalUri = normalizeUri(uri);

        // YouTube fast-path heuristic: probe duration, sync if <5 min
        const isYoutubeUri =
          normalUri.startsWith('https://www.youtube.com/watch') ||
          normalUri.startsWith('https://youtu.be/');
        if ((isYoutubeUri || forceType === 'youtube') && !forceType?.startsWith('audio')) {
          const videoIdMatch = normalUri.match(/(?:[?&]v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
          if (videoIdMatch) {
            const duration = await probeYoutubeDuration(videoIdMatch[1]);
            if (duration !== null && duration < 300) {
              // Short video (<5 min) — sync path
              try {
                const result = await routeIngest(
                  uri,
                  forceType,
                  titleOverride,
                  tagsOverride,
                  store,
                  config,
                );
                return { ...result, status: 'completed', fast_path: true };
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                log.warn(`ingest (sync youtube) failed for ${uri}: ${msg}`);
                return { error: msg };
              }
            }
          }
          // Probe failed or video >= 5 min — fall through to async
          return handleAsyncIngest(uri, forceType, titleOverride, tagsOverride, store, config);
        }

        // Detect other heavy operations that need async processing
        if (isHeavyOp(normalUri, forceType)) {
          return handleAsyncIngest(uri, forceType, titleOverride, tagsOverride, store, config);
        }

        try {
          const result = await routeIngest(
            uri,
            forceType,
            titleOverride,
            tagsOverride,
            store,
            config,
          );
          return { ...result, status: 'completed' };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.warn(`ingest failed for ${uri}: ${msg}`);
          return { error: msg };
        }
      },
    },

    // ── get_ingest_status ─────────────────────────────────────────────────────
    {
      name: 'get_ingest_status',
      description: [
        'Check the status of an async ingest job (audio files, large YouTube videos).',
        'WHEN: ingest() returned { job_id, status: "pending" }. Poll only after waiting retry_after_ms.',
        'ANTI-LOOP: if status is "pending" or "processing", wait AT LEAST retry_after_ms (starts at 1s, doubles each poll, caps at 10s) before calling again.',
        'If should_give_up is true (poll_count >= 10): stop polling, surface to user — DO NOT poll indefinitely.',
        'RETURNS: { job_id, status, memory_id?, error?, progress, retry_after_ms, should_give_up }.',
        'Once status is "completed", the memory_id is searchable via recall().',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Job id returned by ingest().' },
        },
        required: ['job_id'],
      },
      handler: async (args) => {
        const { getJob, computeRetryHint } = await import('../../ingest/jobs.js');
        const job = getJob(args.job_id as string);
        if (!job) return { error: 'job_not_found' };
        const { retry_after_ms, should_give_up } = computeRetryHint(job.poll_count);
        return {
          job_id: job.id,
          status: job.status,
          progress: job.progress,
          memory_id: job.memory_id ?? undefined,
          error: job.error ?? undefined,
          retry_after_ms,
          should_give_up,
        };
      },
    },

    // ── suggest_properties ────────────────────────────────────────────────────
    {
      name: 'suggest_properties',
      description: [
        'Return the full content of a memory plus a structured instruction for you (the calling LLM) to extract title/tags/sentiment/action_required.',
        'WHEN: a memory was ingested without metadata (audio drop, Drive file ingested by filename only). Call this, extract fields from the content, then call update().',
        'Flow: suggest_properties(id) → extract metadata from returned content → update(id, title, tags).',
        'ANTI-LOOP: DO NOT call suggest_properties twice on the same id without calling update() in between.',
        'RETURNS: { memory_id, type, content, current_properties, instruction }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Memory id whose properties to enrich.' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const id = args.id as string;
        const item = store.getById(id);
        if (!item) return { error: 'not_found' };

        const currentProps = {
          title: item.properties.title ?? null,
          tags: item.properties.tags ?? [],
          sentiment: item.properties.sentiment ?? null,
          action_required: item.properties.action_required ?? null,
        };

        const instruction = store.prompts.suggestPropertiesInstruction
          ? store.prompts.suggestPropertiesInstruction(id, item.content, currentProps)
          : [
              `Read the content below and extract metadata. Then call update() with id="${id}" and the fields you extract.`,
              'Required: title (3-7 word summary), tags (2-5 lowercase keywords: people, projects, topics).',
              'Optional: sentiment ("positive"|"neutral"|"negative"), action_required (true if there is an open task).',
              'Only set fields that are currently null/empty.',
            ].join('\n');

        return {
          memory_id: id,
          type: item.type,
          content: item.content,
          current_properties: currentProps,
          instruction,
        };
      },
    },

    // ── watch ─────────────────────────────────────────────────────────────────
    {
      name: 'watch',
      description: [
        'Start watching a remote source for new content. Newly created/updated items are automatically ingested into memory.',
        'Supports Drive files (auto-ingest on change), Notion pages, YouTube channels (auto-ingest new uploads), and Obsidian vaults (fs.watch).',
        'REQUIRES the source to be connected first (use connect_drive / connect_notion if not yet authenticated — they require user browser action).',
        'WHEN: user wants to continuously sync a Drive doc, Notion page, YouTube channel, or Obsidian vault.',
        'IDEMPOTENT: calling twice on same target_id returns the existing watch with {already_watching: true} — DO NOT retry.',
        'RETURNS: { watched: true, source_id, display_name } or { watched: true, already_watching: true, source_id }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          source_type: {
            type: 'string',
            enum: ['drive', 'notion', 'youtube', 'obsidian'],
            description: 'Type of source to watch.',
          },
          target_id: {
            type: 'string',
            description:
              'For drive: file/folder id. For notion: page/database id. For youtube: channel handle or ID (UCxxx). For obsidian: absolute vault path.',
          },
          opts: {
            type: 'object',
            description:
              'Module-specific options (e.g. { recursive: true } for obsidian, { channelName: "My Channel" } for youtube).',
          },
        },
        required: ['source_type', 'target_id'],
      },
      handler: async (args) => {
        const sourceType = args.source_type as 'drive' | 'notion' | 'youtube' | 'obsidian';
        const targetId = args.target_id as string;
        const opts = (args.opts as Record<string, unknown> | undefined) ?? {};

        const { sourceRegistry } = await import('../core/source-registry.js');

        switch (sourceType) {
          case 'drive': {
            const { getFileMetadata, downloadFileContent } = await import(
              '../modules/drive/connector.js'
            );
            const { buildDriveItem } = await import('../modules/drive/ingest.js');
            const meta = await getFileMetadata(targetId, config);
            const { id: sourceId, alreadyExists: driveAlreadyExists } =
              sourceRegistry.addWithStatus({
                module_id: 'drive',
                external_id: targetId,
                display_name: meta.name,
                config: { mimeType: meta.mimeType },
              });
            if (driveAlreadyExists) {
              return {
                watched: true,
                already_watching: true,
                source_id: sourceId,
                display_name: meta.name,
              };
            }
            const content = await downloadFileContent(targetId, meta.mimeType, config);
            if (content) {
              const item = buildDriveItem({ metadata: meta, content, embeddingModel });
              await store.insert(item);
              sourceRegistry.recordSync(sourceId, meta.modifiedTime);
            }
            return { watched: true, source_id: sourceId, display_name: meta.name };
          }

          case 'notion': {
            const { getPageMetadata, fetchPageText } = await import(
              '../modules/notion/connector.js'
            );
            const { buildNotionItem } = await import('../modules/notion/ingest.js');
            const meta = await getPageMetadata(targetId);
            const { id: sourceId, alreadyExists: notionAlreadyExists } =
              sourceRegistry.addWithStatus({
                module_id: 'notion',
                external_id: meta.id,
                display_name: meta.title,
              });
            if (notionAlreadyExists) {
              return {
                watched: true,
                already_watching: true,
                source_id: sourceId,
                display_name: meta.title,
              };
            }
            const content = await fetchPageText(meta.id);
            const item = buildNotionItem({ metadata: meta, content, embeddingModel });
            await store.insert(item);
            sourceRegistry.recordSync(sourceId, meta.last_edited_time);
            return { watched: true, source_id: sourceId, display_name: meta.title };
          }

          case 'youtube': {
            const { resolveChannelId } = await import('../modules/youtube/watcher.js');
            const channelId = await resolveChannelId(targetId);
            const channelName = (opts.channelName as string | undefined) ?? channelId;
            const { id: sourceId, alreadyExists: ytAlreadyExists } = sourceRegistry.addWithStatus({
              module_id: 'youtube',
              external_id: channelId,
              display_name: channelName,
              config: { channelId, channelName },
            });
            if (ytAlreadyExists) {
              const existingSource = sourceRegistry.get(sourceId);
              return {
                watched: true,
                already_watching: true,
                source_id: sourceId,
                display_name: existingSource?.display_name ?? channelName,
              };
            }
            return { watched: true, source_id: sourceId, display_name: channelName };
          }

          case 'obsidian': {
            const path = await import('path');
            const { readVault } = await import('../modules/obsidian/vault-reader.js');
            const { buildObsidianItem } = await import('../modules/obsidian/ingest.js');
            const vaultPath = path.default.resolve(targetId);
            const { id: sourceId, alreadyExists: obsidianAlreadyExists } =
              sourceRegistry.addWithStatus({
                module_id: 'obsidian',
                external_id: vaultPath,
                display_name: path.default.basename(vaultPath),
                config: { vault_path: vaultPath },
              });
            if (obsidianAlreadyExists) {
              return {
                watched: true,
                already_watching: true,
                source_id: sourceId,
                display_name: path.default.basename(vaultPath),
              };
            }
            const files = await readVault(vaultPath);
            for (const file of files) {
              const item = buildObsidianItem({ file, vaultRoot: vaultPath, embeddingModel });
              await store.deleteBySourceId(item.source_id);
              await store.insert(item);
            }
            sourceRegistry.recordSync(sourceId, new Date().toISOString());
            return {
              watched: true,
              source_id: sourceId,
              display_name: path.default.basename(vaultPath),
              files_indexed: files.length,
            };
          }

          default:
            throw new Error(`Unknown source_type: ${sourceType as string}`);
        }
      },
    },

    // ── unwatch ───────────────────────────────────────────────────────────────
    {
      name: 'unwatch',
      description: [
        'Stop watching a source (Drive, Notion, YouTube, Obsidian). Memories already ingested are kept.',
        'WHEN: user wants to stop auto-syncing a source.',
        'IDEMPOTENT: returns success even if the source was not being watched — DO NOT retry.',
        'RETURNS: { removed: true, source_id } or { error: "not_found" }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          source_type: {
            type: 'string',
            enum: ['drive', 'notion', 'youtube', 'obsidian'],
            description:
              'Type of source (used to look up the right entry if source_id not provided).',
          },
          target_id: {
            type: 'string',
            description:
              'The original target_id passed to watch() (file id, page id, channel id, or vault path). Alternatively, pass source_id directly.',
          },
          source_id: {
            type: 'string',
            description:
              'The source_id returned by watch(). If provided, source_type and target_id are ignored.',
          },
        },
      },
      handler: async (args) => {
        const { sourceRegistry } = await import('../core/source-registry.js');
        const sourceId = args.source_id as string | undefined;

        if (sourceId) {
          const found = sourceRegistry.get(sourceId);
          if (!found) {
            // Idempotent: already removed is still success
            return { removed: true, already_removed: true, source_id: sourceId };
          }
          sourceRegistry.remove(sourceId);
          return { removed: true, source_id: sourceId };
        }

        const sourceType = args.source_type as string | undefined;
        const targetId = args.target_id as string | undefined;
        if (!sourceType || !targetId) {
          return { error: 'Provide either source_id or both source_type + target_id' };
        }

        const sources = sourceRegistry.list(sourceType);
        const found = sources.find((s) => s.external_id === targetId);
        if (!found) {
          // Idempotent: not watching this target is still success
          return { removed: true, already_removed: true, source_id: targetId };
        }
        sourceRegistry.remove(found.id);
        return { removed: true, source_id: found.id };
      },
    },

    // ── list_sources ──────────────────────────────────────────────────────────
    {
      name: 'list_sources',
      description: [
        'List all watched sources (Drive files, Notion pages, YouTube channels, Obsidian vaults) with sync status.',
        'WHEN: checking what is being auto-synced, or to find a source_id for unwatch().',
        'CACHE: DO NOT call repeatedly in the same turn — cache the result yourself.',
        'RETURNS: array of { id, module_id, external_id, display_name, last_synced_at, enabled }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          source_type: {
            type: 'string',
            enum: ['drive', 'notion', 'youtube', 'obsidian'],
            description: 'Filter by source type (optional — omit to list all).',
          },
        },
      },
      handler: async (args) => {
        const { sourceRegistry } = await import('../core/source-registry.js');
        const sourceType = args.source_type as string | undefined;
        return sourceRegistry.list(sourceType);
      },
    },

    // ── create_type ───────────────────────────────────────────────────────────
    {
      name: 'create_type',
      description: [
        'Create a user-defined memory type at runtime. Types are just rows in custom_types — no dynamic tools are registered.',
        'Once created, use remember({ type: "<name>", ... }) to store items of that type.',
        'Use recall({ types: ["<name>"] }) to search within the type.',
        'WHEN: user wants to track a custom category (books, recipes, contacts, etc.).',
        'IDEMPOTENT on (name): if the type already exists, returns {created: false, existed: true} — this is SUCCESS, the type is usable. DO NOT retry.',
        'NOTE: remember({ type: "<name>", ... }) will also auto-create the type if it does not exist yet. Calling create_type first is OPTIONAL — useful when you want to register the type before any data lands.',
        'RETURNS: { type_name, created: true|false, existed: true|false }. created=true means we just created it; existed=true means it was already there. Treat both as success.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'lowercase snake_case name (e.g. "books", "recipes"). Max 31 chars.',
          },
          display_name: {
            type: 'string',
            description: 'Human-readable name (e.g. "Books").',
          },
          schema: {
            type: 'object',
            description: 'Optional JSON Schema for custom properties.',
          },
        },
        required: ['name'],
      },
      handler: async (args) => {
        const { createCustomType, listCustomTypes } = await import(
          '../modules/_custom/persistence.js'
        );
        const { createGenericModule } = await import('../modules/_custom/generic-module.js');
        const { moduleRegistry } = await import('../core/module-registry.js');

        const typeName = args.name as string;
        const displayName = (args.display_name as string | undefined) ?? typeName;

        // Idempotency: check if type already exists. Returns `existed: true`
        // in addition to `created: false` so callers can tell "no-op because
        // already there" from "no-op because of an error". Pre-existing
        // ambiguity flagged in the 2026-05-27 stress test §R9.
        const existing = listCustomTypes().find((t) => t.type_name === typeName);
        if (existing) {
          return { type_name: existing.type_name, created: false, existed: true };
        }

        const def = createCustomType({
          type_name: typeName,
          display_name: displayName,
          schema: args.schema as object | undefined,
        });
        const mod = createGenericModule(def, config);
        moduleRegistry.register(mod);
        await mod.onBoot({ store });

        log.info(`Created custom type ${def.type_name}`);
        return { type_name: def.type_name, created: true, existed: false };
      },
    },

    // ── connect_drive ─────────────────────────────────────────────────────────
    {
      name: 'connect_drive',
      description: [
        'Initiate Google Drive OAuth. RETURNS {auth_url, instructions}.',
        'The user must open auth_url in a browser and complete the authorization.',
        'NON-RETRYABLE: DO NOT call this tool again until the user confirms completion in conversation.',
        'Calling it repeatedly creates orphan OAuth states.',
        'After user confirms, drive ingestion is available — verify with list_drive_files or use ingest(drive_url) / watch({source_type: "drive"}).',
        'If Drive is already connected, returns {already_connected: true} — do not call again.',
        'RETURNS: {already_connected: true} or {auth_url, connected: true} or {auth_url, timeout: true} (user did not authorize in 5 min).',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { startDriveOAuthFlow, isDriveConnected } = await import('../modules/drive/oauth.js');
        if (isDriveConnected()) return { already_connected: true };
        if (!config.drive) {
          return {
            error: 'drive_not_configured',
            message: 'Google Drive OAuth credentials are not configured.',
            hint: 'Run `engram-mcp-setup-drive` (or `npm run setup:drive` from source) for an interactive wizard. Manual setup: get OAuth credentials at https://console.cloud.google.com/apis/credentials, then set drive.clientId and drive.clientSecret in ~/.engram/config.json.',
          };
        }
        try {
          const flow = await startDriveOAuthFlow(config);
          const result = await Promise.race([
            flow.waitForCallback.then(() => ({ connected: true })),
            new Promise<{ timeout: boolean }>((resolve) =>
              setTimeout(() => resolve({ timeout: true }), 300_000),
            ),
          ]);
          return {
            auth_url: flow.authUrl,
            instructions: 'Open auth_url in your browser and authorize. Then confirm here.',
            ...result,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            error: 'drive_not_configured',
            message: msg,
            hint: 'Run `engram-mcp-setup-drive` (or `npm run setup:drive` from source) for an interactive wizard. Manual setup: get OAuth credentials at https://console.cloud.google.com/apis/credentials, then set drive.clientId and drive.clientSecret in ~/.engram/config.json.',
          };
        }
      },
    },

    // ── list_drive_files ──────────────────────────────────────────────────────
    {
      name: 'list_drive_files',
      description: [
        'List recent Google Drive files visible to the connected account.',
        'Requires Drive to be connected first (use connect_drive if not).',
        'Default returns up to 100 files. Use folder_id or query to narrow.',
        'PAGINATION: DO NOT call multiple times for the same folder in one turn — cache the result yourself.',
        'Prefer ingest(drive_url) or watch({source_type: "drive", target_id}) for specific files.',
        'RETURNS: array of { id, name, mimeType, modifiedTime }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Google Drive search query (e.g. "name contains \'report\'".',
          },
          limit: {
            type: 'number',
            default: 25,
            description: 'Max files to return (default 25, max 100).',
          },
        },
      },
      handler: async (args) => {
        const { isDriveConnected } = await import('../modules/drive/oauth.js');
        if (!isDriveConnected()) {
          return {
            error: 'drive_not_connected',
            message: 'Google Drive is not connected.',
            hint: 'Call connect_drive first to authenticate with Google Drive.',
          };
        }
        const { listFiles } = await import('../modules/drive/connector.js');
        try {
          const { files } = await listFiles(config, {
            query: args.query as string | undefined,
            pageSize: (args.limit as number) ?? 25,
          });
          return files.map(
            (f: { id: string; name: string; mimeType: string; modifiedTime: string }) => ({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              modifiedTime: f.modifiedTime,
            }),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            error: 'drive_error',
            message: msg,
            hint: 'Check that Drive is connected and try again. If the token expired, call connect_drive to re-authenticate.',
          };
        }
      },
    },

    // ── connect_notion ────────────────────────────────────────────────────────
    {
      name: 'connect_notion',
      description: [
        'Initiate Notion OAuth. RETURNS {auth_url, instructions}.',
        'The user must open auth_url in a browser and authorize the Notion integration.',
        'NON-RETRYABLE: DO NOT call this tool again until the user confirms completion in conversation.',
        'Calling it repeatedly creates orphan OAuth states.',
        'After user confirms, Notion ingestion is available — use ingest(notion_url) or watch({source_type: "notion"}).',
        'If Notion is already connected, returns {already_connected: true, workspace} — do not call again.',
        'RETURNS: {already_connected: true, workspace} or {auth_url, connected: true, workspace} or {auth_url, timeout: true}.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { startNotionOAuthFlow, isNotionConnected, getNotionWorkspace } = await import(
          '../modules/notion/oauth.js'
        );
        if (isNotionConnected()) {
          const ws = getNotionWorkspace();
          return { already_connected: true, workspace: ws?.name };
        }
        if (!config.notion) {
          return {
            error: 'notion_not_configured',
            message: 'Notion OAuth credentials are not configured.',
            hint: 'Set notion.clientId and notion.clientSecret in ~/.engram/config.json. Create an integration at https://www.notion.so/my-integrations',
          };
        }
        try {
          const flow = await startNotionOAuthFlow(config);
          const result = await Promise.race([
            flow.waitForCallback.then((t: { workspace_name: string }) => ({
              connected: true,
              workspace: t.workspace_name,
            })),
            new Promise<{ timeout: boolean }>((resolve) =>
              setTimeout(() => resolve({ timeout: true }), 300_000),
            ),
          ]);
          return {
            auth_url: flow.authUrl,
            instructions: 'Open auth_url in your browser and authorize. Then confirm here.',
            ...result,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            error: 'notion_not_configured',
            message: msg,
            hint: 'Set notion.clientId and notion.clientSecret in ~/.engram/config.json. Create an integration at https://www.notion.so/my-integrations',
          };
        }
      },
    },

    // ── list_notion_pages ─────────────────────────────────────────────────────
    {
      name: 'list_notion_pages',
      description: [
        'Search Notion workspace for pages matching a query.',
        'Requires Notion to be connected first (use connect_notion if not).',
        'Default returns up to 25 pages.',
        'PAGINATION: DO NOT call multiple times for the same query in one turn — cache the result.',
        'Prefer ingest(notion_url) or watch({source_type: "notion", target_id}) for specific pages.',
        'RETURNS: array of Notion page objects.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query for Notion pages.' },
          limit: { type: 'number', default: 25, description: 'Max pages to return (default 25).' },
        },
      },
      handler: async (args) => {
        const { searchPages } = await import('../modules/notion/connector.js');
        const { isNotionConnected } = await import('../modules/notion/oauth.js');
        if (!isNotionConnected())
          return {
            error: 'notion_not_connected',
            message: 'Notion is not connected.',
            hint: 'Call connect_notion first to authenticate with Notion.',
          };
        return await searchPages((args.query as string) ?? '', (args.limit as number) ?? 25);
      },
    },

    // ── import_watch_later ────────────────────────────────────────────────────
    {
      name: 'import_watch_later',
      description: [
        'Bulk-import a YouTube playlist (public URL). Imports all videos as memory items.',
        'SLOW: can take 1-30 minutes depending on playlist size.',
        "ANTI-LOOP: DO NOT call twice for the same playlist — duplicates are deduped but the API hammering wastes the user's YouTube quota.",
        'For individual YouTube videos, use ingest(youtube_url) instead.',
        'Poll get_ingest_status(job_id) to track progress.',
        'RETURNS: { job_id?, status, imported?, errors? } — large playlists run as async job.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          playlistUrl: { type: 'string', description: 'Public YouTube playlist URL.' },
          limit: { type: 'number', description: 'Max videos to import (default 50).' },
        },
        required: ['playlistUrl'],
      },
      handler: async (args) => {
        const { importPlaylist } = await import('../modules/youtube/watcher.js');
        const result = await importPlaylist(
          args.playlistUrl as string,
          store,
          config.embeddings,
          config.youtube,
          (args.limit as number) ?? 50,
        );
        // Normalise response shape to always include status field (matches ingest() contract)
        return { ...result, status: 'completed' };
      },
    },

    // ── analyze_patterns ─────────────────────────────────────────────────────
    {
      name: 'analyze_patterns',
      description: [
        'Analyze patterns across multiple memories on a topic.',
        'WHEN: user asks "what patterns/themes/trends do you see in my notes about X?" or wants a higher-level synthesis than individual recall.',
        'Returns up to `limit` (default 30) matching memories PLUS pre-computed aggregations (tag freq, timeline, type distribution) PLUS a structured instruction for you (the calling LLM) to do the actual inference.',
        'You synthesize the patterns from the bundled memories — the aggregations field has pre-computed counts to speed your analysis.',
        'INPUTS: topic (required — short concept noun), optional types (array to restrict scope), optional limit (default 30, max 100), optional lookback_days (default no limit).',
        'IDEMPOTENT on (topic, types, limit, lookback_days) — calling twice with same args returns the same bundle. DO NOT call repeatedly in the same turn for the same topic.',
        'RETURNS: { topic, memories_found, date_range, memories, aggregations: { tags_frequency, types_distribution, timeline }, instruction }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Short concept noun to analyze — NOT the full user question.',
          },
          types: {
            type: 'array',
            items: { type: 'string' },
            description: 'Restrict to these memory types (default: all).',
          },
          limit: {
            type: 'number',
            default: 30,
            description: 'Max memories to bundle (default 30, max 100).',
          },
          lookback_days: {
            type: 'number',
            description: 'Only include memories from the past N days (default: all time).',
          },
        },
        required: ['topic'],
      },
      handler: async (args) => {
        const topic = args.topic as string;
        const limit = Math.min((args.limit as number) ?? 30, 100);
        const lookbackDays = args.lookback_days as number | undefined;
        const types = (args.types as string[] | undefined) ?? store.listTypes();

        // Fan-out search across all requested types
        const perTypeLimit = Math.max(10, Math.ceil(limit * 1.5));
        const allResults = await Promise.all(
          types.map(async (t) => {
            try {
              const hits = await store.search(t, topic, perTypeLimit);
              return hits.map((h) => ({
                ...h,
                score:
                  h.score *
                  (TYPE_WEIGHTS[t] ?? 0.85) *
                  recencyBoost(Date.parse(h.memory.properties.created_at)),
              }));
            } catch {
              return [];
            }
          }),
        );

        let candidates = allResults
          .flat()
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        // Apply lookback filter if specified
        if (lookbackDays !== undefined) {
          const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
          candidates = candidates.filter(
            (c) => Date.parse(c.memory.properties.created_at) >= cutoff,
          );
        }

        if (candidates.length === 0) {
          return {
            topic,
            memories_found: 0,
            date_range: { from: null, to: null },
            memories: [],
            aggregations: { tags_frequency: {}, types_distribution: {}, timeline: [] },
            instruction: `No memories found matching "${topic}". Try a broader or different topic noun.`,
          };
        }

        // Pre-compute aggregations
        const tagsFreq: Record<string, number> = {};
        const typesDist: Record<string, number> = {};
        const timelineBuckets: Record<string, number> = {};

        for (const c of candidates) {
          // Type distribution
          const t = c.memory.type;
          typesDist[t] = (typesDist[t] ?? 0) + 1;

          // Tag frequency
          const tags = c.memory.properties.tags ?? [];
          for (const tag of tags) {
            tagsFreq[tag] = (tagsFreq[tag] ?? 0) + 1;
          }

          // Timeline — bucket by YYYY-MM-DD
          const day = c.memory.properties.created_at.slice(0, 10);
          timelineBuckets[day] = (timelineBuckets[day] ?? 0) + 1;
        }

        // Top 20 tags by frequency
        const sortedTags = Object.entries(tagsFreq)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 20);
        const tags_frequency = Object.fromEntries(sortedTags);

        // Timeline sorted chronologically
        const timeline = Object.entries(timelineBuckets)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, count]) => ({ date, count }));

        const allDates = candidates.map((c) => c.memory.properties.created_at);
        const dateFrom = allDates.reduce((a, b) => (a < b ? a : b));
        const dateTo = allDates.reduce((a, b) => (a > b ? a : b));
        const rangeLabel =
          dateFrom.slice(0, 10) === dateTo.slice(0, 10)
            ? dateFrom.slice(0, 10)
            : `${dateFrom.slice(0, 10)} to ${dateTo.slice(0, 10)}`;

        const memories = candidates.map((c) => ({
          id: c.memory.id,
          type: c.memory.type,
          title: c.memory.properties.title ?? null,
          content_preview: c.snippet,
          tags: c.memory.properties.tags ?? [],
          created_at: c.memory.properties.created_at,
        }));

        const instruction = [
          `You have ${candidates.length} memories about "${topic}" spanning ${rangeLabel}. Analyze them and report:`,
          `1. **Recurring entities** — people, projects, places that come up repeatedly. List top 5 with counts.`,
          `2. **Pattern themes** — what subtopics/themes recur? Group similar memories.`,
          `3. **Time progression** — how has the user's relationship with this topic evolved over ${rangeLabel}? Any inflection points?`,
          `4. **Sentiment arc** — overall positive/neutral/negative, any shifts?`,
          `5. **Open questions** — what's missing or under-documented?`,
          `6. **Action items** — anything the user committed to that you can see hasn't been done?`,
          ``,
          `Use the memories array directly. The aggregations field has pre-computed counts to speed your analysis.`,
          `Format as markdown sections.`,
        ].join('\n');

        return {
          topic,
          memories_found: candidates.length,
          date_range: { from: dateFrom, to: dateTo },
          memories,
          aggregations: { tags_frequency, types_distribution: typesDist, timeline },
          instruction,
        };
      },
    },

    // ── summarize_recent ──────────────────────────────────────────────────────
    {
      name: 'summarize_recent',
      description: [
        'Return recent memories with a structured summarization prompt for you (the calling LLM) to produce a digest or daily summary.',
        'WHEN: user asks "summarize my last week", "what did I do recently?", or you want to produce a periodic digest.',
        'INPUTS: optional types (array to restrict scope), optional days (default 7), optional limit (default 50, max 200).',
        'IDEMPOTENT on (types, days, limit) — same args return the same bundle within the same day. DO NOT re-call in the same turn.',
        'RETURNS: { period: { from, to }, memories_count, memories, instruction }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          types: {
            type: 'array',
            items: { type: 'string' },
            description: 'Restrict to these memory types (default: all).',
          },
          days: {
            type: 'number',
            default: 7,
            description: 'How many days to look back (default 7).',
          },
          limit: {
            type: 'number',
            default: 50,
            description: 'Max memories to return (default 50, max 200).',
          },
        },
      },
      handler: async (args) => {
        const days = (args.days as number) ?? 7;
        const limit = Math.min((args.limit as number) ?? 50, 200);
        const types = args.types as string[] | undefined;

        const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
        const cutoffTs = cutoffMs; // SQLite stores created_at as Unix ms integer

        const { getDb } = await import('../../db/index.js');
        const db = getDb();

        let sql = `SELECT id, type, content, properties_json, created_at
                   FROM memories
                   WHERE created_at >= ?`;
        const params: unknown[] = [cutoffTs];

        if (types && types.length > 0) {
          sql += ` AND type IN (${types.map(() => '?').join(',')})`;
          params.push(...types);
        }

        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);

        const rows = db.prepare(sql).all(...params) as Array<{
          id: string;
          type: string;
          content: string;
          properties_json: string;
          created_at: number;
        }>;

        const memories = rows.map((r) => {
          const props = JSON.parse(r.properties_json) as Record<string, unknown>;
          return {
            id: r.id,
            type: r.type,
            title: (props.title as string | undefined) ?? null,
            content_preview: r.content.slice(0, 200),
            tags: (props.tags as string[] | undefined) ?? [],
            created_at: new Date(r.created_at).toISOString(),
          };
        });

        const periodFrom = new Date(cutoffMs).toISOString();
        const periodTo = new Date().toISOString();

        const instruction = [
          `Summarize the user's ${days}-day window (${periodFrom.slice(0, 10)} to ${periodTo.slice(
            0,
            10,
          )}) from ${memories.length} memories.`,
          ``,
          `Produce a structured digest with these sections:`,
          `1. **Highlights** — the 3-5 most significant things that happened or were captured.`,
          `2. **Projects & Work** — what projects were active? Any progress or blockers noted?`,
          `3. **People** — who came up? Any notable interactions?`,
          `4. **Decisions made** — anything the user decided or committed to?`,
          `5. **Open items** — tasks or questions that appear unresolved.`,
          `6. **One-line summary** — a single sentence capturing the essence of the period.`,
          ``,
          `Keep the summary concise. Use bullet points. Focus on signal over noise.`,
        ].join('\n');

        return {
          period: { from: periodFrom, to: periodTo },
          memories_count: memories.length,
          memories,
          instruction,
        };
      },
    },

    // ── find_gaps ─────────────────────────────────────────────────────────────
    {
      name: 'find_gaps',
      description: [
        'Search memories on a topic and return them with a structured prompt asking you (the calling LLM) to identify gaps, broken threads, and unanswered questions.',
        'WHEN: user asks "what am I missing about X?", "what did I never follow up on?", or wants gap analysis rather than pattern synthesis.',
        'Returns matching memories PLUS a structured instruction focused on identifying: aspects mentioned but never expanded, promises/commitments without follow-up, people/projects mentioned once and abandoned, questions asked but never answered.',
        'INPUTS: topic (required), optional lookback_days (default 90).',
        'IDEMPOTENT on (topic, lookback_days) — calling twice returns same bundle. DO NOT re-call in the same turn.',
        'RETURNS: { topic, memories_found, date_range, memories, aggregations, instruction }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Short concept noun to find gaps for — NOT the full user question.',
          },
          lookback_days: {
            type: 'number',
            default: 90,
            description: 'How many days to look back (default 90).',
          },
        },
        required: ['topic'],
      },
      handler: async (args) => {
        const topic = args.topic as string;
        const lookbackDays = (args.lookback_days as number) ?? 90;

        const types = store.listTypes();
        const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

        // Fan-out search
        const perTypeLimit = 20;
        const allResults = await Promise.all(
          types.map(async (t) => {
            try {
              const hits = await store.search(t, topic, perTypeLimit);
              return hits.map((h) => ({
                ...h,
                score:
                  h.score *
                  (TYPE_WEIGHTS[t] ?? 0.85) *
                  recencyBoost(Date.parse(h.memory.properties.created_at)),
              }));
            } catch {
              return [];
            }
          }),
        );

        let candidates = allResults
          .flat()
          .sort((a, b) => b.score - a.score)
          .slice(0, 50);

        // Apply lookback filter
        candidates = candidates.filter((c) => Date.parse(c.memory.properties.created_at) >= cutoff);

        if (candidates.length === 0) {
          return {
            topic,
            memories_found: 0,
            date_range: { from: null, to: null },
            memories: [],
            aggregations: { tags_frequency: {}, types_distribution: {}, timeline: [] },
            instruction: `No memories found matching "${topic}" in the last ${lookbackDays} days. Try a broader topic or increase lookback_days.`,
          };
        }

        // Pre-compute aggregations (same as analyze_patterns)
        const tagsFreq: Record<string, number> = {};
        const typesDist: Record<string, number> = {};
        const timelineBuckets: Record<string, number> = {};

        for (const c of candidates) {
          const t = c.memory.type;
          typesDist[t] = (typesDist[t] ?? 0) + 1;
          const tags = c.memory.properties.tags ?? [];
          for (const tag of tags) {
            tagsFreq[tag] = (tagsFreq[tag] ?? 0) + 1;
          }
          const day = c.memory.properties.created_at.slice(0, 10);
          timelineBuckets[day] = (timelineBuckets[day] ?? 0) + 1;
        }

        const sortedTags = Object.entries(tagsFreq)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 20);
        const tags_frequency = Object.fromEntries(sortedTags);
        const timeline = Object.entries(timelineBuckets)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, count]) => ({ date, count }));

        const allDates = candidates.map((c) => c.memory.properties.created_at);
        const dateFrom = allDates.reduce((a, b) => (a < b ? a : b));
        const dateTo = allDates.reduce((a, b) => (a > b ? a : b));
        const rangeLabel =
          dateFrom.slice(0, 10) === dateTo.slice(0, 10)
            ? dateFrom.slice(0, 10)
            : `${dateFrom.slice(0, 10)} to ${dateTo.slice(0, 10)}`;

        const memories = candidates.map((c) => ({
          id: c.memory.id,
          type: c.memory.type,
          title: c.memory.properties.title ?? null,
          content_preview: c.snippet,
          tags: c.memory.properties.tags ?? [],
          created_at: c.memory.properties.created_at,
        }));

        const instruction = [
          `You have ${candidates.length} memories about "${topic}" spanning ${rangeLabel}. Identify the gaps — what's incomplete, abandoned, or unresolved:`,
          ``,
          `1. **Mentioned but never expanded** — topics, ideas, or projects referenced briefly but never detailed. List them.`,
          `2. **Promises & commitments without follow-up** — anything the user said they would do or decided to pursue, that has no later memory confirming it was done.`,
          `3. **Single-mention entities** — people, tools, or projects that appear exactly once and were never revisited. Are they dropped threads?`,
          `4. **Unanswered questions** — questions or "I wonder if..." phrasing that was never answered in a later memory.`,
          `5. **Documentation gaps** — important decisions or events that you'd expect to find notes about but don't.`,
          `6. **Recommendations** — what should the user document or follow up on next?`,
          ``,
          `Be specific: quote or cite memory titles/content when identifying gaps. Use the aggregations to spot single-occurrence tags.`,
        ].join('\n');

        return {
          topic,
          memories_found: candidates.length,
          date_range: { from: dateFrom, to: dateTo },
          memories,
          aggregations: { tags_frequency, types_distribution: typesDist, timeline },
          instruction,
        };
      },
    },

    // ── delete_type ───────────────────────────────────────────────────────────
    {
      name: 'delete_type',
      description: [
        'Delete a custom type definition. Memories of that type are kept but the type schema is removed.',
        'WHEN: user wants to remove a custom type they no longer need.',
        'REQUIRES confirm: true — if confirm is missing or false, returns {error: "confirm_required", type_summary} for the agent to show the user before retrying with confirm: true.',
        'DO NOT retry with confirm: true without user acknowledgement — this is a destructive operation.',
        'RETURNS: { deleted: type_name } or { error: "confirm_required", type_summary } or { error }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The type name to delete.' },
          confirm: {
            type: 'boolean',
            description: 'Must be true to confirm deletion. Safety guard.',
          },
        },
        required: ['name', 'confirm'],
      },
      handler: async (args) => {
        const typeName = args.name as string;
        if (!args.confirm) {
          // Return type summary so agent can show user before confirming
          const { getDb } = await import('../../db/index.js');
          const db = getDb();
          const memoryCount = (
            db.prepare(`SELECT COUNT(*) as n FROM memories WHERE type = ?`).get(typeName) as {
              n: number;
            }
          ).n;
          return {
            error: 'confirm_required',
            type_summary: {
              type_name: typeName,
              memory_count: memoryCount,
              warning: `This will delete the type schema. ${memoryCount} memories of this type will be kept but the custom type definition will be removed.`,
            },
          };
        }
        const { deleteCustomType } = await import('../modules/_custom/persistence.js');
        deleteCustomType(typeName);
        return { deleted: typeName };
      },
    },

    // ── skip / unskip / pin / unpin / set_importance ─────────────────────────
    // Recall-signal tools. Cheap writes to the memories table — no embedding,
    // no chunking, no vector index touch. Used by users (via dashboard) and by
    // agents to teach the system what to surface vs hide vs preserve forever.
    {
      name: 'skip',
      description: [
        'Mark a memory as "not useful right now" — multiplies its skip_penalty by 0.2.',
        "WHEN: a recall result is genuinely irrelevant and the agent shouldn't surface it again on similar queries.",
        'NOT for deletion — the memory stays in storage and unskip() restores full rank.',
        'IDEMPOTENT: calling twice multiplies penalty again (0.2 → 0.04). Use sparingly.',
        'RETURNS: { id, skip_penalty: <new value> }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args) => {
        const id = args.id as string;
        const { getDb } = await import('../../db/index.js');
        const db = getDb();
        const result = db
          .prepare(`UPDATE memories SET skip_penalty = MAX(0.001, skip_penalty * 0.2) WHERE id = ?`)
          .run(id);
        if (result.changes === 0) return { error: 'not_found', id };
        const row = db.prepare(`SELECT skip_penalty FROM memories WHERE id = ?`).get(id) as
          | { skip_penalty: number }
          | undefined;
        return { id, skip_penalty: row?.skip_penalty };
      },
    },
    {
      name: 'unskip',
      description: [
        'Restore a previously skipped memory to full recall rank (skip_penalty = 1.0).',
        'WHEN: the user corrects a wrongly skipped item, or you realise a "not useful" call was a mistake.',
        'IDEMPOTENT: returns success even if the memory was never skipped.',
        'RETURNS: { id, skip_penalty: 1.0 }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args) => {
        const id = args.id as string;
        const { getDb } = await import('../../db/index.js');
        const r = getDb().prepare(`UPDATE memories SET skip_penalty = 1.0 WHERE id = ?`).run(id);
        if (r.changes === 0) return { error: 'not_found', id };
        return { id, skip_penalty: 1.0 };
      },
    },
    {
      name: 'pin',
      description: [
        'Pin a memory — exempts it from time-decay forever (until unpinned).',
        'WHEN: critical preference, identity fact, or a piece of context that must never fade.',
        'Pinned memories ignore the importance × half-life decay curve.',
        'IDEMPOTENT: returns {pinned: true} regardless of prior state.',
        'RETURNS: { id, pinned: true }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args) => {
        const id = args.id as string;
        const { getDb } = await import('../../db/index.js');
        const r = getDb().prepare(`UPDATE memories SET pinned = 1 WHERE id = ?`).run(id);
        if (r.changes === 0) return { error: 'not_found', id };
        return { id, pinned: true };
      },
    },
    {
      name: 'unpin',
      description: [
        'Remove the pin from a memory — it resumes normal time-decay based on its importance.',
        'IDEMPOTENT: returns {pinned: false} regardless of prior state.',
        'RETURNS: { id, pinned: false }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args) => {
        const id = args.id as string;
        const { getDb } = await import('../../db/index.js');
        const r = getDb().prepare(`UPDATE memories SET pinned = 0 WHERE id = ?`).run(id);
        if (r.changes === 0) return { error: 'not_found', id };
        return { id, pinned: false };
      },
    },
    {
      name: 'set_importance',
      description: [
        "Set a memory's importance level — affects decay half-life (high=90d, medium=30d, low=14d) and recall ranking.",
        'WHEN: user marks something as critical, or the agent decides a memory deserves more/less prominence.',
        'Default importance is set automatically at remember() time based on intent classification (preferences + corrections → high).',
        'IDEMPOTENT.',
        'RETURNS: { id, importance }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          level: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['id', 'level'],
      },
      handler: async (args) => {
        const id = args.id as string;
        const level = args.level as string;
        if (!['high', 'medium', 'low'].includes(level)) {
          return { error: 'invalid_level', message: 'level must be high|medium|low' };
        }
        const { getDb } = await import('../../db/index.js');
        const r = getDb().prepare(`UPDATE memories SET importance = ? WHERE id = ?`).run(level, id);
        if (r.changes === 0) return { error: 'not_found', id };
        return { id, importance: level };
      },
    },

    // ── recall_chain ────────────────────────────────────────────────────────
    // Graph traversal over wikilinks + related_ids — our answer to Neo4j-backed
    // graph memory features in competing products. No external graph DB needed
    // because we already store the edges in the memory row's related_ids array.
    {
      name: 'recall_chain',
      description: [
        'Traverse the memory graph from a starting memory id, following wikilinks + related_ids up to `depth` hops.',
        'WHEN: "show me the chain of reasoning that led here", "what memories are connected to this decision?".',
        'Returns memories grouped by hop distance — direct neighbors at depth 1, their neighbors at depth 2, etc.',
        'ANTI-LOOP: depth is capped at 4 (silently). Memories are deduplicated across hops.',
        'RETURNS: { root: id, chain: [{ depth, memories: [{ id, type, title, score }] }] }.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Starting memory id.' },
          depth: { type: 'number', default: 2, description: 'Max hop distance (capped at 4).' },
          limit_per_hop: { type: 'number', default: 10 },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const rootId = args.id as string;
        const maxDepth = Math.min(4, Math.max(1, (args.depth as number) ?? 2));
        const limitPerHop = Math.max(1, (args.limit_per_hop as number) ?? 10);
        const root = store.getById(rootId);
        if (!root) return { error: 'not_found', id: rootId };

        const visited = new Set<string>([rootId]);
        const chain: Array<{
          depth: number;
          memories: Array<{
            id: string;
            type: string;
            title?: string;
            via: 'wikilink' | 'related';
          }>;
        }> = [];

        type ChainEntry = {
          id: string;
          type: string;
          title: string | undefined;
          via: 'wikilink' | 'related';
        };
        let frontier: string[] = [rootId];
        for (let d = 1; d <= maxDepth; d++) {
          const nextFrontier: Array<{ id: string; via: 'wikilink' | 'related' }> = [];
          for (const fid of frontier) {
            const m = store.getById(fid);
            if (!m) continue;
            for (const wl of m.wikilinks ?? []) {
              const targetId = wl;
              if (!visited.has(targetId)) {
                visited.add(targetId);
                nextFrontier.push({ id: targetId, via: 'wikilink' });
              }
            }
            for (const rid of m.related_ids ?? []) {
              if (!visited.has(rid)) {
                visited.add(rid);
                nextFrontier.push({ id: rid, via: 'related' });
              }
            }
          }
          if (nextFrontier.length === 0) break;
          const hopMemories: ChainEntry[] = [];
          for (const f of nextFrontier.slice(0, limitPerHop)) {
            const m = store.getById(f.id);
            if (!m) continue;
            hopMemories.push({ id: m.id, type: m.type, title: m.properties.title, via: f.via });
          }
          if (hopMemories.length === 0) break;
          chain.push({ depth: d, memories: hopMemories });
          frontier = hopMemories.map((m) => m.id);
        }

        return {
          root: { id: root.id, type: root.type, title: root.properties.title },
          total_reached: visited.size - 1,
          chain,
        };
      },
    },
  ];
}

// ── Heavy-op detection ────────────────────────────────────────────────────────

function normalizeUri(uri: string): string {
  if (!uri.startsWith('http') && !uri.startsWith('obsidian://') && !uri.startsWith('file://')) {
    return `file://${uri}`;
  }
  return uri;
}

function isHeavyOp(normalUri: string, forceType?: string): boolean {
  // Audio files → Whisper (always heavy)
  if (forceType === 'audio') return true;
  if (normalUri.startsWith('file://')) {
    const ext = normalUri.split('.').pop()?.toLowerCase() ?? '';
    if (['mp3', 'wav', 'm4a', 'ogg', 'webm'].includes(ext)) return true;
  }
  // YouTube → use fast-path heuristic (handled separately)
  const isYoutube =
    normalUri.startsWith('https://www.youtube.com/watch') ||
    normalUri.startsWith('https://youtu.be/');
  if (isYoutube || forceType === 'youtube') return true;
  return false;
}

/**
 * Probe YouTube watch page to estimate video duration in seconds.
 * Extracts `"lengthSeconds":"NNN"` from the injected player config JSON.
 * Caps probe at 2s timeout. Returns null on any failure (safe to async).
 */
async function probeYoutubeDuration(videoId: string): Promise<number | null> {
  try {
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      signal: AbortSignal.timeout(2000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EngramMCP/0.2)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const match = html.match(/"lengthSeconds":"(\d+)"/);
    if (!match) return null;
    return parseInt(match[1], 10);
  } catch {
    return null;
  }
}

async function handleAsyncIngest(
  uri: string,
  forceType: string | undefined,
  titleOverride: string | undefined,
  tagsOverride: string[] | undefined,
  store: MemoryStore,
  config: EngramConfig,
): Promise<Record<string, unknown>> {
  const { createJob, startJob, completeJob, failJob } = await import('../../ingest/jobs.js');

  const normalUri = normalizeUri(uri);
  const ext = normalUri.startsWith('file://')
    ? normalUri.split('.').pop()?.toLowerCase() ?? ''
    : '';
  const isAudio = ['mp3', 'wav', 'm4a', 'ogg', 'webm'].includes(ext) || forceType === 'audio';

  const jobId = createJob(uri, forceType);
  const estimatedMs = isAudio ? 60_000 : 30_000;

  // Fire-and-forget background processing
  void (async () => {
    try {
      startJob(jobId);
      const result = await routeIngest(uri, forceType, titleOverride, tagsOverride, store, config);
      const memoryId = result.id as string;
      completeJob(jobId, memoryId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failJob(jobId, msg);
    }
  })();

  return { job_id: jobId, status: 'pending', estimated_ms: estimatedMs };
}

// ── Ingest routing helper ─────────────────────────────────────────────────────

export async function routeIngest(
  uri: string,
  forceType: string | undefined,
  titleOverride: string | undefined,
  tagsOverride: string[] | undefined,
  store: MemoryStore,
  config: EngramConfig,
): Promise<Record<string, unknown>> {
  const embeddingModel = `${config.embeddings.provider}/${config.embeddings.model}`;

  // Normalise: bare absolute paths → file:// URI
  let normalUri = uri;
  if (!uri.startsWith('http') && !uri.startsWith('obsidian://') && !uri.startsWith('file://')) {
    normalUri = `file://${uri}`;
  }

  // ── Security: validate URI before any fetch / readFile ──────────────────────
  // Blocks SSRF (private/internal IPs, AWS IMDS) and arbitrary local file reads
  // (file:// must be inside ~/Documents, ~/Downloads, ~/Desktop, ~/Movies,
  // ~/Music, or config.ingest.allowedPaths).
  // OAuth-bound URLs (Drive, Notion) and obsidian:// are skipped — they go
  // through their own connectors with hardcoded API hosts.
  const isOauthBoundUrl =
    normalUri.startsWith('https://docs.google.com/document/d/') ||
    normalUri.startsWith('https://drive.google.com/file/') ||
    normalUri.startsWith('https://www.notion.so/') ||
    normalUri.startsWith('obsidian://');
  if (!isOauthBoundUrl) {
    const { validateFileUri, validateHttpUri } = await import(
      '../../core/security/uri-validator.js'
    );
    const extraAllowed = config.ingest?.allowedPaths ?? [];
    if (normalUri.startsWith('file://')) {
      validateFileUri(normalUri, extraAllowed);
    } else if (normalUri.startsWith('http://') || normalUri.startsWith('https://')) {
      await validateHttpUri(normalUri);
    }
  }

  // ── YouTube ─────────────────────────────────────────────────────────────────
  const isYoutube =
    normalUri.startsWith('https://www.youtube.com/watch') ||
    normalUri.startsWith('https://youtu.be/');
  if (isYoutube || forceType === 'youtube') {
    const { fetchTranscript } = await import('../modules/youtube/transcript-fetcher.js');
    const { buildYoutubeItem } = await import('../modules/youtube/ingest.js');
    const transcript = await fetchTranscript(normalUri, config.youtube);
    // Fail fast if transcript is empty — do not create an empty memory
    if (
      !transcript.full_text ||
      transcript.full_text.trim() === '' ||
      transcript.segments.length === 0
    ) {
      throw new Error(
        `Could not fetch transcript — video may have no captions or yt-dlp is unavailable (video_id: ${transcript.video_id})`,
      );
    }
    const item = buildYoutubeItem({ transcript, embeddingModel });
    if (titleOverride) item.properties.title = titleOverride;
    if (tagsOverride) item.properties.tags = tagsOverride;
    await store.insert(item);
    return { id: item.id, type: item.type, title: item.properties.title };
  }

  // ── Google Drive ─────────────────────────────────────────────────────────────
  const isDrive =
    normalUri.startsWith('https://docs.google.com/document/d/') ||
    normalUri.startsWith('https://drive.google.com/file/');
  if (isDrive || forceType === 'drive') {
    // Extract file id from URL
    const driveIdMatch = normalUri.match(/\/d\/([^/?]+)/);
    if (!driveIdMatch) throw new Error('Cannot extract Drive file id from URI');
    const fileId = driveIdMatch[1];
    const { getFileMetadata, downloadFileContent } = await import('../modules/drive/connector.js');
    const { buildDriveItem } = await import('../modules/drive/ingest.js');
    const meta = await getFileMetadata(fileId, config);
    const content = await downloadFileContent(fileId, meta.mimeType, config);
    if (!content) throw new Error(`Unsupported Drive mimeType: ${meta.mimeType}`);
    const item = buildDriveItem({ metadata: meta, content, embeddingModel });
    if (titleOverride) item.properties.title = titleOverride;
    if (tagsOverride) item.properties.tags = tagsOverride;
    await store.insert(item);
    return { id: item.id, type: item.type, title: item.properties.title };
  }

  // ── Notion ───────────────────────────────────────────────────────────────────
  const isNotion = /https:\/\/[^.]+\.notion\.so\//.test(normalUri);
  if (isNotion || forceType === 'notion') {
    // Extract page id from Notion URL (last path segment, strip hyphens)
    const notionPageMatch = normalUri.match(/([a-f0-9]{32}|[a-f0-9-]{36})\??/);
    if (!notionPageMatch) throw new Error('Cannot extract Notion page id from URI');
    const pageId = notionPageMatch[1].replace(/-/g, '');
    const { getPageMetadata, fetchPageText } = await import('../modules/notion/connector.js');
    const { buildNotionItem } = await import('../modules/notion/ingest.js');
    const meta = await getPageMetadata(pageId);
    const content = await fetchPageText(meta.id);
    const item = buildNotionItem({ metadata: meta, content, embeddingModel });
    if (titleOverride) item.properties.title = titleOverride;
    if (tagsOverride) item.properties.tags = tagsOverride;
    await store.insert(item);
    return { id: item.id, type: item.type, title: item.properties.title };
  }

  // ── Obsidian ─────────────────────────────────────────────────────────────────
  if (normalUri.startsWith('obsidian://vault/') || forceType === 'obsidian') {
    // obsidian://vault/<vault>/<path> — treat path as a single file
    const { readFile } = await import('fs/promises');
    const vaultMatch = normalUri.replace('obsidian://vault/', '').split('/');
    const vaultName = vaultMatch[0];
    const filePath = vaultMatch.slice(1).join('/');
    const { buildObsidianItem } = await import('../modules/obsidian/ingest.js');
    const absolutePath = `/${filePath}`; // simplified — real usage needs vault root mapping
    const content = await readFile(absolutePath, 'utf-8');
    const item = buildObsidianItem({
      file: {
        relativePath: filePath,
        absolutePath,
        content,
        modifiedAt: Date.now(),
      },
      vaultRoot: `/${vaultName}`,
      embeddingModel,
    });
    if (titleOverride) item.properties.title = titleOverride;
    if (tagsOverride) item.properties.tags = tagsOverride;
    await store.insert(item);
    return { id: item.id, type: item.type, title: item.properties.title };
  }

  // ── File URI ─────────────────────────────────────────────────────────────────
  if (normalUri.startsWith('file://')) {
    const filePath = normalUri.replace('file://', '');
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

    // Audio
    if (['mp3', 'wav', 'm4a', 'ogg', 'webm'].includes(ext) || forceType === 'audio') {
      const { transcribeAudio } = await import('../modules/audio/transcriber.js');
      const { buildAudioItem } = await import('../modules/audio/ingest.js');
      const transcript = await transcribeAudio(filePath, config.whisper);
      const item = buildAudioItem({ audioPath: filePath, transcript, embeddingModel });
      if (titleOverride) item.properties.title = titleOverride;
      if (tagsOverride) item.properties.tags = tagsOverride;
      await store.insert(item);
      return { id: item.id, type: item.type, title: item.properties.title };
    }

    // Images
    if (['png', 'jpg', 'jpeg', 'gif'].includes(ext) || forceType === 'images') {
      const path = await import('path');
      const now = new Date().toISOString();
      const title = titleOverride ?? path.default.basename(filePath);
      const item = {
        id: ulid(),
        type: 'images',
        source_id: `file:${filePath}`,
        content: `Image: ${title}`,
        content_hash: createHash('sha256').update(filePath).digest('hex'),
        properties: {
          title,
          tags: tagsOverride,
          created_at: now,
          ingested_at: now,
          source_url: normalUri,
        },
        wikilinks: [] as string[],
        related_ids: [] as string[],
        embedding_model: embeddingModel,
      };
      await store.insert(item);
      return { id: item.id, type: item.type, title: item.properties.title };
    }

    // PDF — full text extraction via pdf-parse
    if (ext === 'pdf' || forceType === 'pdf') {
      const { readFile } = await import('fs/promises');
      const path = await import('path');
      const now = new Date().toISOString();
      const title = titleOverride ?? path.default.basename(filePath, '.pdf');
      let content: string;
      let extractionFailed = false;
      let extractionError: string | undefined;

      try {
        const buffer = await readFile(filePath);
        const { PDFParse } = (await import('pdf-parse')) as unknown as {
          PDFParse: new (opts: { data: Buffer; verbosity?: number }) => {
            getText(): Promise<{ text: string }>;
          };
        };
        const parser = new PDFParse({ data: buffer, verbosity: 0 });
        const result = await parser.getText();
        content =
          result.text.trim() || `[PDF] ${title} — no extractable text (possibly scanned image PDF)`;
      } catch (e) {
        extractionFailed = true;
        extractionError = e instanceof Error ? e.message : String(e);
        content = `[PDF] ${title} — text extraction failed: ${extractionError}. File: ${filePath}`;
        log.warn(`PDF extraction failed for ${filePath}: ${extractionError}`);
      }

      const wikilinks = extractWikilinks(content);
      const item = {
        id: ulid(),
        type: 'notes',
        source_id: `file:${filePath}`,
        content,
        content_hash: createHash('sha256').update(content).digest('hex'),
        properties: {
          title,
          tags: extractionFailed
            ? [...(tagsOverride ?? []), 'pdf_extraction_failed']
            : tagsOverride,
          created_at: now,
          ingested_at: now,
          source_url: normalUri,
          custom: {
            pdf_path: filePath,
            extraction_status: extractionFailed ? 'failed' : 'complete',
          },
        },
        wikilinks,
        related_ids: [] as string[],
        embedding_model: embeddingModel,
      };
      await store.insert(item);
      const response: Record<string, unknown> = { id: item.id, type: 'notes', title };
      if (extractionFailed) response.extraction_failed = true;
      return response;
    }

    // Markdown / plain text
    if (['md', 'txt', 'markdown'].includes(ext) || forceType === 'notes') {
      const { readFile } = await import('fs/promises');
      const path = await import('path');
      const content = await readFile(filePath, 'utf-8');
      const wikilinks = extractWikilinks(content);
      const now = new Date().toISOString();

      // Extract title from frontmatter or first H1
      let autoTitle: string | undefined;
      const firstLine = content.split('\n').find((l) => l.startsWith('# '));
      if (firstLine) autoTitle = firstLine.replace(/^#\s+/, '').trim();

      const item = {
        id: ulid(),
        type: 'notes',
        source_id: `file:${filePath}`,
        content,
        content_hash: createHash('sha256').update(content).digest('hex'),
        properties: {
          title: titleOverride ?? autoTitle ?? path.default.basename(filePath, `.${ext}`),
          tags: tagsOverride,
          created_at: now,
          ingested_at: now,
          source_url: normalUri,
        },
        wikilinks,
        related_ids: [] as string[],
        embedding_model: embeddingModel,
      };
      await store.insert(item);
      return { id: item.id, type: 'notes', title: item.properties.title };
    }

    // Unknown file type — fallback: store filename as note
    const path = await import('path');
    const now = new Date().toISOString();
    const title = titleOverride ?? path.default.basename(filePath);
    const item = {
      id: ulid(),
      type: 'notes',
      source_id: `file:${filePath}`,
      content: `File: ${filePath}`,
      content_hash: createHash('sha256').update(filePath).digest('hex'),
      properties: {
        title,
        tags: tagsOverride,
        created_at: now,
        ingested_at: now,
        source_url: normalUri,
      },
      wikilinks: [] as string[],
      related_ids: [] as string[],
      embedding_model: embeddingModel,
    };
    await store.insert(item);
    return { id: item.id, type: 'notes', title };
  }

  // ── Generic HTTP URL ─────────────────────────────────────────────────────────
  if (normalUri.startsWith('http://') || normalUri.startsWith('https://')) {
    let content = `URL: ${normalUri}`;
    let autoTitle = normalUri;
    try {
      const res = await fetch(normalUri, {
        headers: { 'User-Agent': 'EngramMCP/0.2 (semantic memory ingestion)' },
        signal: AbortSignal.timeout(10_000),
      });
      const html = await res.text();
      // Extract <title>
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) autoTitle = titleMatch[1].trim();
      // Naive text extraction: strip tags
      content = html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .slice(0, 5000);
    } catch {
      // fetch failed — just store URL as note
    }
    const now = new Date().toISOString();
    const item = {
      id: ulid(),
      type: forceType ?? 'notes',
      source_id: `url:${normalUri}`,
      content,
      content_hash: createHash('sha256').update(content).digest('hex'),
      properties: {
        title: titleOverride ?? autoTitle,
        tags: tagsOverride,
        created_at: now,
        ingested_at: now,
        source_url: normalUri,
      },
      wikilinks: [] as string[],
      related_ids: [] as string[],
      embedding_model: embeddingModel,
    };
    await store.insert(item);
    return { id: item.id, type: item.type, title: item.properties.title };
  }

  throw new Error(`Cannot determine ingest route for URI: ${uri}`);
}
