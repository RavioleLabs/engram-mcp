// src/tests/parsers-fr-generic.test.ts
//
// Tests the generic French bank statement parser (covers the 12 non-BNP retail
// banks in our stress-test fixture). Mirrors the BNP test pattern but exercises
// multiple banks to validate the canonical-name detection table.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  _clearParsersForTest,
  registerParser,
  findParser,
  applyParser,
} from '../memory/core/parsers.js';
import { releveBnpParser } from '../memory/modules/parsers/releve-bnp.js';
import { releveFrGenericParser } from '../memory/modules/parsers/releve-fr-generic.js';
import type { MemoryItem } from '../types.js';
import { ulid } from 'ulid';

// Realistic samples drawn from the stress-test fixture (one per non-BNP bank).
// Each is ~600-800 chars — enough to trigger ≥5 op-line detection.
const SAMPLE_LCL = `
LCL — LE CRÉDIT LYONNAIS
Agence Bordeaux Chartrons — 84 cours du Médoc, 33300 Bordeaux
Titulaire : Marianne BOUCHARD
IBAN : FR76 3002 0043 0000 3456 7890 123
Période du 01/03/2025 au 31/03/2025

DATE       LIBELLÉ                          MONTANT
03/03/2025 VIR NOTAIRE MAÎTRE DUPLESSIS    +45 000,00
04/03/2025 PRÉLÈVEMENT LOYER FONCIA           -850,00
05/03/2025 VIR SALAIRE BIBLIOTHÈQUE        +1 980,00
06/03/2025 PRÉLÈVEMENT EDF BORDEAUX           -115,00
07/03/2025 CB LECLERC MÉRIADECK                -98,70
17/03/2025 VIR PLACEMENT LIVRET A         -20 000,00
25/03/2025 VIR PLACEMENT ASSURANCE VIE    -10 000,00
27/03/2025 CB DARTY BORDEAUX                 -429,00
`.trim();

const SAMPLE_SG = `
SOCIÉTÉ GÉNÉRALE
Agence Lyon Part-Dieu — 21 cours Emile Zola, 69003 Lyon
Titulaire : CABINET DURANTON EXPERTISE COMPTABLE
IBAN : FR76 3003 0009 0000 5678 9012 345
Période du 01/03/2024 au 31/03/2024

OPÉRATIONS DU MOIS
DATE       | LIBELLÉ                         | DÉBIT     | CRÉDIT
01/03/2024 | PRÉLÈVEMENT LOYER BAIL COMMERCIAL | 2 100,00 |
04/03/2024 | VIR CLIENT BERTRAND & ASSOC.    |          | 900,00
05/03/2024 | PRÉLÈVEMENT EDF PRO              | 210,50   |
13/03/2024 | VIR CLIENT MENUISERIE MOREAU    |          | 450,00
22/03/2024 | VIR CLIENT CABINET ROSTAND      |          | 750,00
28/03/2024 | VIR CLIENT ASSURANCE LACROIX    |          | 320,00
31/03/2024 | FRAIS TENUE COMPTE PROF          | 18,00    |
`.trim();

const SAMPLE_REVOLUT = `
REVOLUT BANK UAB
Succursale France — 7 rue de la Paix, 75002 Paris
Titulaire : Inès KOWALSKI
IBAN : LT12 3250 0100 0123 4567
Période du 01/11/2024 au 30/11/2024

01/11/2024 VIR SALAIRE DIGITAL NOMAD AGENCY    +3 200,00
03/11/2024 PAIEMENT AIRBNB CHIANG MAI 14 NUITS  -780,00
04/11/2024 CHANGE THB REVOLUT                   -500,00
12/11/2024 CB BOOKING.COM HOTEL KOH SAMUI       -620,00
15/11/2024 CB SIAM PARAGON SHOPPING BANGKOK     -289,50
19/11/2024 CB AIR ASIA BANGKOK-PARIS CDG        -320,00
22/11/2024 PRÉLÈVEMENT LOYER PARIS NOVEMBRE     -950,00
`.trim();

const SAMPLE_QONTO = `
QONTO
18 rue de Navarin, 75009 Paris
Titulaire : LEAFCODE SAS — SIRET 891 234 567 00019
IBAN : FR76 1670 6000 4800 0012 3456 789
Période du 01/01/2025 au 31/01/2025

02/01/2025 VIR CLIENT ALTAIR SOLUTIONS SAS    +22 000,00
03/01/2025 PRÉLÈVEMENT LOYER BUREAUX WOJO       -890,00
06/01/2025 VIR SALAIRE HASSAN BENCHEKROUN     -4 200,00
07/01/2025 PRÉLÈVEMENT AWS                      -312,40
14/01/2025 PRÉLÈVEMENT URSSAF                 -1 890,00
15/01/2025 PRÉLÈVEMENT TVA MENSUELLE DGFiP    -3 200,00
20/01/2025 VIR CLIENT BUREAU VERITAS DIGITAL  +4 500,00
`.trim();

