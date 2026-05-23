/**
 * Memory recall signals — Engram-specific implementation.
 *
 * Each memory carries: importance, pinned, skip_penalty, access_count, confidence.
 * Recall ranking multiplies the semantic similarity score by a `signal_boost`
 * derived from these fields, then optionally drops rows whose
 * effective_confidence falls below a threshold (decay-driven soft purge).
 *
 * Differences from competing implementations:
 *   1. Pinned memories are *immune* to decay (user / LLM can flag "always keep").
 *   2. Decay half-life scales with importance: high=90d, medium=30d, low=14d.
 *   3. skip_penalty multiplies the rank but does NOT delete the memory — a
 *      future `unskip()` restores it.
 *   4. access_count contributes a logarithmic boost so frequently-recalled
 *      memories surface faster, but the boost saturates (no runaway feedback).
 *   5. intent classification is deterministic + regex-based — no LLM call,
 *      runs in <1ms on every remember().
 */

export type Importance = 'high' | 'medium' | 'low';
export type Intent = 'preference' | 'correction' | 'temporal' | 'factual' | 'other';

const DAY_MS = 86_400_000;
const HALF_LIFE_DAYS: Record<Importance, number> = { high: 90, medium: 30, low: 14 };

const IMPORTANCE_WEIGHT: Record<Importance, number> = { high: 1.5, medium: 1.0, low: 0.6 };

/** Soft-purge threshold — memories with effective_confidence below this are hidden from default recall. */
export const DEFAULT_SOFT_PURGE_THRESHOLD = 0.05;

export interface SignalFields {
  importance: Importance;
  pinned: boolean;
  skip_penalty: number;       // 1.0 = neutral, 0.2 = penalised, 0 = ignored
  access_count: number;       // bumped on every recall/get hit
  last_accessed_at: number | null;  // unix ms
  confidence: number;         // 0..1, base trust score
  created_at: number;         // unix ms
}

/**
 * Compute the time-decay multiplier. Pinned memories don't decay.
 * decay = 0.5 ^ (days_since_last_access / half_life_days)
 * If never accessed since creation, days_since uses created_at.
 */
export function decayMultiplier(s: SignalFields, now: number = Date.now()): number {
  if (s.pinned) return 1.0;
  const ref = s.last_accessed_at ?? s.created_at;
  const ageDays = Math.max(0, (now - ref) / DAY_MS);
  const halfLife = HALF_LIFE_DAYS[s.importance];
  return Math.pow(0.5, ageDays / halfLife);
}

/**
 * Frequency boost — log10(1 + access_count) capped at 2x.
 * 0 accesses → 1.0; 9 → 1.30; 99 → 1.60; 999 → 1.90; saturates at 2.0.
 */
export function accessBoost(access_count: number): number {
  return Math.min(2.0, 1 + Math.log10(1 + access_count) / 1.5);
}

/**
 * Total ranking multiplier. Multiply by your semantic similarity score (0..1)
 * to get the final rank.
 *
 *   rank = similarity × importance × decay × access_boost × skip_penalty × confidence
 *
 * Range under normal conditions: ~0.0 (decayed/skipped) to ~6.0 (high-imp + pinned + frequent + confident).
 */
export function signalBoost(s: SignalFields, now: number = Date.now()): number {
  return (
    IMPORTANCE_WEIGHT[s.importance] *
    decayMultiplier(s, now) *
    accessBoost(s.access_count) *
    s.skip_penalty *
    s.confidence
  );
}

/**
 * Returns the "effective confidence" used for soft-purge decisions —
 * confidence × decay × skip_penalty (drops importance + access multipliers).
 * If this falls below DEFAULT_SOFT_PURGE_THRESHOLD the memory is hidden
 * from default recall (still in storage, opt-in to surface via include_decayed).
 */
export function effectiveConfidence(s: SignalFields, now: number = Date.now()): number {
  return s.confidence * decayMultiplier(s, now) * s.skip_penalty;
}

// ---------------------------------------------------------------------------
// Intent classifier — deterministic regex + lexical heuristics. No LLM call.
// ---------------------------------------------------------------------------

const PREFERENCE_PATTERNS = [
  /\b(i (prefer|like|love|hate|always|never)|j[''']?(aime|adore|d[ée]teste|pr[ée]f[èe]re))\b/i,
  /\b(my favou?rite|mon pr[ée]f[ée]r[ée])\b/i,
  /\b(use|utiliser).{0,30}(by default|par d[ée]faut)\b/i,
];

const CORRECTION_PATTERNS = [
  /\b(actually|in fact|en fait|en r[ée]alit[ée]|correction)\b/i,
  /\b(wrong|incorrect|faux|erron[ée]|mistake)\b/i,
  /\bnot.{0,15}(it'?s|was|is)\b/i,
  /\b(update|updated):/i,
];

const TEMPORAL_PATTERNS = [
  /\b(meeting|appointment|deadline|rendez[- ]vous|r[ée]union|due (on|by))\b/i,
  /\b\d{1,2}[/:-]\d{1,2}([/:-]\d{2,4})?\b/, // 12/05, 14:30, 2026-01-15
  /\b(tomorrow|today|tonight|next week|demain|aujourd[''](hui)?|ce soir|la semaine prochaine)\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/i,
];

/**
 * Classify a memory's intent from its content + optional title/tags.
 * Returns 'other' if no pattern matches.
 */
export function classifyIntent(content: string, title?: string, tags?: string[]): Intent {
  const haystack = `${title ?? ''} ${content} ${(tags ?? []).join(' ')}`.slice(0, 2000);

  for (const p of CORRECTION_PATTERNS) if (p.test(haystack)) return 'correction';
  for (const p of PREFERENCE_PATTERNS) if (p.test(haystack)) return 'preference';
  for (const p of TEMPORAL_PATTERNS)   if (p.test(haystack)) return 'temporal';

  // Factual default: short statements with concrete subject/verb structure.
  // Anything left after the above filters is either factual (a "fact about X")
  // or 'other' (free-form text with no clear intent signal).
  if (haystack.length < 600 && /[A-Z][a-z]+ (is|are|was|were|has|have)/.test(content)) return 'factual';

  return 'other';
}

/**
 * Default importance heuristic — used when the agent doesn't specify one.
 * Corrections + preferences default to 'high' (user explicitly cared enough
 * to teach the agent something durable). Temporal defaults to 'medium'
 * (events fade naturally). Anything else 'medium'.
 */
export function defaultImportance(intent: Intent): Importance {
  if (intent === 'correction' || intent === 'preference') return 'high';
  return 'medium';
}
