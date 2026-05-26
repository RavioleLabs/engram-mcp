// src/memory/modules/parsers/index.ts
// Central registration point for all built-in parsers.
// Add new parsers here as separate imports + registerParser() calls.
import { registerParser } from '../../core/parsers.js';
import { releveBnpParser } from './releve-bnp.js';

let _registered = false;

/**
 * Idempotent — call once at server boot. Re-callable in tests.
 * (Tests that clear the registry should call this again to restore the
 * built-in parsers.)
 */
export function registerBuiltinParsers(): void {
  if (_registered) return;
  registerParser(releveBnpParser);
  _registered = true;
}

/** Test-only: reset the "already-registered" guard so registerBuiltinParsers re-runs. */
export function _resetBuiltinRegistrationGuard(): void {
  _registered = false;
}
