import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, fmt } from '../src/money.mjs';
import { paypalRows, ledgerRows, parseCsv, balanceRow } from '../src/normalize.mjs';
import { match } from '../src/match.mjs';
import { check, CLEARING } from '../src/check.mjs';
import { openClose, stateOf, ruleFix, propose, approve, reject, edit, summary, journal } from '../src/close.mjs';
import { demoMonth } from '../src/demo.mjs';
import { kindOf } from '../src/codes.mjs';

const demo = () => { const d = demoMonth(); return { d, close: openClose({ paypal: paypalRows(d.transaction_details), ledger: ledgerRows(d.ledgerCsv), period: d.period }) }; };
const closeFees = (close) => { for (const e of close.exceptions.filter((x) => x.source === 'fee')) { propose(close, e.id, ruleFix(close, e)); approve(close, e.id); } };

test('money parses and formats whole cents without floats', () => {
  assert.equal(cents('1,980.00'), 198000);
  assert.equal(cents('-0.49'), -49);
  assert.equal(cents('(12.5)'), -1250);
  assert.equal(cents('$7'), 700);
  assert.equal(cents('-$1,980.00'), -198000);
  assert.throws(() => cents('5-'));
  assert.throws(() => cents('(5'));
  assert.throws(() => cents('-(5)'));
  assert.throws(() => cents('12.345'));
  assert.throws(() => cents('abc'));
  assert.equal(fmt(-198000), '-$1,980.00');
});

test('CSV parser handles quotes, commas and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.throws(() => ledgerRows('date,memo\n2026-10-01,x'), /amount/);
});

test('the books CSV is refused with row numbers when dates, amounts or ids are wrong', () => {
  assert.throws(() => ledgerRows('date,amount\n10/05/2026,12.00'), /row 2: date "10\/05\/2026" is not YYYY-MM-DD/);
  assert.throws(() => ledgerRows('date,amount\n2026-10-05,'), /row 2: amount is blank/);
  assert.throws(() => ledgerRows('date,amount\n2026-10-05,1-2'), /row 2: amount "1-2"/);
  assert.throws(() => ledgerRows('id,date,amount\nA,2026-10-05,1\nA,2026-10-06,2'), /row 3: id "A" is used twice/);
  const e = (() => { try { ledgerRows('date,amount\nx,1\ny,2\nz,'); } catch (err) { return err.message; } })();
  assert.match(e, /^4 problems/);
  assert.deepEqual(ledgerRows('id,date,amount\nA,2026-10-05T10:00:00Z,"(1,234.50)"').map((l) => [l.date, l.amount]), [['2026-10-05', -123450]]);
});

test('book lines outside the period are counted, not silently dropped', () => {
  const c = openClose({ paypal: [], ledger: ledgerRows('date,amount\n2026-10-05,1\n2026-09-30,2'), period: '2026-10' });
  assert.equal(c.ledger.length, 1);
  assert.equal(c.outside, 1);
});

test('event codes map to kinds', () => {
  assert.equal(kindOf('T0006'), 'payment');
  assert.equal(kindOf('T1107'), 'refund');
  assert.equal(kindOf('T1201'), 'reversal');
  assert.equal(kindOf('T1110'), 'hold');
  assert.equal(kindOf('T0400'), 'transfer');
  assert.equal(kindOf('T0001'), 'payout');
  assert.equal(kindOf('T9999'), 'other');
});

test('the gaps of all exceptions add up to the tie-out difference', () => {
  const { close } = demo();
  const s = summary(close);
  assert.notEqual(s.difference, 0);
  assert.equal(close.exceptions.reduce((a, e) => a + e.gap, 0), s.difference);
});

test('matching: reference first, then a unique amount and date', () => {
  const p = [
    { id: 'A', net: 9651, gross: 10000, fee: -349, date: '2026-10-02', invoice: 'INV-1', kind: 'payment', currency: 'USD' },
    { id: 'B', net: 5000, gross: 5000, fee: 0, date: '2026-10-05', kind: 'payment', currency: 'USD' },
    { id: 'C', net: 5000, gross: 5000, fee: 0, date: '2026-10-06', kind: 'payment', currency: 'USD' },
  ];
  const l = [
    { id: 'L1', date: '2026-10-09', amount: 10000, ref: 'INV-1' }, // outside the date window, but the reference matches
    { id: 'L2', date: '2026-10-05', amount: 5000, ref: null },      // two candidates (B and C): left open
  ];
  const r = match(p, l);
  assert.deepEqual(r.matches, [{ ledger: 'L1', paypal: 'A', rule: 'reference', basis: 'gross' }]);
  assert.deepEqual(r.exceptions.map((e) => [e.id, e.source, e.gap]), [['X-L1', 'fee', -349], ['X-B', 'paypal', 5000], ['X-C', 'paypal', 5000], ['X-L2', 'books', -5000]]);
});

