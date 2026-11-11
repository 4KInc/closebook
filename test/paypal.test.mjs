// Transaction Search client against a fake SDK controller: paging, backoff, Retry-After, window
// splitting and the error messages a person sees. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMonth, fetchBalances, fetchDisputes, probe, withRetry, PayPalError } from '../src/paypal.mjs';
import { balanceRow } from '../src/normalize.mjs';

const ENV = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' };
const apiError = (statusCode, body = '', headers = {}) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, body, headers });
const page = (rows, total) => ({ body: JSON.stringify({ transaction_details: rows, total_pages: total }) });
const row = (id) => ({ transaction_info: { transaction_id: id } });
const quiet = { wait: async () => {}, log: () => {} };

test('reads every page until total_pages', async () => {
  const seen = [];
  const controller = { searchTransactions: async (q) => { seen.push(q.page); return page(Array.from({ length: q.page < 3 ? 500 : 7 }, (_, i) => row(`${q.page}-${i}`)), 3); } };
  const rows = await fetchMonth('2026-10', ENV, { controller, ...quiet });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(rows.length, 1007);
});

test('an empty month is an empty list, and a page without transaction_details does not crash', async () => {
  const controller = { searchTransactions: async () => ({ body: JSON.stringify({ total_pages: 0 }) }) };
  assert.deepEqual(await fetchMonth('2026-10', ENV, { controller, ...quiet }), []);
});

test('429 and 5xx are retried with growing waits; Retry-After is honoured', async () => {
  const waits = [];
  let n = 0;
  const controller = { searchTransactions: async () => { n++; if (n === 1) throw apiError(429, '', { 'retry-after': '2' }); if (n === 2) throw apiError(503); return page([row('A')], 1); } };
  const rows = await fetchMonth('2026-10', ENV, { controller, baseMs: 100, wait: async (ms) => waits.push(ms), log: () => {} });
  assert.equal(rows.length, 1);
  assert.equal(waits[0], 2000);                     // Retry-After: 2 seconds
  assert.ok(waits[1] >= 200 && waits[1] < 300);     // second retry: 100 * 2^1 plus jitter under 100
});

test('a retryable failure gives up after the set attempts with a clear message', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw apiError(500); }, { attempts: 3, ...quiet }), (e) => e instanceof PayPalError && /did not answer \(500\).*Gave up after 3 attempts/.test(e.message));
  assert.equal(n, 3);
});

test('403 and 401 are not retried and say what to do', async () => {
  for (const [status, text] of [[403, /enable "Transaction search"/], [401, /client ID or secret/]]) {
    let n = 0;
    const controller = { searchTransactions: async () => { n++; throw apiError(status, '{"name":"NOT_AUTHORIZED"}'); } };
    await assert.rejects(fetchMonth('2026-10', ENV, { controller, ...quiet }), text);
    assert.equal(n, 1);
  }
});

test('RESULTSET_TOO_LARGE splits the month into smaller windows and reads both halves', async () => {
  const windows = [];
  const controller = { searchTransactions: async (q) => {
    const span = Date.parse(q.endDate) - Date.parse(q.startDate);
    if (span > 20 * 864e5) throw apiError(400, '{"name":"RESULTSET_TOO_LARGE"}');
    windows.push([q.startDate, q.endDate]);
    return page([row(q.startDate)], 1);
  } };
  const rows = await fetchMonth('2026-10', ENV, { controller, ...quiet });
  assert.equal(windows.length, 2);
  assert.equal(windows[0][0], '2026-10-01T00:00:00Z');
  assert.equal(windows[1][1], '2026-10-31T23:59:59Z');
  assert.ok(Date.parse(windows[1][0]) - Date.parse(windows[0][1]) === 1000); // no gap, no overlap
  assert.equal(rows.length, 2);
});

test('the startup check reports a missing permission without throwing', async () => {
  const controller = { searchTransactions: async () => { throw apiError(403, '{"name":"NOT_AUTHORIZED"}'); } };
  const r = await probe(ENV, { controller, ...quiet });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.message, /Transaction search/);
  assert.equal((await probe({}, quiet)).ok, false);
});

