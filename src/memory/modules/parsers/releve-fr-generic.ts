// src/memory/modules/parsers/releve-fr-generic.ts
//
// Generic French bank statement parser. Covers the 12 major retail/business
// banks that don't have a dedicated parser (BNP is handled by releve-bnp.ts
// and matches first, so this falls through naturally).
//
// Banks recognized via header scan: Société Générale, Crédit Agricole, LCL
// (Le Crédit Lyonnais), Boursorama, Qonto, Revolut, N26, HSBC, Hello bank,
// Crédit Mutuel, La Banque Postale, Caisse d'Épargne. Extends easily — add
// the canonical name to BANK_NAMES below.
//
// Stress-test §R1 (specs/2026-05-25-engram-remaining-problems-v0.6.1.md):
// without a parser, free-text embedding collapses on bank statements because
// every relevé shares the same template (header / IBAN / table / total).
// Recall@10 was 42% at 622 docs across the test set. With this parser, all
// 13 banks in the fixture produce structured chunks with entity-rich titles
// + tags, mirroring the BNP path.

import type { MemoryParser, ParseResult } from '../../core/parsers.js';

// Ordered list of (canonical name, detection regex, slug). First match wins.
// Order: most-specific markers first to avoid false positives (e.g. "Crédit
// Agricole" before "Crédit Mutuel" because both contain "Crédit ").
const BANK_NAMES: Array<{ name: string; re: RegExp; slug: string }> = [
  { name: 'BNP Paribas', re: /\bBNP\s*PARIBAS\b/i, slug: 'bnp' }, // never reached (BNP parser first), kept for completeness
  { name: 'Société Générale', re: /\bSOCI[EÉ]T[EÉ]\s*G[EÉ]N[EÉ]RALE\b/i, slug: 'societe-generale' },
  {
    name: 'Crédit Agricole',
    re: /\bCR[EÉ]DIT\s*AGRICOLE\b/i,
    slug: 'credit-agricole',
  },
  {
    name: 'Crédit Mutuel',
    re: /\bCR[EÉ]DIT\s*MUTUEL\b/i,
    slug: 'credit-mutuel',
  },
  { name: 'LCL', re: /\bLCL\b|\bLE\s*CR[EÉ]DIT\s*LYONNAIS\b/i, slug: 'lcl' },
  {
    name: 'Boursorama Banque',
    re: /\bBOURSORAMA(?:\s*BANQUE)?\b/i,
    slug: 'boursorama',
  },
  { name: 'Qonto', re: /\bQONTO\b/i, slug: 'qonto' },
  { name: 'Revolut', re: /\bREVOLUT(?:\s*BANK)?\b/i, slug: 'revolut' },
  { name: 'N26', re: /\bN26(?:\s*BANK)?\b/i, slug: 'n26' },
  { name: 'HSBC', re: /\bHSBC(?:\s*CONTINENTAL\s*EUROPE)?\b/i, slug: 'hsbc' },
  { name: 'Hello bank!', re: /\bHELLO\s*BANK!?/i, slug: 'hello-bank' },
  {
    name: 'La Banque Postale',
    re: /\bLA\s*BANQUE\s*POSTALE\b/i,
    slug: 'la-banque-postale',
  },
  {
    name: "Caisse d'Épargne",
    re: /\bCAISSE\s*D[''’]?\s*[EÉ]PARGNE\b/i,
    slug: 'caisse-epargne',
  },
];

const IBAN_FR_RE = /\b(FR\d{2}\s?(?:\d{4}\s?){5}\d{3})\b/;
// Also accept foreign IBANs that may appear on Revolut/N26 statements with FR titulaire.
const IBAN_ANY_RE = /\b([A-Z]{2}\d{2}\s?(?:[A-Z0-9]\s?){10,30})\b/;