test('every planted mistake is left open for review, none is silently matched', () => {
  const { d, close } = demo();
  const openP = new Set(close.exceptions.flatMap((e) => e.paypal));
  const openL = new Set(close.exceptions.flatMap((e) => e.ledger));
  for (const p of d.planted) {
    if (p.paypal) assert.ok(openP.has(p.paypal), `${p.kind} ${p.paypal} should be open`);
    if (p.ledger) assert.ok(openL.has(p.ledger), `${p.kind} ${p.ledger} should be open`);
  }
});

test('rule fixes for unbooked fees pass the checks and move the difference by the fees', () => {
  const { close } = demo();
  const before = summary(close).difference;
  const fees = close.exceptions.filter((e) => e.source === 'fee').reduce((a, e) => a + e.gap, 0);
  closeFees(close);
  assert.equal(summary(close).difference, before - fees);
  assert.ok(journal(close).every((f) => f.by === 'rule' && f.category === 'fee_not_booked'));
});

function setup() {
  const { close } = demo();
  closeFees(close);
  const ex = (pred) => close.exceptions.find((e) => e.status === 'open' && pred(e));
  return { close, ex };
}

test('checks reject an unbalanced entry', () => {
  const { close, ex } = setup();
  const e = ex((x) => x.source === 'paypal' && stateOf(close).byP.get(x.paypal[0]).kind === 'payout');
  const r = check({ exception: e.id, category: 'payout_not_booked', cites: { paypal: e.paypal, ledger: [] }, lines: [{ account: '5100', debit: -e.gap, credit: 0 }, { account: CLEARING, debit: 0, credit: -e.gap - 1 }] }, stateOf(close));
  assert.ok(r.failures.some((f) => f.rule === 'balanced'));
});

test('checks reject an entry that does not close the gap', () => {
  const { close, ex } = setup();
  const e = ex((x) => x.source === 'paypal' && stateOf(close).byP.get(x.paypal[0]).kind === 'payout');
  const amt = -e.gap - 50; // books the payout but forgets its fee
  const r = check({ exception: e.id, category: 'payout_not_booked', cites: { paypal: e.paypal, ledger: [] }, lines: [{ account: '5100', debit: amt, credit: 0 }, { account: CLEARING, debit: 0, credit: amt }] }, stateOf(close));
  assert.deepEqual(r.failures.map((f) => f.rule), ['closes_gap']);
});

test('checks reject a category the cited transactions do not support', () => {
  const { close, ex } = setup();
  const e = ex((x) => x.source === 'paypal' && stateOf(close).byP.get(x.paypal[0]).kind === 'payout');
  const r = check({ exception: e.id, category: 'refund_not_booked', cites: { paypal: e.paypal, ledger: [] }, lines: [{ account: '4900', debit: -e.gap, credit: 0 }, { account: CLEARING, debit: 0, credit: -e.gap }] }, stateOf(close));
  assert.deepEqual(r.failures.map((f) => f.rule), ['category_fits']);
});

test('checks reject unknown accounts, foreign citations and dropping the own item', () => {
  const { close, ex } = setup();
  const e = ex((x) => x.source === 'books');
  const r = check({ exception: e.id, category: 'not_in_paypal', cites: { paypal: [], ledger: ['NOPE'] }, lines: [{ account: '9999', debit: 1, credit: 0 }, { account: CLEARING, debit: 0, credit: 1 }] }, stateOf(close));
  const rules = r.failures.map((f) => f.rule);
  assert.ok(rules.includes('account'));
  assert.ok(rules.includes('cites'));
  assert.equal(r.failures.filter((f) => f.rule === 'cites').length, 2);
});

test('a fix can settle several exceptions at once, and approval re-runs the checks', () => {
  const { close, ex } = setup();
  const st = stateOf(close);
  const hold = ex((x) => x.paypal.length && st.byP.get(x.paypal[0]).code === 'T1110');
  const release = ex((x) => x.paypal.length && st.byP.get(x.paypal[0]).code === 'T1111');
  const a = -hold.gap;
  propose(close, hold.id, { by: 'claude', category: 'hold_not_booked', cites: { paypal: [...hold.paypal, ...release.paypal], ledger: [] }, lines: [{ account: '1210', debit: a, credit: 0 }, { account: CLEARING, debit: 0, credit: a }, { account: CLEARING, debit: a, credit: 0 }, { account: '1210', debit: 0, credit: a }], memo: 'hold and release' });
  assert.equal(hold.check.ok, true);
  approve(close, hold.id);
  assert.equal(release.status, 'covered');
  assert.equal(release.coveredBy, hold.id);
});

