// One month's close: match, open exceptions, fixes, checks, approvals. Plain data in, plain data
// out, so the server can persist it as JSON and the tests can drive it directly.
import { match, tieOut, hints } from './match.mjs';
import { check, CLEARING, CHART } from './check.mjs';
import { untrustedFlags } from './untrusted.mjs';

export function openClose({ paypal, ledger, period, currency = 'USD', chart = CHART, balances = null, disputes = {} }) {
  const inPeriod = (d) => !period || d.startsWith(period);
  const base = paypal.filter((t) => t.currency === currency && inPeriod(t.date));
  const foreign = paypal.filter((t) => t.currency !== currency && inPeriod(t.date));
  const books = ledger.filter((l) => inPeriod(l.date));
  const { matches, exceptions } = match(base, books);
  const byP = new Map(base.map((t) => [t.id, t])), byL = new Map(books.map((l) => [l.id, l]));
  const found = hints(exceptions, byP, byL);
  const flagged = untrustedFlags(exceptions, byP, byL);
  return {
    period, currency, chart,
    disputes, // { originalTransactionId: [dispute rows] } from the Disputes API, for holds and chargebacks
    balances, // PayPal's own opening and closing balance, when read: { opening, closing } from balanceRow
    paypal: base, foreign, ledger: books, matches,
    outside: ledger.length - books.length, // book lines dated outside the period, left out of the close
    exceptions: exceptions.map((e) => ({ ...e, hints: found.get(e.id) ?? [], flags: flagged.get(e.id) ?? [], status: 'open', fix: null, check: null })),
    decisions: [],
  };
}

export function stateOf(close) {
  return {
    byP: new Map(close.paypal.map((t) => [t.id, t])),
    byL: new Map(close.ledger.map((l) => [l.id, l])),
    open: new Map(close.exceptions.filter((e) => e.status === 'open').map((e) => [e.id, e])),
    currency: close.currency,
  };
}

// The one fix a rule can make without a model: a sale booked at gross whose PayPal fee is missing.
export function ruleFix(close, ex) {
  if (ex.source !== 'fee') return null;
  const tx = close.paypal.find((t) => t.id === ex.paypal[0]);
  const fee = -ex.gap;
  const lines = fee > 0
    ? [{ account: '6100', debit: fee, credit: 0 }, { account: CLEARING, debit: 0, credit: fee }]
    : [{ account: CLEARING, debit: -fee, credit: 0 }, { account: '6100', debit: 0, credit: -fee }];
  return {
    exception: ex.id, by: 'rule', category: 'fee_not_booked',
    cites: { paypal: [...ex.paypal], ledger: [...ex.ledger] },
    lines,
    memo: `PayPal fee on ${tx.id}`,
    explanation: `The books recorded the gross ${tx.gross / 100}; PayPal paid out net ${tx.net / 100}. The difference is PayPal's fee.`,
  };
}

export function propose(close, exceptionId, fix) {
  const ex = close.exceptions.find((e) => e.id === exceptionId);
  if (!ex || ex.status !== 'open') throw new Error('This item is already done.');
  ex.fix = { ...fix, exception: exceptionId };
  ex.check = check(ex.fix, stateOf(close), close.chart);
  return ex;
}

// Approving resolves the exception and every other open exception whose items the fix cites.
export function approve(close, exceptionId, by = 'reviewer') {
  const ex = close.exceptions.find((e) => e.id === exceptionId);
  if (!ex?.fix) throw new Error('There\'s no fix to approve yet.');
  if (ex.status !== 'open') throw new Error('This item is already done.');
  const recheck = check(ex.fix, stateOf(close), close.chart);
  if (!recheck.ok) throw new Error(`This fix hasn't passed its double-checks yet: ${recheck.failures.map((f) => f.detail).join(' ')}`);
  const citedP = new Set(ex.fix.cites.paypal), citedL = new Set(ex.fix.cites.ledger);
  for (const e of close.exceptions) {
    if (e.status !== 'open') continue;
    if (e === ex || e.paypal.some((id) => citedP.has(id)) || e.ledger.some((id) => citedL.has(id))) {
      e.status = e === ex ? 'approved' : 'covered';
      if (e === ex) { e.approvedAt = new Date().toISOString(); e.approvedBy = by; }
      if (e !== ex) e.coveredBy = ex.id;
    }
  }
  // Other pending fixes may cite items this one just settled; re-check them now so the reviewer
  // sees at once which proposals no longer hold.
  const st = stateOf(close);
  for (const e of close.exceptions) if (e.status === 'open' && e.fix) e.check = check(e.fix, st, close.chart);
  close.decisions.push({ exception: ex.id, verdict: 'approved', category: ex.fix.category, by: ex.fix.by, memo: ex.fix.memo, at: ex.approvedAt, reviewer: by });
  return ex;
}

