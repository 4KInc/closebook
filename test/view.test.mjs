// What the screen renders. Anything typed by a person or sent by PayPal (a memo, an item name, a
// buyer's name, a dispute reason, the AI's explanation) must come out as text, never as HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voucherHtml, itemsCellHtml, itemsLabel, statusChip, esc } from '../public/view.mjs';
import { demoMonth } from '../src/demo.mjs';
import { paypalRows, ledgerRows, disputeRows } from '../src/normalize.mjs';
import { openClose, propose, reject } from '../src/close.mjs';
import { CATEGORIES } from '../src/codes.mjs';

const XSS = '<img src=x onerror=alert(1)>';

function hostileClose() {
  const d = demoMonth();
  const paypal = paypalRows(d.transaction_details).map((t, i) => (i === 0 ? { ...t, subject: XSS, payer: XSS } : t));
  const csv = d.ledgerCsv.split('\n').map((l, i) => (i === 2 ? l.replace(/"[^"]*"/, `"${XSS}"`) : l)).join('\n');
  const disputes = disputeRows(Object.fromEntries(Object.entries(d.disputes).map(([k, v]) => [k, v.map((x) => ({ ...x, reason: XSS, status: XSS }))])));
  const close = openClose({ paypal, ledger: ledgerRows(csv), period: d.period, disputes });
  return { close, view: { ...close, config: { categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])) } } };
}

const noHtml = (html) => {
  assert.ok(!/<img/i.test(html), `raw <img> in: ${html.slice(0, 200)}`);
  assert.ok(!/onerror=/.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')), 'unescaped onerror');
};

test('a book memo with HTML in it is rendered as text, in the voucher and the grid', () => {
  assert.equal(esc(XSS), '&lt;img src=x onerror=alert(1)&gt;');
  const { close, view } = hostileClose();
  const line = close.ledger.find((l) => l.memo === XSS);
  assert.ok(line, 'the memo survives parsing as data');
  const ex = close.exceptions.find((e) => e.ledger.includes(line.id));
  const html = voucherHtml(view, ex);
  noHtml(html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  noHtml(itemsCellHtml(ex, itemsLabel(view, ex)));
});

test('PayPal fields, dispute text, AI text and rejection reasons are rendered as text too', () => {
  const { close, view } = hostileClose();
  for (const ex of close.exceptions) {
    if (ex.source === 'paypal') {
      propose(close, ex.id, { by: 'claude', category: 'reversal_not_booked', cites: { paypal: ex.paypal, ledger: [] }, lines: [{ account: '6150', debit: 1, credit: 0 }, { account: '1010', debit: 0, credit: 1 }], memo: XSS, explanation: XSS, model: XSS });
      reject(close, ex.id, XSS);
      propose(close, ex.id, { by: 'claude', category: XSS, cites: { paypal: ex.paypal, ledger: [] }, lines: [{ account: XSS, debit: 1, credit: 0 }], memo: XSS, explanation: XSS, model: XSS });
    }
    noHtml(voucherHtml(view, ex));
    noHtml(itemsCellHtml({ ...ex, hints: [{ detail: XSS }] }, itemsLabel(view, ex)));
    noHtml(statusChip({ ...ex, status: 'covered', coveredBy: XSS }));
  }
});