// "Titulaire : Name Surname" or "Titulaire: NAME SURNAME" — accept capital-letter
// names too (many statements show titulaires in ALL CAPS). Stop before "IBAN" or
// next field marker.
const HOLDER_RE =
  /(?:Titulaire\s*:|Compte\s+de\s+|(?:^|\n)\s*(?:M|Mme|Mlle)\.?\s+)\s*([A-ZÉÈÀÂÊÎÔÛÄËÏÖÜ][A-Za-zÉÈÀÂÊÎÔÛÄËÏÖÜéèàâêîôûäëïöü\-' ]{2,80}?)(?=\s*(?:IBAN|\n|$))/;

// "Période du 01/03/2024 au 31/03/2024" or "Période : 01/03/2024 au 31/03/2024"
const PERIOD_RE =
  /(?:P[eé]riode|du)\s*:?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+au\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i;

// Operation line patterns — French bank statements vary, so we try two:
// (a) Pipe-separated table: "01/03/2024 | LIBELLÉ | DEBIT | CREDIT"
//     → debit column means signed-negative; credit column means signed-positive.
const OP_PIPE_RE =
  /^\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*\|\s*(.{3,80}?)\s*\|\s*([\d\s.,]+)?\s*\|\s*([\d\s.,]+)?\s*$/;

// (b) Plain-space format: "01/03/2024  LIBELLÉ                      -89,50"
//     or "01/03/2024  LIBELLÉ                      +3 250,00"
const OP_SPACE_RE =
  /^\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+(.{3,80}?)\s+([+\-]?\s?[\d][\d\s.,]*)\s*€?\s*$/;

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
  // "-89,50" or "+1 234,56" or "1.234,56" or "8 500,00"
  const cleaned = s
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function detectBank(content: string): { name: string; slug: string } | null {
  // Only scan the first ~20 lines so we catch the header, not stray mentions
  // in transaction libellés (e.g. "VIR Société Générale" inside a relevé).
  const head = content.split('\n').slice(0, 20).join('\n');
  for (const b of BANK_NAMES) {
    if (b.re.test(head)) return { name: b.name, slug: b.slug };
  }
  return null;
}

/**
 * Heuristic for "this looks like a French bank statement we can parse".
 * Returns true when we find:
 *  - a recognized bank name in the first ~20 lines, AND
 *  - a French IBAN OR ≥5 operation-shaped lines.
 *
 * BNP content also matches this but the BNP-specific parser is registered
 * first in the registry so it wins via findParser()'s first-match rule.
 */
function canParseGeneric(content: string): boolean {
  if (content.length < 100 || content.length > 200_000) return false;
  if (!detectBank(content)) return false;
  if (IBAN_FR_RE.test(content) || IBAN_ANY_RE.test(content)) return true;
  // Fallback: enough operation-shaped lines = high confidence
  let opLines = 0;
  for (const line of content.split('\n')) {
    if (OP_PIPE_RE.test(line) || OP_SPACE_RE.test(line)) {
      opLines++;
      if (opLines >= 5) return true;
    }
  }
  return false;
}

interface Operation {
  date: string;
  libelle: string;
  montant: number;
}

function extractOperations(content: string): Operation[] {
  const ops: Operation[] = [];
  for (const line of content.split('\n')) {
    // Try pipe format first (more specific — table with explicit columns)
    let m = line.match(OP_PIPE_RE);
    if (m) {
      const date = parseFrDate(m[1]);
      const libelle = m[2].trim();
      const debit = m[3] ? parseFrAmount(m[3]) : null;
      const credit = m[4] ? parseFrAmount(m[4]) : null;
      if (!date || !libelle) continue;
      // Skip header rows that match the regex by accident
      if (/^(d[eé]bit|cr[eé]dit|montant|libell[eé]|date)$/i.test(libelle)) continue;
      let montant: number | null = null;
      if (credit !== null && credit !== 0) montant = credit;
      else if (debit !== null && debit !== 0) montant = -debit;
      else continue;
      ops.push({ date, libelle, montant });
      continue;
    }
    // Fall back to space format
    m = line.match(OP_SPACE_RE);
    if (m) {
      const date = parseFrDate(m[1]);
      const libelle = m[2].trim();
      const amount = parseFrAmount(m[3]);
      if (!date || !libelle || amount === null) continue;
      // Skip balance/total summary lines
      if (/^(solde|total|tot\.|nouv\.?\s*solde|frais\s+tenue|agio)/i.test(libelle)) continue;
      ops.push({ date, libelle, montant: amount });
    }
  }
  return ops;
}

export const releveFrGenericParser: MemoryParser = {
  id: 'releve-fr-generic-v1',
  type: 'releve_bancaire',
  canParse: canParseGeneric,

  parse(content: string): ParseResult | null {
    const bank = detectBank(content);
    if (!bank) return null;

    const ibanMatch = content.match(IBAN_FR_RE) || content.match(IBAN_ANY_RE);
    const holderMatch = content.match(HOLDER_RE);
    const periodMatch = content.match(PERIOD_RE);

    const holder = holderMatch ? holderMatch[1].trim().replace(/\s+/g, ' ') : 'inconnu';
    const iban = ibanMatch ? ibanMatch[1].replace(/\s/g, '') : null;
    const periodStart = periodMatch ? parseFrDate(periodMatch[1]) : null;
    const periodEnd = periodMatch ? parseFrDate(periodMatch[2]) : null;

    const operations = extractOperations(content);
    if (operations.length === 0) return null;

    const sortedDates = operations.map((o) => o.date).sort();
    const ps = periodStart ?? sortedDates[0];
    const pe = periodEnd ?? sortedDates[sortedDates.length - 1];
    const monthTag = ps?.slice(0, 7); // YYYY-MM

    const holderSlug = slugify(holder);
    const title = monthTag
      ? `Relevé ${bank.name} — ${holder} — ${monthTag}`
      : `Relevé ${bank.name} — ${holder}`;

    const tags = ['releve', `banque:${bank.slug}`, `titulaire:${holderSlug}`];
    if (monthTag) tags.push(`mois:${monthTag}`);

    // Subchunks: one per transaction. Same rationale as BNP parser — a query
    // about a specific operation hits THAT chunk directly.
    const subchunks = operations.map(
      (op) =>
        `${op.date}  ${op.libelle}  ${op.montant.toFixed(2)} EUR  ` +
        `[${holder} — Relevé ${bank.name} — ${monthTag ?? ''}]`,
    );

    return {
      title,
      tags,
      custom_fields: {
        bank: bank.name,
        bank_slug: bank.slug,
        iban,
        holder,
        period_start: ps,
        period_end: pe,
        n_operations: operations.length,
        operations,
        parsed_by: 'releve-fr-generic-v1',
      },
      content:
        `Relevé bancaire ${bank.name}\n` +
        `Titulaire: ${holder}\n` +
        (iban ? `IBAN: ${iban}\n` : '') +
        `Période: ${ps ?? '?'} → ${pe ?? '?'}\n` +
        `Opérations (${operations.length}):\n` +
        operations.map((o) => `  ${o.date}  ${o.libelle}  ${o.montant.toFixed(2)}€`).join('\n'),
      subchunks,
    };
  },
};
