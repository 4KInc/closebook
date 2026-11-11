// Reads a period's PayPal activity with PayPal's Server SDK (Transaction Search). Read-only: this
// app never moves money. Requires a sandbox REST app with "Transaction search" enabled.
//
// From the SDK reference: a search covers at most 31 days, and a transaction can take up to three
// hours to appear. A month fits in one window; pages are fetched until total_pages.
import { Client, Environment, TransactionSearchController } from '@paypal/paypal-server-sdk';

export function paypalConfigured(env = process.env) {
  return Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
}

function controller(env) {
  return new TransactionSearchController(new Client({
    clientCredentialsAuthCredentials: { oAuthClientId: env.PAYPAL_CLIENT_ID, oAuthClientSecret: env.PAYPAL_CLIENT_SECRET },
    environment: env.PAYPAL_ENVIRONMENT === 'production' ? Environment.Production : Environment.Sandbox,
    timeout: 30_000,
  }));
}

export function monthRange(period) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('period must look like 2026-10');
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Math.min(Date.UTC(y, m, 1) - 1000, Date.now()));
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { startDate: iso(start), endDate: iso(end) };
}

export class PayPalError extends Error {
  constructor(message, { status = null, retryable = false } = {}) { super(message); this.name = 'PayPalError'; this.status = status; this.retryable = retryable; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const header = (e, name) => { const h = e?.headers ?? {}; return h[name] ?? h[name.toLowerCase()] ?? (typeof h.get === 'function' ? h.get(name) : undefined); };

// What a failed SDK call means for the person running the close.
function explain(e) {
  const status = e?.statusCode ?? null;
  const body = typeof e?.body === 'string' ? e.body : '';
  if (status === 401) return new PayPalError('PayPal rejected the client ID or secret (401). Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_ENVIRONMENT (sandbox credentials only work against the sandbox).', { status });
  if (status === 403) return new PayPalError('PayPal refused Transaction Search (403 NOT_AUTHORIZED). In the PayPal developer dashboard, open this REST app, enable "Transaction search", and wait a few minutes for the permission to apply.', { status });
  if (status === 429) return new PayPalError('PayPal is rate-limiting Transaction Search (429).', { status, retryable: true });
  if (/RESULTSET_TOO_LARGE/.test(body)) return new PayPalError('too large', { status });
  if (status === null || status >= 500) return new PayPalError(`PayPal Transaction Search did not answer (${status ?? e?.code ?? e?.message ?? 'network error'}).`, { status, retryable: true });
  return new PayPalError(`PayPal Transaction Search failed (${status}): ${body.slice(0, 300) || e?.message}`, { status });
}

// One GET, retried with exponential backoff on 429, 5xx and network errors. Transaction Search is
// read-only, so a retry cannot repeat anything. PayPal's Retry-After, when sent, wins.
export async function withRetry(call, { attempts = 5, baseMs = 500, wait = sleep, log = console.warn } = {}) {
  for (let i = 1; ; i++) {
    try { return await call(); } catch (raw) {
      const e = raw instanceof PayPalError ? raw : explain(raw);
      if (!e.retryable || i >= attempts) {
        if (e.retryable) e.message += ` Gave up after ${attempts} attempts; try again in a minute.`;
        throw Object.assign(e, { cause: raw });
      }
      const after = Number(header(raw, 'Retry-After'));
      const ms = Number.isFinite(after) && after > 0 ? after * 1000 : baseMs * 2 ** (i - 1) + Math.floor(Math.random() * baseMs);
      log(`[paypal] ${e.message} Retrying in ${ms} ms (attempt ${i + 1} of ${attempts}).`);
      await wait(ms);
    }
  }
}

const MAX_PAGES = 200; // 100,000 transactions at 500 a page

// Every page of one date window. If PayPal says the window holds too many results
// (RESULTSET_TOO_LARGE), the window is split in half and each half is read on its own.
async function fetchWindow(search, startDate, endDate, opts, depth = 0) {
  const details = [];
  for (let page = 1; ; page++) {
    let res;
    try {
      res = await withRetry(() => search({ startDate, endDate, fields: 'all', balanceAffectingRecordsOnly: 'Y', pageSize: 500, page }), opts);
    } catch (e) {
      if (e.message === 'too large' && depth < 6) {
        const mid = new Date((Date.parse(startDate) + Date.parse(endDate)) / 2);
        const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
        const left = await fetchWindow(search, startDate, iso(mid), opts, depth + 1);
        const right = await fetchWindow(search, iso(new Date(mid.getTime() + 1000)), endDate, opts, depth + 1);
        return [...left, ...right];
      }
      if (e.message === 'too large') throw new PayPalError('PayPal says this period holds too many transactions to read, even split into small windows.');
      throw e;
    }
    let raw;
    try { raw = typeof res.body === 'string' ? JSON.parse(res.body) : res.result ?? res.body; }
    catch { throw new PayPalError(`PayPal sent a page that is not JSON (page ${page}).`); }
    const rows = Array.isArray(raw?.transaction_details) ? raw.transaction_details : [];
    details.push(...rows);
    const total = Number(raw?.total_pages ?? 1) || 1;
    if (page >= total) break;
    if (page >= MAX_PAGES) throw new PayPalError(`PayPal reports ${total} pages for this period; closebook stops at ${MAX_PAGES} (${MAX_PAGES * 500} transactions).`);
  }
  return details;
}

// Returns the raw `transaction_details` array (snake_case, as the REST API sends it), so live data
// and the demo month go through the same normalizer. An empty month is an empty array, not an
// error; PayPal notes that a new transaction can take up to three hours to appear.
export async function fetchMonth(period, env = process.env, opts = {}) {
  const ctl = opts.controller ?? controller(env);
  const { startDate, endDate } = monthRange(period);
  return fetchWindow((q) => ctl.searchTransactions(q), startDate, endDate, opts);
}

// PayPal's own balance at the start and the end of the period (`GET /v1/reporting/balances`,
// through the same SDK controller). The close checks that the balance moved by exactly the net of
// the transactions Transaction Search returned, so a missing or extra transaction shows up even
// when the books happen to agree with it. PayPal answers "as of" its last refresh, which can be
// earlier than asked; the answer keeps both times so the screen can say so.
export async function fetchBalances(period, env = process.env, opts = {}) {
  const ctl = opts.controller ?? controller(env);
  const { startDate, endDate } = monthRange(period);
  const one = async (asOfTime) => {
    const res = await withRetry(() => ctl.searchBalances({ asOfTime, currencyCode: opts.currency ?? 'USD' }), opts);
    try { return typeof res.body === 'string' ? JSON.parse(res.body) : res.result ?? res.body; }
    catch { throw new PayPalError('PayPal sent a balance that is not JSON.'); }
  };
  const [opening, closing] = await Promise.all([one(startDate), one(endDate)]);
  return { opening: { ...opening, asked: startDate }, closing: { ...closing, asked: endDate } };
}

// The dispute behind a hold or a chargeback (`GET /v1/customer/disputes`). The Server SDK has no
// disputes controller, so this is a plain REST call with the same app's client-credentials token.
// Transaction Search says money was held or taken back; the dispute says why (item not received,
// unauthorised, ...) and how it ended, which is what decides the entry. Read-only, like the rest.
const API = (env) => (env.PAYPAL_ENVIRONMENT === 'production' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

export async function fetchDisputes(transactionIds, env = process.env, opts = {}) {
  const http = opts.fetch ?? fetch;
  const ids = [...new Set(transactionIds)].slice(0, 25);
  if (!ids.length) return {};
  const call = async (url, init) => {
    const res = await http(url, init);
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { statusCode: res.status, body: text, headers: Object.fromEntries(res.headers ?? []) });
    return JSON.parse(text);
  };
  const token = (await withRetry(() => call(`${API(env)}/v1/oauth2/token`, {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { authorization: `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
  }), opts)).access_token;
  const out = {};
  for (const id of ids) {
    const page = await withRetry(() => call(`${API(env)}/v1/customer/disputes?disputed_transaction_id=${encodeURIComponent(id)}&page_size=10`, { headers: { authorization: `Bearer ${token}` } }), opts);
    if (page.items?.length) out[id] = page.items;
  }
  return out;
}

// A cheap check at startup: one transaction from the last day. Reports whether the credentials
// work and whether the app has the Transaction search permission, without failing the server.
export async function probe(env = process.env, opts = {}) {
  if (!paypalConfigured(env)) return { ok: false, status: null, message: 'PayPal credentials are not set; only the demo month is available.' };
  const ctl = opts.controller ?? controller(env);
  const end = new Date(), start = new Date(end.getTime() - 864e5);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    await withRetry(() => ctl.searchTransactions({ startDate: iso(start), endDate: iso(end), pageSize: 1, page: 1 }), { attempts: 2, ...opts });
    return { ok: true, status: 200, message: 'PayPal Transaction Search is reachable.' };
  } catch (e) {
    return { ok: false, status: e.status ?? null, message: e.message };
  }
}
