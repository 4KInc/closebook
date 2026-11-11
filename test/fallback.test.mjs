// When live Claude calls are unavailable, the demo month still shows Claude's proposals, served
// from a recording and checked now like live ones. No real API is called: the "live" Claude here
// is a fake endpoint on localhost.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, browser } from './helpers.mjs';
import { demoMonth } from '../src/demo.mjs';
import { paypalRows, ledgerRows } from '../src/normalize.mjs';
import { openClose, stateOf } from '../src/close.mjs';
import { clearRecordingCache } from '../src/recorded.mjs';

// A recording for the demo month: a correct entry for each exception the rules leave open.
function demoRecording() {
  const d = demoMonth();
  const close = openClose({ paypal: paypalRows(d.transaction_details), ledger: ledgerRows(d.ledgerCsv), period: d.period });
  const st = stateOf(close);
  const kindCat = { refund: 'refund_not_booked', reversal: 'reversal_not_booked', hold: 'hold_not_booked', payout: 'payout_not_booked', transfer: 'transfer_not_booked', payment: 'sale_not_booked' };
  const proposals = close.exceptions.filter((e) => e.source !== 'fee').map((e) => {
    const g = e.gap;
    const lines = g >= 0 ? [{ account: '1010', debit: g, credit: 0 }, { account: '3999', debit: 0, credit: g }] : [{ account: '3999', debit: -g, credit: 0 }, { account: '1010', debit: 0, credit: -g }];
    const category = e.paypal.length ? kindCat[st.byP.get(e.paypal[0]).kind] : 'not_in_paypal';
    return { exception: e.id, paypal: e.paypal, ledger: e.ledger, fix: { category, cites: { paypal: e.paypal, ledger: e.ledger }, lines, memo: `recorded ${e.id}`, explanation: 'recorded', model: 'claude-opus-5-5' } };
  });
  return { recorded_at: '2026-11-11T16:00:00Z', model: 'claude-opus-5-5', kind: 'demo', period: d.period, proposals };
}

let srv, fake, fakeCalls = 0, recDir;
const rec = demoRecording();
before(async () => {
  recDir = mkdtempSync(join(tmpdir(), 'closebook-rec-'));
  writeFileSync(join(recDir, 'recorded-demo-2026-10.json'), JSON.stringify(rec));
  // Fake Claude: the first call answers with a correct entry; every later call is a 400.
  fake = createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)).on('end', () => {
      fakeCalls++;
      if (fakeCalls > 1) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fake failure' } })); }
      const p = JSON.parse(body).messages[0].content;
      const id = /Exception to fix: (\S+)/.exec(p)[1];
      const f = rec.proposals.find((x) => x.exception === id).fix;
      const out = { category: f.category, cites: f.cites, lines: f.lines.map((l) => ({ account: l.account, side: l.debit ? 'debit' : 'credit', amount_cents: l.debit || l.credit })), memo: 'live entry', explanation: 'live' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((r) => fake.listen(0, r));
  srv = await startServer({ CLOSEBOOK_RECORDINGS: recDir });
});
after(async () => { await srv.close(); fake.close(); });

const claudeExceptions = (v) => v.exceptions.filter((e) => e.source !== 'fee');

test('no API key: Claude\'s recorded proposals are shown, checked now, and can be edited and approved', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const a = browser(srv.base);
  const opened = (await a.call('/api/close/demo', {})).data;
  assert.equal(opened.recorded, true);
  const ex = claudeExceptions(opened)[0];
  const r = await a.call(`/api/exceptions/${ex.id}/propose`, {});
  assert.equal(r.status, 200);
  assert.match(r.data.fallback, /no API key/);
  const got = r.data.exceptions.find((e) => e.id === ex.id);
  assert.equal(got.fix.by, 'claude');
  assert.equal(got.fix.recorded.at, '2026-11-11T16:00:00Z');
  assert.equal(got.check.ok, true, 'checked live');
  // Breaking it by a cent fails the checks at once, exactly as a live proposal would.
  const lines = got.fix.lines.map((l, i) => (i === 0 ? { ...l, debit: l.debit ? l.debit + 1 : 0, credit: l.credit ? l.credit + 1 : 0 } : l));
  const edited = (await a.call(`/api/exceptions/${ex.id}/edit`, { lines })).data.exceptions.find((e) => e.id === ex.id);
  assert.equal(edited.check.ok, false);
  await a.call(`/api/exceptions/${ex.id}/edit`, { lines: got.fix.lines });
  const approved = (await a.call(`/api/exceptions/${ex.id}/approve`, {})).data.exceptions.find((e) => e.id === ex.id);
  assert.equal(approved.status, 'approved');
  assert.match((await a.call('/api/journal.csv')).data, /claude \(claude-opus-5-5\), recorded 2026-11-11T16:00:00Z/);
});

test('session cap reached: the same recorded proposals', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.CLAUDE_CALLS_PER_SESSION = '0';
  const before = fakeCalls;
  const a = browser(srv.base);
  const ex = claudeExceptions((await a.call('/api/close/demo', {})).data)[1];
  const r = await a.call(`/api/exceptions/${ex.id}/propose`, {});
  assert.match(r.data.fallback, /used its live AI proposals/);
  assert.equal(r.data.exceptions.find((e) => e.id === ex.id).check.ok, true);
  assert.equal(fakeCalls, before, 'no live call was made');
  delete process.env.CLAUDE_CALLS_PER_SESSION;
});

test('a live call that fails mid-close falls back for the remaining exceptions', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  fakeCalls = 0;
  const a = browser(srv.base);
  const [first, second, third] = claudeExceptions((await a.call('/api/close/demo', {})).data);
  const one = (await a.call(`/api/exceptions/${first.id}/propose`, {})).data;
  assert.equal(one.fallback, undefined);
  const live = one.exceptions.find((e) => e.id === first.id);
  assert.equal(live.fix.recorded, undefined);
  assert.equal(live.fix.memo, 'live entry');
  for (const ex of [second, third]) {
    const r = (await a.call(`/api/exceptions/${ex.id}/propose`, {})).data;
    assert.match(r.fallback, /live call failed/);
    const got = r.exceptions.find((e) => e.id === ex.id);
    assert.ok(got.fix.recorded);
    assert.equal(got.check.ok, true);
  }
});

test('no recording for the month: a plain answer that Claude is unavailable and rules still work', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  process.env.CLOSEBOOK_RECORDINGS = mkdtempSync(join(tmpdir(), 'closebook-empty-'));
  clearRecordingCache();
  try {
    const a = browser(srv.base);
    const opened = (await a.call('/api/close/demo', {})).data;
    assert.equal(opened.recorded, false);
    const r = await a.call(`/api/exceptions/${claudeExceptions(opened)[0].id}/propose`, {});
    assert.equal(r.status, 503);
    assert.match(r.data.error, /Claude is unavailable \(no API key on this server\).*Rule fixes still work/);
    const fee = opened.exceptions.find((e) => e.source === 'fee');
    assert.equal((await a.call(`/api/exceptions/${fee.id}/propose`, {})).status, 200);
  } finally { process.env.CLOSEBOOK_RECORDINGS = recDir; clearRecordingCache(); }
});
