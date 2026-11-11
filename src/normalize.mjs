// Turns PayPal Transaction Search `transaction_details` (raw API JSON, snake_case) into flat rows,
// and a ledger CSV into book lines. Amounts are integer cents; dates are YYYY-MM-DD.
import { cents } from './money.mjs';
import { kindOf } from './codes.mjs';

export function paypalRows(details) {
  return details.map((d) => {
    const t = d.transaction_info ?? {};
    const gross = cents(t.transaction_amount?.value);
    const fee = cents(t.fee_amount?.value);
    const payer = d.payer_info?.payer_name;
    return {
      id: t.transaction_id,
      ref: t.paypal_reference_id ?? null,
      code: t.transaction_event_code,
      kind: kindOf(t.transaction_event_code),
      date: (t.transaction_initiation_date ?? '').slice(0, 10),
      status: t.transaction_status,
      currency: t.transaction_amount?.currency_code ?? 'USD',
      gross,
      fee,
      net: gross + fee,
      invoice: t.invoice_id ?? null,
      custom: t.custom_field ?? null,
      subject: t.transaction_subject ?? t.transaction_note ?? null,
      payer: payer ? (payer.alternate_full_name ?? [payer.given_name, payer.surname].filter(Boolean).join(' ')) : (d.payer_info?.email_address ?? null),
    };
  }).filter((r) => r.id);
}

// One Balances API answer into whole cents for one currency, or null if PayPal has no balance in it.
export function balanceRow(raw, currency = 'USD') {
  const b = (raw?.balances ?? []).find((x) => (x.currency ?? x.total_balance?.currency_code) === currency);
  if (!b) return null;
  return {
    total: cents(b.total_balance?.value), available: cents(b.available_balance?.value), withheld: cents(b.withheld_balance?.value),
    asked: raw.asked ?? null, asOf: raw.as_of_time ?? null, refreshed: raw.last_refresh_time ?? null,
  };
}

// Disputes API items, keyed by the disputed (original) transaction, into plain rows.
export function disputeRows(byTransaction = {}) {
  const out = {};
  for (const [tx, items] of Object.entries(byTransaction ?? {})) {
    out[tx] = items.map((d) => ({
      id: d.dispute_id, reason: d.reason ?? null, status: d.status ?? null, stage: d.dispute_life_cycle_stage ?? null,
      outcome: d.dispute_outcome?.outcome_code ?? null, amount: d.dispute_amount ? cents(d.dispute_amount.value) : null,
      opened: (d.create_time ?? '').slice(0, 10) || null,
    }));
  }
  return out;
}

// CSV with a header row. Required columns: date, amount. Optional: id, memo, ref.
// `amount` is the signed change to the PayPal clearing account (money in is positive).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

export function ledgerRows(csvText) {
  const [header, ...body] = parseCsv(csvText);
  if (!header) throw new Error('the ledger CSV is empty');
  const col = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));
  for (const need of ['date', 'amount']) if (!(need in col)) throw new Error(`the ledger CSV needs a "${need}" column (it has: ${header.map((h) => h.trim()).join(', ')})`);
  // Every problem is collected with its row number, so a person can fix the file in one pass.
  const problems = [];
  const seen = new Set();
  const lines = body.map((f, n) => {
    const row = n + 2; // the header is row 1
    const id = (col.id != null && f[col.id]?.trim()) || `L${String(n + 1).padStart(3, '0')}`;
    const date = (f[col.date] ?? '').trim();
    const rawAmount = (f[col.amount] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(date) || Number.isNaN(Date.parse(date.slice(0, 10)))) problems.push(`row ${row}: date "${date}" is not YYYY-MM-DD`);
    let amount = 0;
    if (rawAmount === '') problems.push(`row ${row}: amount is blank`);
    else { try { amount = cents(rawAmount); } catch { problems.push(`row ${row}: amount "${rawAmount}" is not a number of dollars and cents`); } }
    if (seen.has(id)) problems.push(`row ${row}: id "${id}" is used twice`);
    seen.add(id);
    return {
      id,
      date: date.slice(0, 10),
      amount,
      memo: col.memo != null ? (f[col.memo] ?? '').trim() : '',
      ref: col.ref != null ? ((f[col.ref] ?? '').trim() || null) : null,
    };
  });
  if (problems.length) throw new Error(`${problems.length} problem${problems.length > 1 ? 's' : ''} in the books CSV: ${problems.slice(0, 8).join('; ')}${problems.length > 8 ? `; and ${problems.length - 8} more` : ''}`);
  return lines;
}