test('an entry that cites part of another exception fails; citing all of it keeps the gaps adding up', () => {
  const { close } = demo(); // fee exceptions still open
  const ex = (pred) => close.exceptions.find(pred);
  const st = stateOf(close);
  const refund = ex((x) => x.source === 'paypal' && st.byP.get(x.paypal[0]).kind === 'refund' && close.exceptions.some((f) => f.source === 'fee' && f.paypal[0] === st.byP.get(x.paypal[0]).ref));
  const sale = st.byP.get(st.byP.get(refund.paypal[0]).ref);
  const feeEx = close.exceptions.find((f) => f.source === 'fee' && f.paypal[0] === sale.id);
  const entry = (cites) => {
    const g = cites.paypal.reduce((s, id) => s + st.byP.get(id).net, 0) - cites.ledger.reduce((s, id) => s + st.byL.get(id).amount, 0);
    return { by: 'claude', category: 'refund_not_booked', cites, memo: 'refund', lines: g >= 0 ? [{ account: CLEARING, debit: g, credit: 0 }, { account: '4900', debit: 0, credit: g }] : [{ account: '4900', debit: -g, credit: 0 }, { account: CLEARING, debit: 0, credit: -g }] };
  };
  // The sale's PayPal transaction alone: would settle the fee exception for less than its gap.
  propose(close, refund.id, entry({ paypal: [...refund.paypal, sale.id], ledger: [] }));
  assert.equal(refund.check.ok, false);
  assert.match(refund.check.failures.map((f) => f.detail).join(' '), new RegExp(`part of exception ${feeEx.id}`));
  // The whole fee exception: allowed, and the open gaps still add up to the difference.
  propose(close, refund.id, entry({ paypal: [...refund.paypal, sale.id], ledger: [...feeEx.ledger] }));
  assert.equal(refund.check.ok, true, JSON.stringify(refund.check.failures));
  approve(close, refund.id);
  assert.equal(feeEx.status, 'covered');
  const open = close.exceptions.filter((e) => e.status === 'open').reduce((s, e) => s + e.gap, 0);
  assert.equal(open, summary(close).difference);
});

test('approval refuses a fix whose checks fail, and rejection records the reason', () => {
  const { close, ex } = setup();
  const e = ex((x) => x.source === 'books');
  propose(close, e.id, { by: 'claude', category: 'not_in_paypal', cites: { paypal: [], ledger: e.ledger }, lines: [{ account: '1000', debit: 1, credit: 0 }, { account: CLEARING, debit: 0, credit: 1 }], memo: 'wrong amount' });
  assert.equal(e.check.ok, false);
  assert.throws(() => approve(close, e.id), /fails its checks/);
  reject(close, e.id, 'that was a cash sale, move it to the bank');
  assert.equal(e.fix, null);
  assert.equal(close.decisions.at(-1).reason, 'that was a cash sale, move it to the bank');
});

test('correct fixes for every planted mistake bring the difference to zero', () => {
  const { close } = setup();
  const st = stateOf(close);
  const fixFor = (e) => {
    const g = e.gap;
    const cr = (acct, a) => (a >= 0 ? [{ account: CLEARING, debit: a, credit: 0 }, { account: acct, debit: 0, credit: a }] : [{ account: acct, debit: -a, credit: 0 }, { account: CLEARING, debit: 0, credit: -a }]);
    if (e.ledger.length && !e.paypal.length) return { category: 'not_in_paypal', cites: { paypal: [], ledger: e.ledger }, lines: cr('3999', g) };
    const t = st.byP.get(e.paypal[0]);
    const cat = { refund: 'refund_not_booked', reversal: 'reversal_not_booked', hold: 'hold_not_booked', payout: 'payout_not_booked', transfer: 'transfer_not_booked', payment: 'sale_not_booked' }[t.kind];
    return { category: cat, cites: { paypal: e.paypal, ledger: [] }, lines: cr('3999', g) };
  };
  for (const e of close.exceptions.filter((x) => x.status === 'open')) {
    if (e.status !== 'open') continue;
    propose(close, e.id, { by: 'test', ...fixFor(e) });
    assert.equal(e.check.ok, true, JSON.stringify(e.check.failures));
    approve(close, e.id);
  }
  const s = summary(close);
  assert.equal(s.open, 0);
  assert.equal(s.difference, 0);
});

