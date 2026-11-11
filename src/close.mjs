// One month's close: match, open exceptions, fixes, checks, approvals. Plain data in, plain data
// out, so the server can persist it as JSON and the tests can drive it directly.
import { match, tieOut, hints } from './match.mjs';
import { check, CLEARING, CHART } from './check.mjs';

export function openClose({ paypal, ledger, period, currency = 'USD', chart = CHART }) {
  const inPeriod = (d) => !period || d.startsWith(period);
  const base = paypal.filter((t) => t.currency === currency && inPeriod(t.date));
  const foreign = paypal.filter((t) => t.currency !== currency && inPeriod(t.date));
  const books = ledger.filter((l) => inPeriod(l.date));
  const { matches, exceptions } = match(base, books);
  const found = hints(exceptions, new Map(base.map((t) => [t.id, t])), new Map(books.map((l) => [l.id, l])));
  return {
    period, currency, chart,
    paypal: base, foreign, ledger: books, matches,
    outside: ledger.length - books.length, // book lines dated outside the period, left out of the close
    exceptions: exceptions.map((e) => ({ ...e, hints: found.get(e.id) ?? [], status: 'open', fix: null, check: null })),
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
  if (!ex || ex.status !== 'open') throw new Error(`${exceptionId} is not open`);
  ex.fix = { ...fix, exception: exceptionId };
  ex.check = check(ex.fix, stateOf(close), close.chart);
  return ex;
}

// Approving resolves the exception and every other open exception whose items the fix cites.
export function approve(close, exceptionId, by = 'reviewer') {
  const ex = close.exceptions.find((e) => e.id === exceptionId);
  if (!ex?.fix) throw new Error(`${exceptionId} has no proposed fix`);
  if (ex.status !== 'open') throw new Error(`${exceptionId} is already ${ex.status}`);
  const recheck = check(ex.fix, stateOf(close), close.chart);
  if (!recheck.ok) throw new Error(`${exceptionId}: the fix fails its checks: ${recheck.failures.map((f) => f.detail).join('; ')}`);
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

export function reject(close, exceptionId, reason = '') {
  const ex = close.exceptions.find((e) => e.id === exceptionId);
  if (!ex?.fix) throw new Error(`${exceptionId} has no proposed fix`);
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
  return { ...t, adjustments, matched: close.matches.length, open: count('open'), approved: count('approved'), covered: count('covered'), exceptions: close.exceptions.length };
}