test('balances are read at the start and end of the month, in cents, with the time PayPal answered for', async () => {
  const asked = [];
  const controller = { searchBalances: async (q) => { asked.push(q); const v = q.asOfTime.startsWith('2026-10-01') ? '5000.00' : '5038.82'; return { body: JSON.stringify({ balances: [{ currency: 'USD', total_balance: { currency_code: 'USD', value: v }, available_balance: { currency_code: 'USD', value: v }, withheld_balance: { currency_code: 'USD', value: '0.00' } }], as_of_time: q.asOfTime, last_refresh_time: q.asOfTime }) }; } };
  const b = await fetchBalances('2026-10', ENV, { controller, ...quiet });
  assert.deepEqual(asked.map((q) => [q.asOfTime, q.currencyCode]), [['2026-10-01T00:00:00Z', 'USD'], ['2026-10-31T23:59:59Z', 'USD']]);
  assert.equal(balanceRow(b.opening).total, 500000);
  assert.equal(balanceRow(b.closing).total, 503882);
  assert.equal(balanceRow(b.closing, 'EUR'), null);
});

test('disputes are looked up once per disputed transaction, with one token, and a 429 is retried', async () => {
  const calls = [];
  let limited = false;
  const fetch = async (url, init) => {
    calls.push(url.replace(/^https:\/\/[^/]+/, ''));
    const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), headers: [] });
    if (url.endsWith('/v1/oauth2/token')) { assert.match(init.headers.authorization, /^Basic /); return reply(200, { access_token: 't' }); }
    if (!limited) { limited = true; return reply(429, {}); }
    return reply(200, { items: url.includes('SALE1') ? [{ dispute_id: 'PP-D-1', reason: 'UNAUTHORISED', status: 'OPEN' }] : [] });
  };
  const out = await fetchDisputes(['SALE1', 'SALE1', 'SALE2'], ENV, { fetch, ...quiet });
  assert.deepEqual(Object.keys(out), ['SALE1']);
  assert.equal(calls.filter((c) => c.includes('oauth2')).length, 1);
  assert.deepEqual(calls.filter((c) => c.includes('disputes')).map((c) => c.split('disputed_transaction_id=')[1].split('&')[0]), ['SALE1', 'SALE1', 'SALE2']);
  assert.deepEqual(await fetchDisputes([], ENV, { fetch: () => assert.fail('no call for no ids') }), {});
});

test('a real sandbox Disputes API response parses into the same shape as the demo dispute, and the voucher shows it', async () => {
  const { readFileSync } = await import('node:fs');
  const { disputeRows, paypalRows } = await import('../src/normalize.mjs');
  const { voucherHtml } = await import('../public/view.mjs');
  const { openClose } = await import('../src/close.mjs');
  const { demoMonth } = await import('../src/demo.mjs');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/sandbox-dispute-2026-11.json', import.meta.url), 'utf8'));
  const SALE = '5SY66963X4673292W';
  // Through the real client: one token, one lookup by disputed_transaction_id, PayPal's own page.
  const fetch = async (url) => ({ ok: true, status: 200, headers: [], text: async () => JSON.stringify(url.endsWith('/oauth2/token') ? { access_token: 't' } : fixture.response) });
  const raw = await fetchDisputes([SALE], ENV, { fetch, ...quiet });
  const [real] = disputeRows(raw)[SALE];
  assert.deepEqual(real, { id: 'PP-R-FVS-10199012', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE', stage: 'INQUIRY', outcome: null, amount: 7250, opened: '2026-11-11' });
  // The same keys as the demo month's dispute, which is built in the Disputes API's shape.
  const [demo] = Object.values(disputeRows(demoMonth().disputes))[0];
  assert.deepEqual(Object.keys(real).sort(), Object.keys(demo).sort());
  // In the voucher: the sale, with the dispute's reason, status and stage in words.
  const sale = { transaction_info: { transaction_id: SALE, transaction_event_code: 'T0006', transaction_initiation_date: '2026-11-11T06:59:27Z', transaction_amount: { currency_code: 'USD', value: '72.50' }, fee_amount: { currency_code: 'USD', value: '-3.02' }, transaction_subject: 'Serving platter' } };
  const close = openClose({ paypal: paypalRows([sale]), ledger: [], period: '2026-11', disputes: disputeRows(raw) });
  const html = voucherHtml({ ...close, config: { categories: {} } }, close.exceptions[0]);
  assert.match(html, /Buyer dispute · buyer says the item never arrived · waiting for you · at the inquiry stage/);
});