test("PayPal's balance must move by exactly the net of the transactions read", () => {
  const d = demoMonth();
  const balances = { opening: balanceRow(d.balances.opening), closing: balanceRow(d.balances.closing) };
  const full = openClose({ paypal: paypalRows(d.transaction_details), ledger: [], period: d.period, balances });
  assert.equal(summary(full).balance.gap, 0);
  // Drop one transaction, as if Transaction Search had missed it: the balance check shows exactly it.
  const missing = paypalRows(d.transaction_details).slice(1);
  const lost = paypalRows(d.transaction_details)[0];
  const part = openClose({ paypal: missing, ledger: [], period: d.period, balances });
  assert.equal(summary(part).balance.gap, lost.net);
  assert.equal(summary(openClose({ paypal: missing, ledger: [], period: d.period })).balance, null);
});

test('the reviewer can correct an entry: the checks re-run, the change is audited, and it can be reverted', () => {
  const { close, ex } = setup();
  const e = ex((x) => x.source === 'paypal' && stateOf(close).byP.get(x.paypal[0]).kind === 'payout');
  const fee = -stateOf(close).byP.get(e.paypal[0]).fee, gross = -stateOf(close).byP.get(e.paypal[0]).gross;
  propose(close, e.id, { by: 'claude', category: 'payout_not_booked', cites: { paypal: e.paypal, ledger: [] }, memo: 'payout', lines: [{ account: '3999', debit: -e.gap, credit: 0 }, { account: CLEARING, debit: 0, credit: -e.gap }] });
  assert.equal(e.check.ok, true);
  // A wrong amount fails at once ...
  edit(close, e.id, { lines: [{ account: '5100', debit: gross, credit: 0 }, { account: CLEARING, debit: 0, credit: -e.gap }] });
  assert.deepEqual(e.check.failures.map((f) => f.rule), ['balanced']);
  // ... the right split passes, and the AI's original entry is kept.
  edit(close, e.id, { lines: [{ account: '5100', debit: gross, credit: 0 }, { account: '6100', debit: fee, credit: 0 }, { account: CLEARING, debit: 0, credit: -e.gap }] });
  assert.equal(e.check.ok, true);
  assert.equal(e.fix.original.lines[0].account, '3999');
  assert.equal(e.fix.by, 'claude');
  const edits = close.decisions.filter((d) => d.verdict === 'edited');
  assert.equal(edits.length, 1, 'a run of edits is one audit row');
  assert.match(edits[0].reason, /from Dr 3999 .* to Dr 5100/);
  // Reverting drops the mark; editing again and approving puts the edit in the journal.
  edit(close, e.id, { lines: e.fix.original.lines });
  assert.equal(e.fix.original, undefined);
  edit(close, e.id, { lines: [{ account: '5100', debit: gross, credit: 0 }, { account: '6100', debit: fee, credit: 0 }, { account: CLEARING, debit: 0, credit: -e.gap }] });
  approve(close, e.id);
  assert.equal(journal(close).find((j) => j.exception === e.id).editedBy, 'reviewer');
  assert.throws(() => edit(close, e.id, { lines: [] }), /already approved/);
});

test('an entry that cites items another approval settled can be corrected to cite only what is still open', () => {
  const { close } = demo();
  const st = stateOf(close);
  const exOf = (code) => close.exceptions.find((e) => e.paypal.length && st.byP.get(e.paypal[0]).code === code);
  const hold = exOf('T1110'), release = exOf('T1111'), cb = exOf('T1201');
  const a = -hold.gap;
  // The hold and its release in one entry; the chargeback's entry cites all three, as Claude does.
  propose(close, hold.id, { by: 'claude', category: 'hold_not_booked', cites: { paypal: [...hold.paypal, ...release.paypal], ledger: [] }, memo: 'hold', lines: [{ account: '1210', debit: a, credit: 0 }, { account: CLEARING, debit: 0, credit: a }, { account: CLEARING, debit: a, credit: 0 }, { account: '1210', debit: 0, credit: a }] });
  propose(close, cb.id, { by: 'claude', category: 'reversal_not_booked', cites: { paypal: [...cb.paypal, ...hold.paypal, ...release.paypal], ledger: [] }, memo: 'chargeback', lines: [{ account: '6150', debit: -cb.gap - 2000, credit: 0 }, { account: '6100', debit: 2000, credit: 0 }, { account: CLEARING, debit: 0, credit: -cb.gap }] });
  assert.equal(cb.check.ok, true);
  approve(close, hold.id);
  assert.equal(cb.check.ok, false);
  assert.ok(cb.check.failures.every((f) => f.rule === 'cites'));
  edit(close, cb.id, { cites: { paypal: [...cb.paypal], ledger: [] } });
  assert.equal(cb.check.ok, true, JSON.stringify(cb.check.failures));
  assert.match(close.decisions.at(-1).reason, /cited items from .* to /);
  approve(close, cb.id);
  assert.equal(close.exceptions.filter((e) => e.status === 'open').reduce((s, e) => s + e.gap, 0), summary(close).difference);
});