const entryText = (lines) => lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.account} ${l.debit || l.credit}`).join(', ');

// The reviewer corrects a proposed entry instead of rejecting it: a different account, an amount,
// a line more or less, another category. The checks run again at once, and the change is kept on
// the entry (what it was before), in the audit trail, and in the AI's next prompt.
export function edit(close, exceptionId, changes, by = 'reviewer') {
  const ex = close.exceptions.find((e) => e.id === exceptionId);
  if (!ex?.fix) throw new Error('There\'s no fix to change yet.');
  if (ex.status !== 'open') throw new Error('This item is already done.');
  const before = ex.fix;
  const original = before.original ?? { category: before.category, lines: before.lines, memo: before.memo, cites: before.cites };
  const next = {
    ...before,
    category: changes.category ?? before.category,
    lines: changes.lines ?? before.lines,
    memo: changes.memo ?? before.memo,
    cites: changes.cites ?? before.cites,
  };
  const citeText = (c) => [...(c?.paypal ?? []), ...(c?.ledger ?? [])].join(' ');
  const same = next.category === original.category && next.memo === original.memo && entryText(next.lines) === entryText(original.lines) && citeText(next.cites) === citeText(original.cites ?? before.cites);
  const fix = same ? { ...next, original: undefined, editedBy: undefined, editedAt: undefined } : { ...next, original, editedBy: by, editedAt: new Date().toISOString() };
  propose(close, exceptionId, fix);
  const what = same ? `reverted to the ${before.by === 'claude' ? 'AI' : 'rule'}'s entry` : [
    original.category !== fix.category ? `category ${original.category} to ${fix.category}` : '',
    entryText(original.lines) !== entryText(fix.lines) ? `entry from ${entryText(original.lines)} to ${entryText(fix.lines)}` : '',
    citeText(original.cites ?? fix.cites) !== citeText(fix.cites) ? `cited items from ${citeText(original.cites)} to ${citeText(fix.cites)}` : '',
  ].filter(Boolean).join('; ');
  // One audit row per exception for a run of edits: the latest replaces the one before it.
  const last = close.decisions.at(-1);
  const row = { exception: ex.id, verdict: 'edited', category: fix.category, by: before.by, memo: fix.memo, reason: `changed ${what}`.replace('changed reverted', 'reverted'), at: new Date().toISOString(), reviewer: by };
  if (last?.verdict === 'edited' && last.exception === ex.id) close.decisions[close.decisions.length - 1] = row; else close.decisions.push(row);
  return ex;
}

export function reject(close, exceptionId, reason = '') {
  const ex = close.exceptions.find((e) => e.id === exceptionId);
  if (!ex?.fix) throw new Error('There\'s no fix to reject yet.');
  close.decisions.push({ exception: ex.id, verdict: 'rejected', category: ex.fix.category, by: ex.fix.by, memo: ex.fix.memo, reason, at: new Date().toISOString() });
  ex.rejected = [...(ex.rejected ?? []), { fix: ex.fix, reason }];
  ex.fix = null; ex.check = null;
  return ex;
}

export function journal(close) {
  return close.exceptions.filter((e) => e.status === 'approved').map((e) => ({ exception: e.id, ...e.fix, approvedAt: e.approvedAt, approvedBy: e.approvedBy, covers: close.exceptions.filter((x) => x.coveredBy === e.id).map((x) => x.id) }));
}

export function summary(close) {
  const adjustments = journal(close).reduce((s, f) => s + f.lines.reduce((a, l) => a + (l.account === CLEARING ? (l.debit ?? 0) - (l.credit ?? 0) : 0), 0), 0);
  const t = tieOut(close.paypal, close.ledger, adjustments);
  const count = (s) => close.exceptions.filter((e) => e.status === s).length;
  // PayPal's balance must move by exactly the net of the transactions read: a second, independent
  // check that Transaction Search returned the whole period.
  const b = close.balances;
  const balance = b?.opening && b?.closing ? { opening: b.opening, closing: b.closing, moved: b.closing.total - b.opening.total, activity: t.paypalNet, gap: b.closing.total - b.opening.total - t.paypalNet } : null;
  return { ...t, balance, adjustments, matched: close.matches.length, open: count('open'), approved: count('approved'), covered: count('covered'), exceptions: close.exceptions.length };
}

// The transactions whose disputes are worth reading: the originals that holds and chargebacks
// refer to.
export function disputedIds(paypal) {
  return paypal.filter((t) => (t.kind === 'hold' || t.kind === 'reversal') && t.ref).map((t) => t.ref);
}
