// Records Claude's proposals for a known month, so the server can show them when live calls are
// unavailable (see src/recorded.mjs). Two sources:
//
//   node scripts/record.mjs --from eval/results-demo-....json
//       the demo month: the first run of a real eval (every proposal is exactly what Claude sent)
//   node scripts/record.mjs --sandbox 2026-11
//       closebook's sandbox account, read live, against samples/sandbox-<month>-books.csv, with
//       one live Claude proposal per exception the rules leave open (needs PayPal and Anthropic keys)
//
// Writes eval/recorded-<demo|paypal>-<period>.json.
import { readFile, writeFile } from 'node:fs/promises';
import { recordingName } from '../src/recorded.mjs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch {}

let rec;
if (arg('from')) {
  const file = arg('from');
  const r = JSON.parse(await readFile(file, 'utf8'));
  const first = r.results.filter((x) => x.month === 'demo' && x.run === 0 && x.fix);
  rec = {
    recorded_at: r.started, model: first[0]?.fix.model, kind: 'demo', period: '2026-10',
    how: `The first run of scripts/eval.mjs (${file.split('/').pop()}): the proposals Claude actually made, unedited.`,
    proposals: first.map((x) => ({ exception: x.id, paypal: x.paypal, ledger: x.ledger, attempts: x.attempts, fix: x.fix })),
  };
} else if (arg('sandbox')) {
  const period = arg('sandbox');
  const { fetchMonth, fetchBalances, fetchDisputes } = await import('../src/paypal.mjs');
  const { paypalRows, ledgerRows, balanceRow, disputeRows } = await import('../src/normalize.mjs');
  const { openClose, ruleFix, disputedIds } = await import('../src/close.mjs');
  const { proposeWithClaude, MODEL } = await import('../src/claude.mjs');
  const rows = paypalRows(await fetchMonth(period));
  const b = await fetchBalances(period);
  const close = openClose({ paypal: rows, ledger: ledgerRows(await readFile(new URL(`../samples/sandbox-${period}-books.csv`, import.meta.url), 'utf8')), period, balances: { opening: balanceRow(b.opening), closing: balanceRow(b.closing) }, disputes: disputeRows(await fetchDisputes(disputedIds(rows))) });
  const proposals = [];
  for (const ex of close.exceptions.filter((e) => !ruleFix(close, e))) {
    const r = await proposeWithClaude(close, ex);
    console.error(`${ex.id}: ${r.fix.category} ${r.check.ok ? 'passes' : 'fails'} (${r.attempts.length} attempt(s))`);
    proposals.push({ exception: ex.id, paypal: ex.paypal, ledger: ex.ledger, attempts: r.attempts.length, fix: { category: r.fix.category, cites: r.fix.cites, lines: r.fix.lines, memo: r.fix.memo, explanation: r.fix.explanation, model: r.fix.model } });
  }
  rec = { recorded_at: new Date().toISOString(), model: MODEL, kind: 'paypal', period, how: `scripts/record.mjs --sandbox ${period}: closebook's sandbox account read live, one live proposal per exception.`, proposals };
} else { console.error('Pass --from <eval results.json> or --sandbox <YYYY-MM>.'); process.exit(1); }

const out = new URL(`../eval/${recordingName(rec.kind, rec.period)}`, import.meta.url);
await writeFile(out, JSON.stringify(rec, null, 2) + '\n');
console.error(`wrote ${out.pathname}: ${rec.proposals.length} proposals by ${rec.model}`);
