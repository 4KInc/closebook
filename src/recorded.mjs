// Recorded Claude proposals: what Claude actually proposed for a known month, saved from a real
// run (scripts/record.mjs) and committed under eval/. When live calls are unavailable (no API key,
// a call cap reached, or a call that fails), the server serves the recorded proposal instead, so
// Claude's part of the close is always visible. A recorded proposal is clearly labelled, and it
// goes through propose() like a live one: every check runs again, now, on this close.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = fileURLToPath(new URL('../eval/', import.meta.url));
const cache = new Map();

export const recordingName = (kind, period) => `recorded-${kind}-${period}.json`;

// The recording for a month, or null. kind is 'demo' or 'paypal' (closebook's sandbox account).
export function loadRecording(kind, period, dir = process.env.CLOSEBOOK_RECORDINGS ?? DEFAULT_DIR) {
  const file = join(dir, recordingName(kind, period));
  if (!cache.has(file)) {
    let rec = null;
    try { rec = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.warn(`[recorded] ${file}: ${e.message}`); }
    cache.set(file, rec);
  }
  return cache.get(file);
}

export function clearRecordingCache() { cache.clear(); }

// The recorded fix for one exception, only if it was recorded for exactly the same items: the
// same PayPal transactions and book lines. Anything else is a different situation.
export function recordedFix(rec, ex) {
  const same = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  const p = rec?.proposals?.find((x) => x.exception === ex.id && same(x.paypal, ex.paypal) && same(x.ledger, ex.ledger));
  if (!p) return null;
  return { ...structuredClone(p.fix), by: 'claude', recorded: { at: rec.recorded_at, model: p.fix.model ?? rec.model } };
}
