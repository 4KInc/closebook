// How often does the AI get the demo month right? The demo knows what it planted, so every AI
// proposal can be graded against an answer key: the category, whether the entry passed the
// checks (first try, or after the one retry), and whether it used the account a bookkeeper would.
//
//   ANTHROPIC_API_KEY=... node scripts/eval.mjs --runs 5             calls the model directly
//   node scripts/eval.mjs --runs 5 --server https://closebook-uju5.onrender.com
//                                                                    drives a running server's API
//
// Each run opens a fresh demo month and asks for one proposal per exception the rules leave open
// (16 of them), without approving anything, so every proposal sees the same month. Results go to
// eval/ as JSON, and a summary is printed as Markdown.
import { writeFile, mkdir } from 'node:fs/promises';
import { demoMonth } from '../src/demo.mjs';
import { paypalRows, ledgerRows } from '../src/normalize.mjs';
import { openClose, stateOf } from '../src/close.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const RUNS = Number(arg('runs', 5));
const SERVER = arg('server', null);

// The answer key, keyed by what each exception holds. Built from the demo's own list of planted
// mistakes plus the two cases the rules deliberately leave open (a duplicate pair, and two sales
// of the same amount that only the payer's name tells apart).
function answerKey() {
  const d = demoMonth();
  const close = openClose({ paypal: paypalRows(d.transaction_details), ledger: ledgerRows(d.ledgerCsv), period: d.period });
  const st = stateOf(close);
  const planted = new Map();
  for (const p of d.planted) { if (p.paypal) planted.set(`X-${p.paypal}`, p.kind); if (p.ledger) planted.set(`X-${p.ledger}`, p.kind); }
  const ACCOUNT = { refund_not_booked: '4900', payout_not_booked: '5100', hold_not_booked: '1210', reversal_not_booked: '6150', amount_keyed_wrong: '1000', sale_not_booked: '4000', fee_not_booked: '6100' };
  const key = {};
  for (const e of close.exceptions.filter((x) => x.source !== 'fee')) {
    let accept = planted.has(e.id) ? [planted.get(e.id)] : null;
    let pair = null; // for a sale left open by the rules: the item(s) on the other side it belongs to
    const t = e.paypal.length ? st.byP.get(e.paypal[0]) : null;
    const l = e.ledger.length ? st.byL.get(e.ledger[0]) : null;
    if (!accept && t?.kind === 'payment') {
      // A sale whose book line the rules could not pair. Its line names the payer and shows the gross.
      const lines = close.ledger.filter((x) => x.amount === t.gross && x.memo.includes(t.payer) && close.exceptions.some((y) => y.source === 'books' && y.ledger.includes(x.id)));
      accept = ['fee_not_booked']; pair = lines.map((x) => x.id);
    }
    if (!accept && l) {
      const openL = new Set(close.exceptions.filter((y) => y.source === 'books').flatMap((y) => y.ledger));
      const openP = new Set(close.exceptions.filter((y) => y.source === 'paypal').flatMap((y) => y.paypal));
      const same = close.ledger.filter((x) => x.id !== l.id && openL.has(x.id) && x.amount === l.amount && x.memo === l.memo);
      // One of two identical book lines: it is either the sale's line (with its fee) or the duplicate.
      accept = same.length ? ['fee_not_booked', 'duplicate_in_books'] : ['fee_not_booked'];
      if (!same.length) pair = close.paypal.filter((x) => openP.has(x.id) && x.gross === l.amount && l.memo.includes(x.payer)).map((x) => x.id);
    }
    if (planted.get(e.id) === 'duplicate_in_books') accept = ['duplicate_in_books', 'fee_not_booked'];
    key[e.id] = { accept, pair, account: ACCOUNT[accept[0]] ?? null, what: t ? `${t.code} ${t.subject ?? t.kind}` : `book ${l.id}: ${l.memo}` };
  }
  return key;
}