describe('releveFrGenericParser — canParse', () => {
  it('detects LCL statement', () => {
    expect(releveFrGenericParser.canParse(SAMPLE_LCL)).toBe(true);
  });

  it('detects Société Générale statement', () => {
    expect(releveFrGenericParser.canParse(SAMPLE_SG)).toBe(true);
  });

  it('detects Revolut statement', () => {
    expect(releveFrGenericParser.canParse(SAMPLE_REVOLUT)).toBe(true);
  });

  it('detects Qonto statement', () => {
    expect(releveFrGenericParser.canParse(SAMPLE_QONTO)).toBe(true);
  });

  it('rejects unrelated content', () => {
    expect(releveFrGenericParser.canParse('Grocery list: apples, bread, milk.')).toBe(false);
  });

  it('rejects content too short to be a statement', () => {
    expect(releveFrGenericParser.canParse('LCL — short doc no operations')).toBe(false);
  });

  it('rejects content with no recognized bank', () => {
    expect(
      releveFrGenericParser.canParse(
        'Some random text with IBAN FR76 3000 4000 5000 6000 7000 123 ' +
          'and 01/03/2025 ALPHA -10,00\n02/03/2025 BETA -20,00\n03/03/2025 GAMMA -30,00\n04/03/2025 DELTA -40,00\n05/03/2025 EPSILON -50,00',
      ),
    ).toBe(false);
  });
});

describe('releveFrGenericParser — parse', () => {
  it('extracts LCL fields correctly', () => {
    const r = releveFrGenericParser.parse(SAMPLE_LCL);
    expect(r).not.toBeNull();
    expect(r!.title).toContain('LCL');
    expect(r!.title).toContain('Marianne'); // holder bubbles into title
    expect(r!.title).toContain('2025-03');
    expect(r!.tags).toContain('banque:lcl');
    expect(r!.tags).toContain('mois:2025-03');
    expect(r!.tags.some((t) => t.startsWith('titulaire:marianne'))).toBe(true);
    expect(r!.custom_fields.bank).toBe('LCL');
    expect((r!.custom_fields.operations as unknown[]).length).toBeGreaterThanOrEqual(7);
    expect(r!.subchunks).toBeDefined();
    expect(r!.subchunks!.length).toBeGreaterThanOrEqual(7);
  });

  it('extracts Société Générale with pipe-separated table format', () => {
    const r = releveFrGenericParser.parse(SAMPLE_SG);
    expect(r).not.toBeNull();
    expect(r!.title).toContain('Société Générale');
    expect(r!.tags).toContain('banque:societe-generale');
    expect(r!.tags).toContain('mois:2024-03');
    expect((r!.custom_fields.operations as unknown[]).length).toBeGreaterThanOrEqual(5);
  });

  it('extracts Revolut with foreign IBAN', () => {
    const r = releveFrGenericParser.parse(SAMPLE_REVOLUT);
    expect(r).not.toBeNull();
    expect(r!.title).toContain('Revolut');
    expect(r!.tags).toContain('banque:revolut');
    expect(r!.custom_fields.holder).toBe('Inès KOWALSKI');
  });

  it('extracts Qonto for SAS holder', () => {
    const r = releveFrGenericParser.parse(SAMPLE_QONTO);
    expect(r).not.toBeNull();
    expect(r!.title).toContain('Qonto');
    expect(r!.tags).toContain('banque:qonto');
    // SIRET-bearing holder line is acceptable; just verify a non-empty holder
    expect(r!.custom_fields.holder).toBeTruthy();
  });

  it('produces subchunks with date + libelle + montant + holder context', () => {
    const r = releveFrGenericParser.parse(SAMPLE_LCL);
    expect(r!.subchunks!.length).toBeGreaterThan(0);
    const firstChunk = r!.subchunks![0];
    expect(firstChunk).toMatch(/\d{4}-\d{2}-\d{2}/); // ISO date
    expect(firstChunk).toContain('LCL'); // bank context preserved per-chunk
    expect(firstChunk).toContain('Marianne'); // holder context preserved per-chunk
    expect(firstChunk).toMatch(/EUR/);
  });
});

describe('parsers registry — BNP-vs-generic precedence', () => {
  beforeEach(() => {
    _clearParsersForTest();
    registerParser(releveBnpParser);
    registerParser(releveFrGenericParser);
  });

  it('BNP content → BNP parser wins (registered first)', () => {
    const bnp = SAMPLE_LCL.replace(/LCL.*\n/, 'BNP PARIBAS\n');
    const p = findParser('releve_bancaire', bnp);
    expect(p?.id).toBe('releve-bnp-v1');
  });

  it('LCL content → generic parser wins (BNP rejects)', () => {
    const p = findParser('releve_bancaire', SAMPLE_LCL);
    expect(p?.id).toBe('releve-fr-generic-v1');
  });

  it('Société Générale content → generic parser wins', () => {
    const p = findParser('releve_bancaire', SAMPLE_SG);
    expect(p?.id).toBe('releve-fr-generic-v1');
  });

  it('applyParser merges generic-parser fields into MemoryItem', () => {
    const item: MemoryItem = {
      id: ulid(),
      type: 'releve_bancaire',
      scope: 'personal',
      source_id: 'test',
      content: SAMPLE_LCL,
      content_hash: 'h',
      properties: {},
      wikilinks: [],
      related_ids: [],
      embedding_model: 'ollama/nomic-embed-text',
    };
    const { item: out, parsed_by, subchunks } = applyParser(item);
    expect(parsed_by).toBe('releve-fr-generic-v1');
    expect(out.properties.title).toContain('LCL');
    expect(out.properties.tags?.some((t) => t.startsWith('banque:'))).toBe(true);
    expect(subchunks).toBeDefined();
    expect(subchunks!.length).toBeGreaterThan(5);
  });
});
