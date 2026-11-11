// Domain scenarios built transaction by transaction, the way PayPal's Transaction Search reports
// them, each closed with the entry a bookkeeper would write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paypalRows, ledgerRows } from '../src/normalize.mjs';
import { CLEARING } from '../src/check.mjs';
import { openClose, ruleFix, propose, approve, summary, journal } from '../src/close.mjs';
import { demoMonth } from '../src/demo.mjs';

// A Transaction Search `transaction_details` item, as the REST API sends it.
const tx = (id, code, date, gross, fee = '0.00', extra = {}, currency = 'USD') => ({
  transaction_info: { transaction_id: id, transaction_event_code: code, transaction_initiation_date: `${date}T10:00:00+0000`, transaction_amount: { currency_code: currency, value: gross }, fee_amount: { currency_code: currency, value: fee }, transaction_status: 'S', ...extra },
});
const books = (rows) => ledgerRows(['id,date,amount,memo,ref', ...rows].join('\n'));
const open = (details, ledgerLines) => openClose({ paypal: paypalRows(details), ledger: books(ledgerLines), period: '2026-10' });
const exFor = (close, id) => close.exceptions.find((e) => e.paypal.includes(id) || e.ledger.includes(id));
const entry = (pairs) => pairs.map(([account, debit, credit]) => ({ account, debit, credit }));

test('chargeback lifecycle: T1110 hold, T1201 chargeback with its fee, T1111 release', () => {
  const close = open([
    tx('SALE1', 'T0006', '2026-10-02', '120.00', '-4.68'),
    tx('HOLD1', 'T1110', '2026-10-10', '-120.00', '0.00', { paypal_reference_id: 'SALE1' }),
    tx('CB1', 'T1201', '2026-10-20', '-120.00', '-20.00', { paypal_reference_id: 'SALE1' }),
    tx('REL1', 'T1111', '2026-10-20', '120.00', '0.00', { paypal_reference_id: 'SALE1' }),
  ], ['L1,2026-10-02,115.32,Sale,SALE1']);
  assert.equal(summary(close).difference, -12000 - 2000); // hold and release cancel; the chargeback and its fee remain

  const hold = exFor(close, 'HOLD1'), rel = exFor(close, 'REL1'), cb = exFor(close, 'CB1');

  // Calling the chargeback a hold fails: a chargeback is a reversal, even with the right amount.
  propose(close, cb.id, { by: 'test', category: 'hold_not_booked', cites: { paypal: ['CB1'], ledger: [] }, lines: entry([['6150', 14000, 0], [CLEARING, 0, 14000]]) });
  assert.ok(cb.check.failures.some((f) => f.rule === 'category_fits'));
  assert.ok(!cb.check.failures.some((f) => f.rule === 'closes_gap'));
  // Booking only the chargeback's amount and forgetting its $20 fee fails closes_gap.
  propose(close, cb.id, { by: 'test', category: 'reversal_not_booked', cites: { paypal: ['CB1'], ledger: [] }, lines: entry([['4900', 12000, 0], [CLEARING, 0, 12000]]) });
  assert.ok(cb.check.failures.some((f) => f.rule === 'closes_gap'));

  // The right entries: hold and release in one (net zero through 1210), the chargeback and its fee in another.
  propose(close, hold.id, { by: 'test', category: 'hold_not_booked', cites: { paypal: ['HOLD1', 'REL1'], ledger: [] }, lines: entry([['1210', 12000, 0], [CLEARING, 0, 12000], [CLEARING, 12000, 0], ['1210', 0, 12000]]) });
  assert.ok(hold.check.ok, JSON.stringify(hold.check.failures));
  approve(close, hold.id);
  assert.equal(rel.status, 'covered');
  propose(close, cb.id, { by: 'test', category: 'reversal_not_booked', cites: { paypal: ['CB1'], ledger: [] }, lines: entry([['4900', 12000, 0], ['6150', 2000, 0], [CLEARING, 0, 14000]]) });
  assert.ok(cb.check.ok, JSON.stringify(cb.check.failures));
  approve(close, cb.id);
  assert.equal(summary(close).difference, 0);
});

