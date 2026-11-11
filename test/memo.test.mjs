// The close memo: code writes every number; an AI narrative is kept only if every number and ID
// in it is one of the summary's.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { demoMonth } from '../src/demo.mjs';
import { paypalRows, ledgerRows, balanceRow } from '../src/normalize.mjs';
import { openClose, stateOf, ruleFix, propose, approve, reject, edit } from '../src/close.mjs';
import { memoData, memoHtml, checkNarrative } from '../src/memo.mjs';
import { startServer, browser } from './helpers.mjs';

function closedDemo() {
  const d = demoMonth();
  const close = openClose({ paypal: paypalRows(d.transaction_details), ledger: ledgerRows(d.ledgerCsv), period: d.period, balances: { opening: balanceRow(d.balances.opening), closing: balanceRow(d.balances.closing) } });
  const st = stateOf(close);
  const kindCat = { refund: 'refund_not_booked', reversal: 'reversal_not_booked', hold: 'hold_not_booked', payout: 'payout_not_booked', transfer: 'transfer_not_booked', payment: 'sale_not_booked' };
  for (const e of close.exceptions) {
    if (e.status !== 'open') continue;
    const rule = ruleFix(close, e);
    if (rule) { propose(close, e.id, rule); approve(close, e.id); continue; }
    const g = e.gap;
    const lines = g >= 0 ? [{ account: '1010', debit: g, credit: 0 }, { account: '3999', debit: 0, credit: g }] : [{ account: '3999', debit: -g, credit: 0 }, { account: '1010', debit: 0, credit: -g }];
    propose(close, e.id, { by: 'claude', model: 'claude-opus-5-5', category: e.paypal.length ? kindCat[st.byP.get(e.paypal[0]).kind] : 'not_in_paypal', cites: { paypal: e.paypal, ledger: e.ledger }, lines, memo: 'test' });
    if (e.flags.length) { reject(close, e.id, 'look at the note'); propose(close, e.id, { by: 'claude', model: 'claude-opus-5-5', category: e.paypal.length ? kindCat[st.byP.get(e.paypal[0]).kind] : 'not_in_paypal', cites: { paypal: e.paypal, ledger: e.ledger }, lines, memo: 'again' }); edit(close, e.id, { memo: 'corrected' }); }
    approve(close, e.id);
  }
  return close;
}

test('every number in the memo comes from the close: tie-out, balances, categories, counts, approvals', () => {
  const close = closedDemo();
  const d = memoData(close, { label: 'Demo month' });
  assert.deepEqual([d.tieout.before, d.tieout.after], [-89744, 0]);
  assert.equal(d.tieout.before - d.tieout.adjustments, d.tieout.after, 'the approved entries account for the whole difference');
  assert.equal(d.balance.gap, 0);
  assert.equal(d.categories.reduce((a, c) => a + c.moved, 0), d.tieout.adjustments);
  assert.equal(d.counts.open, 0);
  assert.equal(d.counts.byRule, 23);
  assert.equal(d.counts.corrected, 2);
  assert.equal(d.counts.rejected, 2);
  assert.equal(d.flags.length, 2);
  assert.equal(d.approvals.length, d.counts.approved);
  const html = memoHtml(d);
  for (const s of ['tied out to $0.00', '-$897.44', '$2,412.50', 'Every transaction accounted for', 'Untrusted text addressed to the AI', 'look at the note', '@media print']) assert.ok(html.includes(s), s);
});

test('a narrative is kept only if every number and ID in it is from the summary', () => {
  const close = closedDemo();
  const d = memoData(close, { label: 'Demo month' });
  const id = d.flags[0].exception;
  const good = `October 2026 closed from -$897.44 to $0.00. ${d.counts.byRule} fee entries came from rules, ${d.counts.corrected} entries were corrected, and ${id} carried text addressed to the AI.`;
  assert.deepEqual(checkNarrative(good, d), { ok: true, problems: [] });
  assert.deepEqual(checkNarrative('The close moved $900.00 in fees.', d).problems, ['number 900.00']);
  assert.deepEqual(checkNarrative('See 3A1F99999DEMO9999 for details.', d).problems, ['id 3A1F99999DEMO9999']);
  assert.deepEqual(checkNarrative('Reviewed again in 2027.', d).problems, ['number 2027'], 'a date not in the summary is a number not in it');
  assert.equal(checkNarrative('', d).ok, false);
  const shown = memoHtml(d, { narrative: good });
  assert.ok(shown.includes('class="narrative"') && shown.includes('code checked that every number'));
  const dropped = memoHtml(d, { note: 'The AI\'s narrative was left out because it mentioned number 900.00' });
  assert.ok(!dropped.includes('class="narrative"') && dropped.includes('left out'));
});

// The server path, with a fake Claude endpoint whose narrative is set per test.
let srv, fake, reply = '';
before(async () => {
  fake = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })); }); });
  await new Promise((r) => fake.listen(0, r));
  srv = await startServer();
});
after(async () => { await srv.close(); fake.close(); });

test('the memo route: no narrative without the AI, a checked one with it, none when it invents a number', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  let a = browser(srv.base);
  await a.call('/api/close/demo', {});
  let html = (await a.call('/api/memo.html')).data;
  assert.match(html, /No narrative: live AI is unavailable \(no API key on this server\)/);
  assert.match(html, /-\$897\.44 still to settle/);

  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  reply = 'October 2026 has not closed yet: the difference is still -$897.44.';
  a = browser(srv.base);
  await a.call('/api/close/demo', {});
  html = (await a.call('/api/memo.html')).data;
  assert.ok(html.includes('class="narrative">October 2026 has not closed yet'), 'kept');

  reply = 'October 2026 is nearly done; about $1,200.00 remains.';
  a = browser(srv.base);
  await a.call('/api/close/demo', {});
  html = (await a.call('/api/memo.html')).data;
  assert.ok(!html.includes('class="narrative"'));
  assert.match(html, /left out because it mentioned number 1,200\.00/);
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_BASE_URL;
});
