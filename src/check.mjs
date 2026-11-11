// Deterministic checks on a proposed fix. A fix (from a rule or from Claude) can only be approved
// if every check passes. The checks never call a model.
import { CATEGORIES } from './codes.mjs';
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
  if (!ex) return { ok: false, failures: [{ rule: 'open', detail: `exception ${fix.exception} is not open` }] };

  const cat = CATEGORIES[fix.category];
  if (!cat) fail('category', `unknown category "${fix.category}"`);

  const cites = { paypal: [...new Set(fix.cites?.paypal ?? [])], ledger: [...new Set(fix.cites?.ledger ?? [])] };
  const openP = new Set(), openL = new Set();
  for (const e of state.open.values()) { e.paypal.forEach((id) => openP.add(id)); e.ledger.forEach((id) => openL.add(id)); }
  for (const id of ex.paypal) if (!cites.paypal.includes(id)) fail('cites', `must cite its own PayPal transaction ${id}`);
  for (const id of ex.ledger) if (!cites.ledger.includes(id)) fail('cites', `must cite its own book line ${id}`);
  for (const id of cites.paypal) if (!openP.has(id)) fail('cites', `PayPal transaction ${id} is not part of an open exception`);
  for (const id of cites.ledger) if (!openL.has(id)) fail('cites', `book line ${id} is not part of an open exception`);

  let debit = 0, credit = 0, clearing = 0;
  const lines = fix.lines ?? [];
  if (!lines.length) fail('lines', 'the entry has no lines');
  for (const [i, l] of lines.entries()) {
    if (!(l.account in chart)) fail('account', `line ${i + 1}: account ${l.account} is not in the chart of accounts`);
    const d = l.debit ?? 0, c = l.credit ?? 0;
    if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0 || (d > 0) === (c > 0)) fail('line', `line ${i + 1}: needs exactly one positive whole-cent debit or credit`);
    debit += d; credit += c;
    if (l.account === CLEARING) clearing += d - c;
  }
  if (debit !== credit) fail('balanced', `debits ${debit} and credits ${credit} differ by ${debit - credit} cents`);

  if (!failures.some((f) => f.rule === 'cites')) {
    const gap = gapOf(cites, state.byP, state.byL);
    if (clearing !== gap) fail('closes_gap', `moves PayPal clearing by ${clearing} cents; the cited items leave a gap of ${gap} cents`);

    const txs = cites.paypal.map((id) => state.byP.get(id));
    if (cat) {
      if (cat.needs.length && !txs.some((t) => cat.needs.includes(t.kind))) fail('category_fits', `"${fix.category}" needs a cited PayPal transaction of kind ${cat.needs.join(' or ')}; cited kinds are ${txs.map((t) => t.kind).join(', ') || 'none'}`);
      if (!cat.needs.length && txs.length) fail('category_fits', `"${fix.category}" is about the books only and cannot cite PayPal transactions`);
      if (cat.books && !cites.ledger.length) fail('category_fits', `"${fix.category}" must cite a book line`);
      if (fix.category === 'fee_not_booked') {
        const fees = txs.reduce((s, t) => s + t.fee, 0);
        if (fees === 0) fail('category_fits', 'the cited transactions carry no PayPal fee');
        else if (gap !== fees) fail('category_fits', `the gap (${gap}) is not the cited fees (${fees}); something besides the fee is unbooked`);
      }
      const foreign = txs.filter((t) => t.currency !== (state.currency ?? 'USD'));
      if (foreign.length && fix.category !== 'fx_not_booked') fail('currency', `cites ${foreign.map((t) => `${t.id} (${t.currency})`).join(', ')} outside the books' currency without booking the conversion`);
    }
  }
  return { ok: failures.length === 0, failures };
}
