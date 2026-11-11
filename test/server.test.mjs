// The HTTP server, driven like a browser: sessions are separate, uploads are bounded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, browser } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test('two browsers never see or change each other\'s close', async () => {
  const a = browser(srv.base), b = browser(srv.base);
  const opened = await a.call('/api/close/demo', {});
  assert.equal(opened.status, 200);
  const exA = opened.data.exceptions.find((e) => e.source === 'fee');
  // B has its own session: no close, and A's exception ids mean nothing to it.
  assert.equal((await b.call('/api/close')).data.close, null);
  assert.equal((await b.call(`/api/exceptions/${exA.id}/propose`, {})).status, 409);
  assert.equal((await b.call('/api/journal.csv')).status, 409);
  // A forged or guessed cookie is a new, empty session, not someone else's.
  const c = browser(srv.base); c.cookie = 'cb=00000000-0000-4000-8000-000000000000';
  assert.equal((await c.call('/api/close')).data.close, null);
  assert.notEqual(c.cookie, 'cb=00000000-0000-4000-8000-000000000000');
  // A's close is untouched by all of that, and the cookie cannot be read by page scripts.
  const mine = await a.call('/api/close');
  assert.equal(mine.data.summary.difference, opened.data.summary.difference);
  const fresh = await browser(srv.base).call('/api/close');
  assert.match(fresh.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
});

test('an upload over 2 MB or 20,000 rows is refused with a clear message', async () => {
  const a = browser(srv.base);
  const row = '2026-10-05,1.00,a memo that pads the row out\n';
  const big = 'date,amount,memo\n' + row.repeat(Math.ceil((2.1 * 1024 * 1024) / row.length));
  let r = await a.call('/api/close/paypal', { period: '2026-10', ledgerCsv: big });
  assert.equal(r.status, 413);
  assert.match(r.data.error, /larger than 2 MB/);
  const many = 'date,amount\n' + '2026-10-05,1\n'.repeat(20_001);
  r = await a.call('/api/close/paypal', { period: '2026-10', ledgerCsv: many });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /20,001 lines, and closebook reads at most 20,000/);
  r = await a.call('/api/close/paypal', '{not json');
  assert.equal(r.status, 400);
});