function grade(key, ex) {
  const k = key[ex.id];
  const f = ex.fix;
  if (!f) return { id: ex.id, error: ex.error ?? 'no proposal' };
  const cited = [...f.cites.paypal, ...f.cites.ledger];
  return {
    id: ex.id,
    category: f.category,
    categoryRight: k.accept.includes(f.category),
    pairRight: k.pair?.length ? k.pair.some((id) => cited.includes(id)) : null,
    accountRight: k.account && f.category === k.accept[0] ? f.lines.some((l) => l.account === k.account) : null,
    checksPass: ex.check.ok,
    firstTry: ex.check.ok && (ex.attempts ?? 1) === 1,
    failures: ex.check.ok ? [] : ex.check.failures.map((x) => x.rule),
    accounts: f.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.account} ${l.debit || l.credit}`).join(', '),
  };
}

// One run against a server: its own cookie session, the demo month, one proposal per exception.
async function runServer(key) {
  let cookie = '';
  const call = async (path, body) => {
    const res = await fetch(`${SERVER}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path}: ${data.error ?? res.status}`);
    return data;
  };
  let v = await call('/api/close/demo', {});
  const out = [];
  for (const id of Object.keys(key)) {
    try { v = await call(`/api/exceptions/${encodeURIComponent(id)}/propose`, {}); out.push(grade(key, v.exceptions.find((e) => e.id === id))); }
    catch (e) { out.push({ id, error: e.message }); }
  }
  return { model: v.config?.model, results: out };
}

// One run in this process, calling the model directly.
async function runLocal(key) {
  const { proposeWithClaude, MODEL } = await import('../src/claude.mjs');
  const { propose } = await import('../src/close.mjs');
  const d = demoMonth();
  const close = openClose({ paypal: paypalRows(d.transaction_details), ledger: ledgerRows(d.ledgerCsv), period: d.period });
  const out = [];
  for (const id of Object.keys(key)) {
    const ex = close.exceptions.find((e) => e.id === id);
    try { const r = await proposeWithClaude(close, ex); propose(close, id, r.fix); ex.attempts = r.attempts.length; out.push(grade(key, ex)); }
    catch (e) { out.push({ id, error: e.message }); }
  }
  return { model: MODEL, results: out };
}

const key = answerKey();
if (process.argv.includes('--key')) { console.log(JSON.stringify(key, null, 2)); process.exit(0); }
if (!SERVER && !process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY, or pass --server <url> to drive a running closebook.'); process.exit(1); }
console.error(`${RUNS} runs x ${Object.keys(key).length} exceptions, ${SERVER ? `via ${SERVER}` : 'calling the model directly'}…`);
const started = new Date().toISOString();
const runs = await Promise.all(Array.from({ length: RUNS }, () => (SERVER ? runServer(key) : runLocal(key))));

// Summary: per exception and overall.
const all = runs.flatMap((r) => r.results);
const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : 'n/a');
const count = (xs, f) => xs.filter(f).length;
const graded = all.filter((r) => !r.error);
const lines = [];
lines.push(`### Demo month: ${RUNS} runs, ${Object.keys(key).length} exceptions each, model ${runs[0]?.model ?? '?'} (${started.slice(0, 10)})`, '');
lines.push(`| | Result |`, `|---|---|`);
lines.push(`| Proposals | ${all.length} (${all.length - graded.length} errors) |`);
lines.push(`| Category matches the answer key | ${pct(count(graded, (r) => r.categoryRight), graded.length)} |`);
lines.push(`| Passed every check | ${pct(count(graded, (r) => r.checksPass), graded.length)} |`);
lines.push(`| Passed on the first try | ${pct(count(graded, (r) => r.firstTry), graded.length)} |`);
const acc = graded.filter((r) => r.accountRight !== null);
lines.push(`| Used the expected account (when the category was right) | ${pct(count(acc, (r) => r.accountRight), acc.length)} |`);
const pairs = graded.filter((r) => r.pairRight !== null);
lines.push(`| Paired a same-amount sale with the right book line | ${pct(count(pairs, (r) => r.pairRight), pairs.length)} |`);
lines.push('', '| Exception | Expected | Category right | Checks pass | Most common answer |', '|---|---|---|---|---|');
for (const [id, k] of Object.entries(key)) {
  const rs = graded.filter((r) => r.id === id);
  const tally = {}; for (const r of rs) tally[r.category] = (tally[r.category] ?? 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  lines.push(`| ${k.what} | ${k.accept.join(' or ')} | ${count(rs, (r) => r.categoryRight)}/${rs.length} | ${count(rs, (r) => r.checksPass)}/${rs.length} | ${top ? `${top[0]} (${top[1]})` : '-'} |`);
}
const md = lines.join('\n');
console.log(md);
await mkdir(new URL('../eval/', import.meta.url), { recursive: true });
await writeFile(new URL(`../eval/results-${started.slice(0, 19).replace(/:/g, '')}.json`, import.meta.url), JSON.stringify({ started, runs: RUNS, server: SERVER, key, results: runs }, null, 2));
await writeFile(new URL('../eval/latest.md', import.meta.url), md + '\n');
