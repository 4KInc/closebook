// Deterministic matching of book lines to PayPal transactions. No model is involved here.
//
// Rule 1 (reference): the book line's ref equals the PayPal transaction ID, invoice ID or custom
//   field, and its amount equals the transaction's gross or net.
// Rule 2 (amount and date): the amount equals gross or net, the dates are at most WINDOW days
//   apart, and the pairing is the only candidate in both directions.
//
// Whatever is left becomes an exception. A line matched on gross leaves the PayPal fee unbooked;
// that is an exception too, and a rule (not a model) proposes its fix.
//
// Every exception carries a gap: PayPal net of the cited transactions minus the book amounts of
// the cited lines. The gaps of all open exceptions add up to the tie-out difference, so closing
// every exception with a fix that moves the clearing account by exactly its gap brings the
// difference to zero.

import { fmt } from './money.mjs';

export const WINDOW = 3;

const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

function basis(line, tx) {
  if (line.amount === tx.net) return 'net';
  if (line.amount === tx.gross) return 'gross';
  return null;
}

export function match(paypal, ledger) {
  const freeP = new Set(paypal.map((t) => t.id));
  const freeL = new Set(ledger.map((l) => l.id));
  const matches = [];
  const take = (line, tx, rule) => {
    freeP.delete(tx.id); freeL.delete(line.id);
    matches.push({ ledger: line.id, paypal: tx.id, rule, basis: basis(line, tx) });
  };

  for (const line of ledger) {
    if (!line.ref) continue;
    const tx = paypal.find((t) => freeP.has(t.id) && [t.id, t.invoice, t.custom].includes(line.ref) && basis(line, t));
    if (tx) take(line, tx, 'reference');
  }

  const candidates = (line) => paypal.filter((t) => freeP.has(t.id) && basis(line, t) && days(line.date, t.date) <= WINDOW);
  for (const line of ledger) {
    if (!freeL.has(line.id)) continue;
    const c = candidates(line);
    if (c.length !== 1) continue;
    const back = ledger.filter((l) => freeL.has(l.id) && basis(l, c[0]) && days(l.date, c[0].date) <= WINDOW);
    if (back.length === 1) take(line, c[0], 'amount_date');
  }

  const byP = new Map(paypal.map((t) => [t.id, t]));
  const byL = new Map(ledger.map((l) => [l.id, l]));
  const exceptions = [];
  for (const m of matches) {
    const tx = byP.get(m.paypal), line = byL.get(m.ledger);
    if (tx.net !== line.amount) exceptions.push({ id: `X-${m.ledger}`, source: 'fee', paypal: [tx.id], ledger: [line.id], gap: tx.net - line.amount });
  }
  for (const t of paypal) if (freeP.has(t.id)) exceptions.push({ id: `X-${t.id}`, source: 'paypal', paypal: [t.id], ledger: [], gap: t.net });
  for (const l of ledger) if (freeL.has(l.id)) exceptions.push({ id: `X-${l.id}`, source: 'books', paypal: [], ledger: [l.id], gap: -l.amount });

  return { matches, exceptions, tieOut: tieOut(paypal, ledger) };
}

export function tieOut(paypal, ledger, adjustments = 0) {
  const paypalNet = paypal.reduce((s, t) => s + t.net, 0);
  const books = ledger.reduce((s, l) => s + l.amount, 0) + adjustments;
  return { paypalNet, books, difference: paypalNet - books };
}

// True when two amounts differ only by two adjacent digits swapped: $1,980.00 keyed as $1,890.00.
// Such a difference is always a multiple of 9 cents (of 9 times a power of ten).
export function transposed(a, b) {
  if (a === b || Math.sign(a) !== Math.sign(b)) return false;
  const x = String(Math.abs(a)), y = String(Math.abs(b));
  if (x.length !== y.length) return false;
  const diff = [...x].map((c, i) => (c === y[i] ? -1 : i)).filter((i) => i >= 0);
  return diff.length === 2 && diff[1] === diff[0] + 1 && x[diff[0]] === y[diff[1]] && x[diff[1]] === y[diff[0]];
}

// Hints for the reviewer and for Claude, found by code: an unmatched book line whose amount is a
// digit transposition of an unmatched PayPal transaction's net or gross within the date window.
// A hint is a pointer, not a match; the reviewer still approves the fix.
export function hints(exceptions, byP, byL) {
  const out = new Map();
  const add = (id, h) => out.set(id, [...(out.get(id) ?? []), h]);
  const onlyP = exceptions.filter((e) => e.source === 'paypal'), onlyL = exceptions.filter((e) => e.source === 'books');
  for (const eL of onlyL) {
    const l = byL.get(eL.ledger[0]);
    for (const eP of onlyP) {
      const t = byP.get(eP.paypal[0]);
      if (days(l.date, t.date) > WINDOW) continue;
      const amt = [t.net, t.gross].find((v) => transposed(v, l.amount));
      if (amt === undefined) continue;
      add(eL.id, { kind: 'transposition', with: eP.id, detail: `booked ${fmt(l.amount)}; PayPal ${t.id} shows ${fmt(amt)}: two adjacent digits swapped` });
      add(eP.id, { kind: 'transposition', with: eL.id, detail: `PayPal shows ${fmt(amt)}; book line ${l.id} has ${fmt(l.amount)}: two adjacent digits swapped` });
    }
  }
  return out;
}

// The gap of any set of open items, for a fix that cites more than one.
export function gapOf({ paypal = [], ledger = [] }, byP, byL) {
  return paypal.reduce((s, id) => s + byP.get(id).net, 0) - ledger.reduce((s, id) => s + byL.get(id).amount, 0);
}