test('partial refund where PayPal returns only part of the fee (T1107)', () => {
  // A $100 sale (fee $3.98); a $40 partial refund on which PayPal hands back $1.40 of the fee.
  const close = open([
    tx('SALE2', 'T0006', '2026-10-03', '100.00', '-3.98'),
    tx('REF2', 'T1107', '2026-10-09', '-40.00', '1.40', { paypal_reference_id: 'SALE2' }),
  ], ['L1,2026-10-03,96.02,Sale,SALE2', 'L2,2026-10-09,-40.00,Partial refund,REF2']);
  const ex = exFor(close, 'REF2');
  assert.equal(ex.source, 'fee');             // booked at gross: the returned fee is missing
  assert.equal(ex.gap, 140);                  // PayPal net -38.60, books -40.00
  const fix = ruleFix(close, ex);
  assert.deepEqual(fix.lines, entry([[CLEARING, 140, 0], ['6100', 0, 140]])); // the fee comes back: credit fees
  propose(close, ex.id, fix);
  assert.ok(ex.check.ok, JSON.stringify(ex.check.failures));

  // Calling it a refund fee fix with the wrong amount fails: the gap must equal the cited fees.
  propose(close, ex.id, { ...fix, lines: entry([[CLEARING, 398, 0], ['6100', 0, 398]]) });
  assert.ok(ex.check.failures.some((f) => f.rule === 'closes_gap'));
  propose(close, ex.id, fix);
  approve(close, ex.id);
  assert.equal(summary(close).difference, 0);
});

test('currency conversion with a spread (T0200): only a conversion entry may close it', () => {
  // A EUR 100.00 sale converted by PayPal: the EUR leg leaves the EUR balance, the USD leg arrives
  // at PayPal's rate ($108.00). The books recorded the sale at the market rate ($110.00).
  const close = open([
    tx('EURSALE', 'T0006', '2026-10-05', '100.00', '0.00', {}, 'EUR'),
    tx('FXOUT', 'T0200', '2026-10-05', '-100.00', '0.00', {}, 'EUR'),
    tx('FXIN', 'T0200', '2026-10-05', '108.00', '0.00'),
  ], ['L1,2026-10-05,110.00,EUR sale at market rate,']);
  assert.deepEqual(close.foreign.map((t) => t.id), ['EURSALE', 'FXOUT']); // the EUR legs stay out of the USD tie-out
  assert.equal(summary(close).difference, -200);                            // the $2.00 spread

  const fx = exFor(close, 'FXIN'), line = exFor(close, 'L1');
  const lines = entry([['7100', 200, 0], [CLEARING, 0, 200]]);
  propose(close, fx.id, { by: 'test', category: 'sale_not_booked', cites: { paypal: ['FXIN'], ledger: ['L1'] }, lines });
  assert.ok(fx.check.failures.some((f) => f.rule === 'category_fits')); // a conversion is not a sale
  propose(close, fx.id, { by: 'test', category: 'fx_not_booked', cites: { paypal: ['FXIN', 'FXOUT'], ledger: ['L1'] }, lines });
  assert.ok(fx.check.failures.some((f) => f.rule === 'cites')); // the EUR leg is not an open item of this close
  propose(close, fx.id, { by: 'test', category: 'fx_not_booked', cites: { paypal: ['FXIN'], ledger: ['L1'] }, lines });
  assert.ok(fx.check.ok, JSON.stringify(fx.check.failures));
  approve(close, fx.id);
  assert.equal(line.status, 'covered');
  assert.equal(summary(close).difference, 0);
});

test('transposition: the $1,980.00 transfer booked as $1,890.00 is pointed out by code, and fixed for exactly $90', () => {
  const d = demoMonth();
  const close = openClose({ paypal: paypalRows(d.transaction_details), ledger: ledgerRows(d.ledgerCsv), period: d.period });
  const planted = d.planted.find((p) => p.kind === 'amount_keyed_wrong');
  const onBooks = close.exceptions.find((e) => e.ledger.includes(planted.ledger));
  const onPaypal = close.exceptions.find((e) => e.paypal.includes(planted.paypal));
  assert.deepEqual(onBooks.hints.map((h) => [h.kind, h.with]), [['transposition', onPaypal.id]]);
  assert.deepEqual(onPaypal.hints.map((h) => [h.kind, h.with]), [['transposition', onBooks.id]]);
  assert.equal(close.exceptions.filter((e) => e.hints.length).length, 2); // no other exception gets a hint

  propose(close, onBooks.id, { by: 'test', category: 'amount_keyed_wrong', cites: { paypal: [planted.paypal], ledger: [planted.ledger] }, lines: entry([['1000', 9000, 0], [CLEARING, 0, 9000]]) });
  assert.ok(onBooks.check.ok, JSON.stringify(onBooks.check.failures));
  approve(close, onBooks.id);
  assert.equal(onPaypal.status, 'covered');

  // The approved entry carries who approved it and when, for the journal export.
  const je = journal(close)[0];
  assert.equal(je.approvedBy, 'reviewer');
  assert.match(je.approvedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(je.covers, [onPaypal.id]);
});
