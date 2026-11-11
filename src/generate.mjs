// Generated months for measuring the AI beyond the one demo month we wrote by hand. Each seed
// gives a different shop, size and mix of mistakes, built in the raw Transaction Search shape like
// the demo month, with an answer key of what was planted. Same seed, same month, so anyone can
// reproduce a measurement (the seeds used are in eval/seeds.json).
//
// The mistakes are the kinds a close has to judge: a sale or a refund never booked, a duplicate,
// a dispute (hold, release, chargeback), a payout, a transfer typed with two digits swapped or
// never booked, a non-PayPal sale posted to PayPal. Most sales are booked at gross (fee left out),
// some at net with their invoice number, as in the demo.

function rng(seed) { // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const SHOPS = [
  ['Fernhill Candles', [['Soy candle', 2400], ['Candle trio', 6200], ['Wax melts', 1200], ['Gift box', 8800]]],
  ['Lark & Loom', [['Wool throw', 12800], ['Cushion cover', 3400], ['Table runner', 4600], ['Knitting kit', 5900]]],
  ['North Pine Prints', [['A4 print', 2200], ['A3 print', 3800], ['Framed print', 9400], ['Postcard set', 1400]]],
  ['Saltmarsh Soap Co.', [['Bar soap', 900], ['Soap bundle', 3200], ['Bath salts', 1800], ['Gift set', 5400]]],
  ['Quarry Leatherworks', [['Card wallet', 4500], ['Belt', 7800], ['Tote bag', 16500], ['Key fob', 1500]]],
];
const NAMES = ['Ava Brooks', 'Leo Martin', 'Mia Chen', 'Noah Patel', 'Zoe Rivera', 'Eli Kim', 'Ivy Novak', 'Sam Ortiz', 'Ruby Shah', 'Owen Diaz', 'Nina Park', 'Theo Grant', 'Lena Fox', 'Omar Haddad', 'Ella Moss'];
const KINDS = ['sale_not_booked', 'duplicate_in_books', 'refund_not_booked', 'dispute', 'payout_not_booked', 'amount_keyed_wrong', 'transfer_not_booked', 'not_in_paypal'];

const money = (c) => ({ currency_code: 'USD', value: (c / 100).toFixed(2) });
const feeOf = (gross) => -(Math.round(gross * 0.0349) + 49);

// Two adjacent digits of the dollars swapped: 1980 -> 1890. Returns null if none differ.
function transpose(cents, r) {
  const d = String(Math.floor(cents / 100));
  const at = [...d].map((c, i) => i).filter((i) => i + 1 < d.length && d[i] !== d[i + 1]);
  if (!at.length) return null;
  const i = at[Math.floor(r() * at.length)];
  return Number(d.slice(0, i) + d[i + 1] + d[i] + d.slice(i + 2)) * 100 + (cents % 100);
}

