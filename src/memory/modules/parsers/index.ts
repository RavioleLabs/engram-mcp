// src/memory/modules/parsers/index.ts
// Central registration point for all built-in parsers.
// Add new parsers here as separate imports + registerParser() calls.
import { registerParser } from '../../core/parsers.js';
import { releveBnpParser } from './releve-bnp.js';
import { releveFrGenericParser } from './releve-fr-generic.js';

let _registered = false;

/**
 * Idempotent — call once at server boot. Re-callable in tests.
 * (Tests that clear the registry should call this again to restore the
 * built-in parsers.)
 *
 * Order matters: BNP-specific parser registered FIRST so it wins on BNP
 * content via findParser()'s first-match rule. The generic FR parser then
 * catches the other 12 retail banks (LCL, SG, CA, CM, BoursoBank, Qonto,
 * Revolut, N26, HSBC, Hello bank, La Banque Postale, Caisse d'Épargne).
 */
export function registerBuiltinParsers(): void {
  if (_registered) return;
  registerParser(releveBnpParser);
  registerParser(releveFrGenericParser);
  _registered = true;
}

/** Test-only: reset the "already-registered" guard so registerBuiltinParsers re-runs. */
export function _resetBuiltinRegistrationGuard(): void {
  _registered = false;
}
