// Deterministic checks on a proposed fix. A fix (from a rule or from Claude) can only be approved
// if every check passes. The checks never call a model.
import { CATEGORIES, KIND_WORDS } from './codes.mjs';
import { fmt } from './money.mjs';
import { gapOf } from './match.mjs';

export const CLEARING = '1010';

export const CHART = {
  '1000': 'Bank checking',
  '1010': 'PayPal clearing',
  '1210': 'PayPal funds on hold',
  '3999': 'Suspense',
  '4000': 'Sales',
  '4900': 'Refunds and returns',
  '5100': 'Contractor payouts',
  '6100': 'PayPal fees',
  '6150': 'Chargeback losses',
  '7100': 'Currency gain or loss',
};

// state: { byP: Map, byL: Map, open: Map<exceptionId, exception> }
export function check(fix, state, chart = CHART) {
  const failures = [];
  const fail = (rule, detail) => failures.push({ rule, detail });
  const ex = state.open.get(fix.exception);
  if (!ex) return { ok: false, failures: [{ rule: 'open', detail: 'This item is already done.' }] };

  const cat = CATEGORIES[fix.category];
  if (!cat) fail('category', `"${fix.category}" isn't a type of fix closebook knows.`);
  const label = cat?.label ?? fix.category;

  const cites = { paypal: [...new Set(fix.cites?.paypal ?? [])], ledger: [...new Set(fix.cites?.ledger ?? [])] };
  const openP = new Set(), openL = new Set();
  for (const e of state.open.values()) { e.paypal.forEach((id) => openP.add(id)); e.ledger.forEach((id) => openL.add(id)); }
  for (const id of ex.paypal) if (!cites.paypal.includes(id)) fail('cites', `It has to include this item's own PayPal payment (${id}).`);
  for (const id of ex.ledger) if (!cites.ledger.includes(id)) fail('cites', `It has to include this item's own line in your books (${id}).`);
  for (const id of cites.paypal) if (!openP.has(id)) fail('cites', state.byP.has(id) ? `PayPal payment ${id} has already been fixed by another approved fix.` : `PayPal payment ${id} isn't one of this month's items.`);
  for (const id of cites.ledger) if (!openL.has(id)) fail('cites', state.byL.has(id) ? `Line ${id} in your books has already been fixed by another approved fix.` : `Line ${id} isn't in your books for this month.`);
  // Approval settles every exception the entry touches, so an entry that cites one item of another
  // exception must cite all of them: otherwise it would settle that exception while moving
  // clearing by only part of its gap, and the close could end with nothing open and a difference.
  for (const e of state.open.values()) {
    if (e.id === ex.id) continue;
    const missing = [...e.paypal.filter((id) => !cites.paypal.includes(id)).map((id) => `PayPal payment ${id}`), ...e.ledger.filter((id) => !cites.ledger.includes(id)).map((id) => `line ${id} in your books`)];
    const touched = missing.length < e.paypal.length + e.ledger.length;
    if (touched && missing.length) fail('cites', `It includes part of another item (${e.id}). Include all of it (also ${missing.join(', ')}) or none of it.`);
  }

  let debit = 0, credit = 0, clearing = 0;
  const lines = fix.lines ?? [];
  if (!lines.length) fail('lines', 'The journal entry has no lines.');
  for (const [i, l] of lines.entries()) {
    if (!(l.account in chart)) fail('account', `Line ${i + 1}: account ${l.account} isn't in your chart of accounts.`);
    const d = l.debit ?? 0, c = l.credit ?? 0;
    if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0 || (d > 0) === (c > 0)) fail('line', `Line ${i + 1} needs an amount as either a debit or a credit, not both.`);
    debit += d; credit += c;
    if (l.account === CLEARING) clearing += d - c;
  }
  if (debit !== credit) fail('balanced', `Debits (${fmt(debit)}) and credits (${fmt(credit)}) are ${fmt(Math.abs(debit - credit))} apart; they have to be equal.`);

  if (!failures.some((f) => f.rule === 'cites')) {
    const gap = gapOf(cites, state.byP, state.byL);
    if (clearing !== gap) fail('closes_gap', `It changes PayPal in your books by ${fmt(clearing)}, but the difference to fix is ${fmt(gap)}.`);

    const txs = cites.paypal.map((id) => state.byP.get(id));
    if (cat) {
      if (cat.needs.length && !txs.some((t) => cat.needs.includes(t.kind))) fail('category_fits', `"${label}" needs ${cat.needs.map((k) => KIND_WORDS[k] ?? k).join(' or ')} from PayPal, but this fix includes ${txs.map((t) => KIND_WORDS[t.kind] ?? t.kind).join(', ') || 'nothing from PayPal'}.`);
      if (!cat.needs.length && txs.length) fail('category_fits', `"${label}" is about your books only, so it can't include PayPal payments.`);
      if (cat.books && !cites.ledger.length) fail('category_fits', `"${label}" has to include a line from your books.`);
      if (fix.category === 'fee_not_booked') {
        const fees = txs.reduce((s, t) => s + t.fee, 0);
        if (fees === 0) fail('category_fits', 'There is no PayPal fee on these payments.');
        else if (gap !== fees) fail('category_fits', `The difference (${fmt(gap)}) isn't the PayPal fee (${fmt(fees)}): something besides the fee is missing from your books.`);
      }
      const foreign = txs.filter((t) => t.currency !== (state.currency ?? 'USD'));
      if (foreign.length && fix.category !== 'fx_not_booked') fail('currency', `It includes money in ${[...new Set(foreign.map((t) => t.currency))].join(', ')} (${foreign.map((t) => t.id).join(', ')}) without booking the currency exchange.`);
    }
  }
  return { ok: failures.length === 0, failures };
}
