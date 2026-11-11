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
  for (const need of ['date', 'amount']) if (!(need in col)) throw new Error(`the ledger CSV needs a "${need}" column`);
  return body.map((f, n) => ({
    id: (col.id != null && f[col.id]?.trim()) || `L${String(n + 1).padStart(3, '0')}`,
    date: f[col.date].trim().slice(0, 10),
    amount: cents(f[col.amount]),
    memo: col.memo != null ? (f[col.memo] ?? '').trim() : '',
    ref: col.ref != null ? ((f[col.ref] ?? '').trim() || null) : null,
  }));
}
