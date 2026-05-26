// src/memory/modules/parsers/releve-bnp.ts
//
// Reference parser for BNP Paribas account statements (relevé de compte).
// This is intentionally narrow and conservative — it only fires when content
// has the distinctive BNP markers, and it extracts a small set of high-signal
// fields. Other formats (LCL, SG, CA, CE, BoursoBank) each need their own
// parser following this same shape — see the comment at the bottom for the
// pattern recipe.
//
// The parser converts free-text-noisy bank statements into:
//   - title: "Relevé BNP — {titulaire} — {YYYY-MM}"  (3× FTS5 weight)
//   - tags:  ["releve", "banque:bnp", "titulaire:{slug}", "mois:{YYYY-MM}"]  (2× FTS5 weight)
//   - custom: { iban, holder, period_start, period_end, operations: [{date, libelle, montant}] }
//   - subchunks: one chunk per transaction line — each gets its own embedding +
//     vector entry, so a query mentioning a specific operation surfaces it
//     directly instead of being averaged with 30 sibling transactions.
//
// See specs/2026-05-25-engram-hallucination-study.md §"What this doesn't solve"
// for the rationale (template-noise collapse).

import type { MemoryParser, ParseResult } from '../../core/parsers.js';

const BNP_MARKER_RE = /\b(BNP\s*PARIBAS|BNPParibas)\b/i;
const IBAN_RE = /\b(FR\d{2}\s?(?:\d{4}\s?){5}\d{3})\b/;
// Match "Titulaire:" (with colon — strong signal) or salutations followed by a space
// then a Title-cased name (first letter upper, rest lower). The lower-case requirement
// on subsequent letters prevents matches against ALL-CAPS column headers like "MONTANT".
const HOLDER_RE =
  /(?:Titulaire\s*:|Compte\s+de\s+|(?:^|\n)\s*(?:M|Mme|Mlle)\.?\s+)\s*([A-ZÉÈÀÂÊÎÔÛÄËÏÖÜ][a-zéèàâêîôûäëïöü\-']+(?:\s+[A-ZÉÈÀÂÊÎÔÛÄËÏÖÜ][a-zéèàâêîôûäëïöü\-']+){0,3})/;
const PERIOD_RE =
  /(?:du|période\s+du|de)\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+(?:au|à)\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i;

// Operation line: DATE  LIBELLE  -AMOUNT  or  DATE  LIBELLE  +AMOUNT
// Common BNP formats: "12/03/2026  VIR SEPA EDF                    -89,50"
// We allow optional value-date column "12/03  13/03  ...".
const OP_LINE_RE =
  /^\s*(\d{2}[\/\-]\d{2}(?:[\/\-]\d{2,4})?)\s+(?:(\d{2}[\/\-]\d{2}(?:[\/\-]\d{2,4})?)\s+)?(.{4,80}?)\s+([+\-]?\s?[\d\s.,]+)\s*€?\s*$/;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function parseFrDate(s: string): string | null {
  const m = s.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const yyyy = m[3]
    ? m[3].length === 2
      ? `20${m[3]}`
      : m[3]
    : new Date().getFullYear().toString();
  return `${yyyy}-${mm}-${dd}`;
}