export function generatedMonth(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const [shop, items] = SHOPS[seed % SHOPS.length];
  const period = '2026-09';
  const day = (d) => `${period}-${String(Math.max(1, Math.min(30, d))).padStart(2, '0')}`;
  const details = [], books = [], planted = [];
  let n = 0;
  const id = () => `${(0x5B2000000 + seed * 104729 + ++n * 7919).toString(16).toUpperCase().slice(-9).padStart(9, '0')}GEN${String(n).padStart(4, '0')}`;
  const tx = ({ code, d, gross, fee = 0, ref, invoice, subject, payer }) => {
    const t = { id: id(), code, d, gross, fee, ref, invoice, subject, payer };
    details.push({
      transaction_info: {
        transaction_id: t.id, ...(ref ? { paypal_reference_id: ref, paypal_reference_id_type: 'TXN' } : {}),
        transaction_event_code: code, transaction_initiation_date: `${day(d)}T${String(9 + (d % 9)).padStart(2, '0')}:${String(int(10, 59))}:00+0000`,
        transaction_amount: money(gross), ...(fee ? { fee_amount: money(fee) } : {}), transaction_status: 'S',
        ...(invoice ? { invoice_id: invoice } : {}), ...(subject ? { transaction_subject: subject } : {}),
      },
      ...(payer ? { payer_info: { payer_name: { alternate_full_name: payer } } } : {}),
    });
    return t;
  };
  const book = (d, amount, memo, ref = null) => { books.push({ id: `B${String(books.length + 1).padStart(3, '0')}`, date: day(d), amount, memo, ref }); return books.at(-1); };

  // The mix: 3 to 7 mistakes, at most two of a kind.
  const want = int(3, 7), counts = {};
  while (Object.values(counts).reduce((a, b) => a + b, 0) < want) { const k = pick(KINDS); if ((counts[k] ?? 0) < 2) counts[k] = (counts[k] ?? 0) + 1; }
  const nSales = int(8, 45);
  const sales = [];
  for (let i = 0; i < nSales; i++) {
    const [item, price] = pick(items);
    const qty = r() < 0.2 ? 2 : 1;
    const gross = price * qty + int(0, 40) * 100 + (r() < 0.5 ? 95 : 0); // shipping and options vary the totals
    sales.push(tx({ code: 'T0006', d: 1 + Math.floor((i * 29) / nSales), gross, fee: feeOf(gross), invoice: `${shop.slice(0, 2).toUpperCase()}-${2000 + i}`, subject: `${qty} x ${item}`, payer: pick(NAMES) }));
  }
  // Which sales the mistakes use: distinct, so one sale carries at most one planted mistake.
  const free = sales.map((_, i) => i).sort(() => r() - 0.5);
  const take = () => sales[free.pop()];
  const unbooked = new Set(), dupes = new Set();
  for (let k = 0; k < (counts.sale_not_booked ?? 0); k++) { const s = take(); unbooked.add(s.id); planted.push({ kind: 'sale_not_booked', paypal: s.id }); }
  for (let k = 0; k < (counts.duplicate_in_books ?? 0); k++) dupes.add(take().id);
  for (const [i, s] of sales.entries()) {
    if (unbooked.has(s.id)) continue;
    if (i % 5 === 0 && !dupes.has(s.id)) book(s.d, s.gross + s.fee, `PayPal deposit ${s.invoice}`, s.invoice);
    else book(s.d, s.gross, `${s.subject} - ${s.payer}`);
    if (dupes.has(s.id)) planted.push({ kind: 'duplicate_in_books', ledger: book(s.d + 1, s.gross, `${s.subject} - ${s.payer}`).id });
  }
  for (let k = 0; k < (counts.refund_not_booked ?? 0); k++) {
    const s = take();
    const full = r() < 0.5;
    const t = tx({ code: 'T1107', d: s.d + int(1, 5), gross: full ? -s.gross : -int(5, Math.max(6, Math.floor(s.gross / 200))) * 100, fee: full ? Math.round(-s.fee * 0.85) : 0, ref: s.id, subject: `${full ? 'Refund' : 'Partial refund'} ${s.invoice}` });
    planted.push({ kind: 'refund_not_booked', paypal: t.id });
  }
  for (let k = 0; k < (counts.dispute ?? 0); k++) {
    const s = take();
    const hold = tx({ code: 'T1110', d: s.d + 5, gross: -s.gross, ref: s.id, subject: 'Hold for dispute investigation' });
    const rel = tx({ code: 'T1111', d: s.d + 8, gross: s.gross, ref: s.id, subject: 'Cancellation of hold for dispute resolution' });
    const cb = tx({ code: 'T1201', d: s.d + 8, gross: -s.gross, fee: -2000, ref: s.id, subject: 'Chargeback' });
    planted.push({ kind: 'hold_not_booked', paypal: hold.id }, { kind: 'hold_not_booked', paypal: rel.id }, { kind: 'reversal_not_booked', paypal: cb.id });
  }
  for (let k = 0; k < (counts.payout_not_booked ?? 0); k++) {
    const amount = int(60, 900) * 100;
    const t = tx({ code: 'T0001', d: int(5, 27), gross: -amount, fee: -Math.min(2000, Math.max(25, Math.round(amount * 0.02))), subject: pick(['Studio assistant', 'Photography', 'Packaging supplies run', 'Market stall help']) + ' - September' });
    planted.push({ kind: 'payout_not_booked', paypal: t.id });
  }
  for (let k = 0; k < (counts.amount_keyed_wrong ?? 0); k++) {
    let amount, typed;
    do { amount = int(400, 4800) * 100; typed = transpose(amount, r); } while (typed === null);
    const d = int(10, 28);
    const t = tx({ code: 'T0400', d, gross: -amount, subject: 'Withdrawal to bank' });
    planted.push({ kind: 'amount_keyed_wrong', paypal: t.id, ledger: book(d, -typed, 'Transfer to bank').id });
  }
  for (let k = 0; k < (counts.transfer_not_booked ?? 0); k++) {
    const t = tx({ code: 'T0400', d: int(10, 28), gross: -int(300, 3000) * 100, subject: 'Withdrawal to bank' });
    planted.push({ kind: 'transfer_not_booked', paypal: t.id });
  }
  for (let k = 0; k < (counts.not_in_paypal ?? 0); k++) {
    planted.push({ kind: 'not_in_paypal', ledger: book(int(3, 27), int(20, 150) * 100 + 5 * int(0, 1) * 10, pick(['Market sale - cash', 'Card reader sale (Square)', 'Bank transfer from wholesale customer'])).id });
  }

  details.sort((a, b) => a.transaction_info.transaction_initiation_date.localeCompare(b.transaction_info.transaction_initiation_date));
  books.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const csv = ['id,date,amount,memo,ref', ...books.map((b) => [b.id, b.date, (b.amount / 100).toFixed(2), `"${b.memo.replace(/"/g, '""')}"`, b.ref ?? ''].join(','))].join('\n');
  return { seed, shop, period, transaction_details: details, ledgerCsv: csv, planted, injections: [], mix: counts, size: { sales: nSales, paypal: details.length, books: books.length } };
}
