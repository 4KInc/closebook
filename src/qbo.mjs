// QuickBooks Online exports, read as the books for the PayPal account. Two reports work: "General
// Ledger" and "Transaction Detail by Account", exported to CSV. Both have a few title rows, then a
// header row (Date, Transaction Type, Num, Name, Memo/Description, Split, Amount, Balance; the
// detail report also has Account), rows grouped under each account's name with a "Total for ..."
// line after them, and a footer. closebook keeps the rows of the PayPal account and turns each into
// a book line: date, amount (as QuickBooks signs it for that account), memo and reference.
import { parseCsv, ledgerRows } from './normalize.mjs';
import { cents } from './money.mjs';

const norm = (s) => String(s ?? '').trim().toLowerCase();

// A QuickBooks report, or closebook's own format? QuickBooks puts title rows above the header,
// and its header has "Transaction Type".
export function isQuickBooks(text) {
  const rows = parseCsv(text).slice(0, 15);
  return rows.some((r) => r.map(norm).includes('transaction type') && r.map(norm).includes('amount'));
}

// Dates as QuickBooks writes them (MM/DD/YYYY) or as ISO; null if neither.
function isoDate(s) {
  const t = String(s ?? '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function quickBooksRows(text, { account = null } = {}) {
  const rows = parseCsv(text);
  const h = rows.findIndex((r) => r.map(norm).includes('date') && r.map(norm).includes('amount'));
  if (h < 0) throw new Error('this QuickBooks file has no row with "Date" and "Amount" columns. Export the General Ledger or Transaction Detail by Account report as CSV.');
  const head = rows[h].map(norm);
  const col = (...names) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const c = { date: col('date', 'transaction date'), type: col('transaction type'), num: col('num', 'no.'), name: col('name'), memo: col('memo/description', 'memo', 'description'), account: col('account', 'account full name', 'distribution account'), amount: col('amount') };

  // Each row belongs to the account named in the column, or to the section heading above it.
  let section = null;
  const lines = [];
  for (const r of rows.slice(h + 1)) {
    const first = String(r[0] ?? '').trim();
    const date = c.date >= 0 ? isoDate(r[c.date]) : null;
    if (!date) {
      if (/^total for /i.test(first)) section = null;
      else if (first && r.slice(1).every((x) => !String(x ?? '').trim())) section = first;
      continue;
    }
    const raw = String(r[c.amount] ?? '').trim();
    if (!raw) continue;
    const acct = (c.account >= 0 && String(r[c.account] ?? '').trim()) || section || '';
    lines.push({ acct, date, raw, type: c.type >= 0 ? String(r[c.type] ?? '').trim() : '', num: c.num >= 0 ? String(r[c.num] ?? '').trim() : '', name: c.name >= 0 ? String(r[c.name] ?? '').trim() : '', memo: c.memo >= 0 ? String(r[c.memo] ?? '').trim() : '' });
  }
  if (!lines.length) throw new Error('no transactions found in this QuickBooks file.');

  // Which account is PayPal: the one asked for, the only one, or the one whose name says PayPal.
  const accounts = [...new Set(lines.map((l) => l.acct))];
  const chosen = account ? accounts.find((a) => norm(a) === norm(account))
    : accounts.length === 1 ? accounts[0]
      : (() => { const p = accounts.filter((a) => /paypal/i.test(a)); return p.length === 1 ? p[0] : null; })();
  if (!chosen) throw new Error(`we couldn't tell which account is PayPal. This file has: ${accounts.map((a) => a || '(no account name)').join(', ')}. Export the report for your PayPal account only, or name the account "PayPal".`);

  const problems = [];
  const out = lines.filter((l) => l.acct === chosen).map((l, i) => {
    let amount = 0;
    try { amount = cents(l.raw); } catch { problems.push(`${l.date}: the amount "${l.raw}" isn't a number`); }
    return { id: `Q${String(i + 1).padStart(3, '0')}`, date: l.date, amount, memo: [l.name, l.memo].filter(Boolean).join(' - ') || l.type, ref: l.num || null };
  });
  if (problems.length) throw new Error(`${problems.length} thing${problems.length > 1 ? 's' : ''} to fix: ${problems.slice(0, 8).join('; ')}.`);
  return out;
}

// The books from an upload: QuickBooks Online's export, or closebook's own date/amount CSV.
export function booksRows(text) {
  if (isQuickBooks(text)) {
    const lines = quickBooksRows(text);
    // Through the same checks as any other file (dates, amounts, ids, size), via the plain format.
    const csv = ['id,date,amount,memo,ref', ...lines.map((l) => [l.id, l.date, (l.amount / 100).toFixed(2), `"${l.memo.replace(/"/g, '""')}"`, l.ref ? `"${l.ref.replace(/"/g, '""')}"` : ''].join(','))].join('\n');
    return ledgerRows(csv);
  }
  return ledgerRows(text);
}
