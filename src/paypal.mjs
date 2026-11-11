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

// Returns the raw `transaction_details` array (snake_case, as the REST API sends it), so live data
// and the demo month go through the same normalizer.
export async function fetchMonth(period, env = process.env) {
  const ctl = controller(env);
  const { startDate, endDate } = monthRange(period);
  const details = [];
  for (let page = 1; ; page++) {
    let res;
    try {
      res = await ctl.searchTransactions({ startDate, endDate, fields: 'all', balanceAffectingRecordsOnly: 'Y', pageSize: 500, page });
    } catch (e) {
      const body = typeof e.body === 'string' ? e.body : '';
      if (e.statusCode === 403) throw new Error('PayPal refused Transaction Search (403). In the PayPal developer dashboard, open this REST app and enable "Transaction search", then wait a few minutes for the permission to apply.');
      throw new Error(`PayPal Transaction Search failed (${e.statusCode ?? 'no status'}): ${body.slice(0, 300) || e.message}`);
    }
    const raw = JSON.parse(res.body);
    details.push(...(raw.transaction_details ?? []));
    if (page >= (raw.total_pages ?? 1)) break;
  }
  return details;
}