function parseFrAmount(s: string): number | null {
  // "-89,50" or "+1 234,56" or "1.234,56" — French format: comma decimal, space or dot thousand sep
  const cleaned = s
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

export const releveBnpParser: MemoryParser = {
  id: 'releve-bnp-v1',
  type: 'releve_bancaire',

  canParse(content: string): boolean {
    if (content.length < 100 || content.length > 200_000) return false;
    // Require BNP marker + at least one IBAN OR enough operation-shaped lines.
    if (!BNP_MARKER_RE.test(content)) return false;
    if (IBAN_RE.test(content)) return true;
    // Fallback: count operation-shaped lines.
    const opLines = content.split('\n').filter((line) => OP_LINE_RE.test(line));
    return opLines.length >= 5;
  },

  parse(content: string): ParseResult | null {
    const ibanMatch = content.match(IBAN_RE);
    const holderMatch = content.match(HOLDER_RE);
    const periodMatch = content.match(PERIOD_RE);

    const holder = holderMatch ? holderMatch[1].trim() : 'inconnu';
    const iban = ibanMatch ? ibanMatch[1].replace(/\s/g, '') : null;
    const periodStart = periodMatch ? parseFrDate(periodMatch[1]) : null;
    const periodEnd = periodMatch ? parseFrDate(periodMatch[2]) : null;

    // Extract operations
    const operations: Array<{ date: string; libelle: string; montant: number }> = [];
    for (const line of content.split('\n')) {
      const m = line.match(OP_LINE_RE);
      if (!m) continue;
      const date = parseFrDate(m[1]);
      const libelle = m[3].trim();
      const montant = parseFrAmount(m[4]);
      if (!date || !libelle || montant === null) continue;
      // Skip lines that look like balance / total summaries
      if (/^(solde|total|tot\.|nouv\.?\s*solde)/i.test(libelle)) continue;
      operations.push({ date, libelle, montant });
    }
    if (operations.length === 0) return null;

    // Period defaults to first/last operation date if not explicitly stated.
    const sortedDates = operations.map((o) => o.date).sort();
    const ps = periodStart ?? sortedDates[0];
    const pe = periodEnd ?? sortedDates[sortedDates.length - 1];
    const monthTag = ps?.slice(0, 7); // YYYY-MM

    // Title: stable, entity-rich. Engram weights this ×3 in FTS5.
    const title = monthTag ? `Relevé BNP — ${holder} — ${monthTag}` : `Relevé BNP — ${holder}`;

    // Tags: every entity-bearing token, ready for FTS5 + tag-overlap rerank.
    const tags = ['releve', 'banque:bnp', `titulaire:${slugify(holder)}`];
    if (monthTag) tags.push(`mois:${monthTag}`);

    // Subchunks: one per transaction. Each will be embedded individually so
    // a query mentioning a specific operation surfaces THAT chunk, not the
    // averaged signal of 30 sibling lines.
    const subchunks = operations.map(
      (op) =>
        `${op.date}  ${op.libelle}  ${op.montant.toFixed(2)} EUR  ` +
        `[${holder} — Relevé BNP — ${monthTag ?? ''}]`,
    );

    return {
      title,
      tags,
      custom_fields: {
        bank: 'BNP',
        iban,
        holder,
        period_start: ps,
        period_end: pe,
        n_operations: operations.length,
        operations,
        parsed_by: 'releve-bnp-v1',
      },
      // Content rewritten to a clean, agent-readable summary. Original raw
      // statement is preserved in custom_fields.operations[] for reconstruction.
      content:
        `Relevé bancaire BNP Paribas\n` +
        `Titulaire: ${holder}\n` +
        (iban ? `IBAN: ${iban}\n` : '') +
        `Période: ${ps ?? '?'} → ${pe ?? '?'}\n` +
        `Opérations (${operations.length}):\n` +
        operations.map((o) => `  ${o.date}  ${o.libelle}  ${o.montant.toFixed(2)}€`).join('\n'),
      subchunks,
    };
  },
};

// ─── Recipe for adding parsers for other banks ───────────────────────────────
// 1. Identify the bank's distinctive markers (header text, logo string, IBAN prefix).
// 2. Write a regex for the operation-line format (each bank has its own column layout).
// 3. Extract: holder name, IBAN, period, and the operation list.
// 4. Produce: title, tags (with `banque:<slug>` + `titulaire:<slug>` + `mois:YYYY-MM`),
//    custom_fields, subchunks (one per operation).
// 5. Register in src/memory/modules/parsers/index.ts.
// 6. Write a small fixture-based test in src/tests/parsers-*.test.ts.
//
// If you can't write a regex parser cheaply (e.g. PDFs with no text layer, scans),
// the LLM-fallback path takes over: engram's remember() returns a `parse_hint` in
// the response when content is unparsed but matches a known type. The agent
// (Claude/GPT) then reads the raw text, extracts the same fields itself, and
// re-calls remember() with properties.custom pre-populated. See SKILL.md
// "Ingesting tabular content (bank statements, invoices)" for the agent-side
// pattern.
