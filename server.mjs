// closebook web server. Each browser gets its own close (cookie session, kept in memory).
//   PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET  sandbox REST app with Transaction search enabled (optional)
//   ANTHROPIC_API_KEY                        for Claude's proposals (optional; without it only rules propose)
//   PAYPAL_ENVIRONMENT                       production to read a live account; sandbox otherwise
//   PORT                                     default 8080
// A .env file next to this one is loaded at startup if present (Node's own loader).
//   CLAUDE_CALLS_PER_SESSION                 default 80
//   CLAUDE_CALLS_PER_DAY                     server-wide cap for a public deploy, default 600
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, sep, normalize as normPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { demoMonth } from './src/demo.mjs';
import { paypalRows, ledgerRows, balanceRow, disputeRows } from './src/normalize.mjs';
import { openClose, disputedIds, ruleFix, propose, approve, reject, edit, summary, journal } from './src/close.mjs';
import { proposeWithClaude, narrateClose, MODEL } from './src/claude.mjs';
import { memoData, memoHtml, checkNarrative } from './src/memo.mjs';
import { fetchMonth, fetchBalances, fetchDisputes, paypalConfigured, probe, PayPalError } from './src/paypal.mjs';
import { CATEGORIES } from './src/codes.mjs';
import { loadRecording, recordedFix } from './src/recorded.mjs';
import { monthName } from './public/view.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// Run directly (`node server.mjs`), the server reads .env and listens. Imported (the tests), it
// does neither: the tests set the environment themselves and start it on a free port.
const MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (MAIN) { try { process.loadEnvFile(join(HERE, '.env')); } catch (e) { if (e.code !== 'ENOENT') console.warn(`[env] could not read .env: ${e.message}`); } }
const PUBLIC = join(HERE, 'public');
const PORT = Number(process.env.PORT ?? 8080);
// Read on every request, so a deploy (or a test) can change them without a restart of the logic.
const claudeLimit = () => Number(process.env.CLAUDE_CALLS_PER_SESSION ?? 80);
const claudeDaily = () => Number(process.env.CLAUDE_CALLS_PER_DAY ?? 600);
const MAX_SESSIONS = 2000;
const daily = { day: '', calls: 0 };
function takeDailyCall() {
  const today = new Date().toISOString().slice(0, 10);
  if (daily.day !== today) { daily.day = today; daily.calls = 0; }
  if (daily.calls >= claudeDaily()) return false;
  daily.calls++;
  return true;
}

const sessions = new Map(); // id -> { close, source, claudeCalls, touched }
const claudeReady = () => Boolean(process.env.ANTHROPIC_API_KEY);

function session(req, res) {
  const m = /(?:^|;\s*)cb=([0-9a-f-]{36})/.exec(req.headers.cookie ?? '');
  let id = m?.[1];
  if (!id || !sessions.has(id)) {
    id = randomUUID();
    if (sessions.size >= MAX_SESSIONS) { // drop the least recently used session
      let oldest = null;
      for (const [k, v] of sessions) if (!oldest || v.touched < sessions.get(oldest).touched) oldest = k;
      sessions.delete(oldest);
    }
    sessions.set(id, { close: null, source: null, claudeCalls: 0 });
    res.setHeader('set-cookie', `cb=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  }
  const s = sessions.get(id);
  s.touched = Date.now();
  return s;
}
setInterval(() => { const cut = Date.now() - 6 * 3600e3; for (const [k, s] of sessions) if (s.touched < cut) sessions.delete(k); }, 600e3).unref();

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

async function body(req, limit = 3_000_000) { // a 2 MB CSV, JSON-escaped, fits
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('The upload is too large: the books CSV can be at most 2 MB.'), { status: 413 }); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error('the request body is not JSON'), { status: 400 }); }
}

// The recording for the month this session has open: the demo month, or closebook's own sandbox
// account (one-click or uploaded books; a recorded proposal is used only for identical items).
// Why live AI suggestions are not available for this session, in words a person can use; null
// if they are. Counts a call against the daily limit when it says yes.
function aiUnavailable(s) {
  if (!claudeReady()) return 'AI suggestions aren\'t switched on here';
  if (s.claudeCalls >= claudeLimit()) return 'you\'ve used this session\'s AI suggestions';
  if (!takeDailyCall()) return 'today\'s AI suggestions are used up';
  return null;
}

const recordingOf = (s) => (s.close && s.source ? loadRecording(s.source.kind === 'demo' ? 'demo' : 'paypal', s.close.period) : null);

function view(s) {
  if (!s.close) return { close: null, config: config() };
  const c = s.close;
  return {
    config: config(),
    source: s.source,
    period: c.period, currency: c.currency, chart: c.chart,
    summary: summary(c),
    paypal: c.paypal, ledger: c.ledger, foreign: c.foreign,
    matches: c.matches,
    disputes: c.disputes ?? {},
    outside: c.outside ?? 0,
    exceptions: c.exceptions,
    decisions: c.decisions,
    claudeCallsLeft: claudeLimit() - s.claudeCalls,
    recorded: Boolean(recordingOf(s)), // recorded Claude proposals exist for this month

  };
}

let paypalStatus = { ok: false, status: null, message: 'not checked yet' };

function config() {
  return { claude: claudeReady(), model: MODEL, paypal: paypalConfigured(), paypalStatus, categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])) };
}

const csv = (rows) => rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
const dollars = (c) => (c ? (c / 100).toFixed(2) : '');

// Double-entry journal: one row per line, debits and credits in separate columns, every entry
// balanced, with who proposed it, who approved it and when, and the PayPal and book references.
function journalCsv(close) {
  const rows = [['entry_id', 'entry_date', 'account', 'account_name', 'debit', 'credit', 'currency', 'memo', 'category', 'proposed_by', 'approved_by', 'approved_at', 'exception', 'also_settles', 'paypal_transaction_ids', 'book_line_ids']];
  journal(close).forEach((f, i) => {
    for (const l of f.lines) rows.push([`JE-${close.period}-${String(i + 1).padStart(3, '0')}`, lastDay(close.period), l.account, close.chart[l.account], dollars(l.debit), dollars(l.credit), close.currency, f.memo, f.category, (f.by === 'claude' ? `claude (${f.model ?? ''})${f.recorded ? `, recorded ${f.recorded.at}` : ''}` : f.by) + (f.editedBy ? `, edited by ${f.editedBy}` : ''), f.approvedBy, f.approvedAt, f.exception, f.covers.join(' '), f.cites.paypal.join(' '), f.cites.ledger.join(' ')]);
  });
  return csv(rows);
}

// Audit trail: every decision in order, with the checks the entry passed at that moment.
function auditCsv(close) {
  const rows = [['at', 'exception', 'decision', 'category', 'proposed_by', 'reviewer', 'memo', 'reason']];
  for (const d of close.decisions) rows.push([d.at, d.exception, d.verdict, d.category, d.by, d.reviewer ?? '', d.memo, d.reason ?? '']);
  return csv(rows);
}

function lastDay(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.csv': 'text/csv' };

async function staticFile(req, res) {
  const path = new URL(req.url, 'http://x').pathname;
  const file = normPath(join(PUBLIC, path === '/' ? 'index.html' : path));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return json(res, 404, { error: 'not found' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch { json(res, 404, { error: 'not found' }); }
}

const SANDBOX = { period: '2026-11', file: join(HERE, 'samples', 'sandbox-2026-11-books.csv') };

export const MAX_CSV_BYTES = 2 * 1024 * 1024;

async function closeFromPayPal(s, res, period, ledgerCsv, label) {
  // The upload is checked before anything else, so a bad file gets a clear answer on any server.
  if (Buffer.byteLength(ledgerCsv ?? '', 'utf8') > MAX_CSV_BYTES) return json(res, 413, { error: 'Your file is larger than 2 MB. Upload one month of your PayPal account from your books.' });
  let ledger;
  try { ledger = ledgerRows(ledgerCsv ?? ''); } catch (e) { return json(res, 400, { error: `We couldn't read your file: ${e.message}` }); }
  if (!paypalConfigured()) return json(res, 400, { error: 'PayPal isn\'t connected here yet.' });
  if (!/^\d{4}-\d{2}$/.test(period ?? '')) return json(res, 400, { error: 'Pick a month first.' });
  if (ledger.length && !ledger.some((l) => l.date.startsWith(period))) return json(res, 400, { error: `None of the ${ledger.length} lines in your file is dated in ${monthName(period)}. Check the month you picked, or the dates in the file.` });
  let details, balances = null;
  try {
    // The balance read is a second check, not a requirement: if it fails, the close still opens.
    const [d, b] = await Promise.all([fetchMonth(period), fetchBalances(period).catch((e) => { console.warn(`[paypal] balances ${period}: ${e.message}`); return null; })]);
    details = d;
    if (b) balances = { opening: balanceRow(b.opening), closing: balanceRow(b.closing) };
  } catch (e) {
    console.error(`[paypal] ${period}: ${e.message}`);
    // The technical reason is in the log; the person gets what it means for them.
    if (e instanceof PayPalError) {
      if (e.status === 403 || e.status === 401) { paypalStatus = { ok: false, status: e.status, message: e.message }; return json(res, 502, { error: 'We couldn\'t open the PayPal account. It may need to be connected again.' }); }
      return json(res, 502, { error: 'PayPal isn\'t answering right now. Please try again in a few minutes.' });
    }
    return json(res, 400, { error: 'Pick a month that has already started.' });
  }
  if (!details.length) return json(res, 404, { error: `PayPal shows no activity for ${monthName(period)} yet. New payments can take up to three hours to show up.` });
  // Disputes behind any holds and chargebacks: extra context for the AI and the reviewer, never
  // required, so a failure only means the close opens without them.
  const rows = paypalRows(details);
  const disputes = disputeRows(await fetchDisputes(disputedIds(rows)).catch((e) => { console.warn(`[paypal] disputes ${period}: ${e.message}`); return {}; }));
  s.close = openClose({ paypal: rows, ledger, period, balances, disputes });
  s.source = { kind: 'paypal', label };
  return json(res, 200, view(s));
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/health' || p === '/api/health') return json(res, 200, { ok: true, claude: claudeReady(), paypal: paypalConfigured() ? (paypalStatus.ok ? 'ok' : 'error') : 'off', uptime_s: Math.round(process.uptime()) });
  if (!p.startsWith('/api/')) return staticFile(req, res);
  const s = session(req, res);

  if (req.method === 'GET' && p === '/api/close') return json(res, 200, view(s));

  if (req.method === 'POST' && p === '/api/close/demo') {
    const d = demoMonth();
    s.close = openClose({ paypal: paypalRows(d.transaction_details), ledger: ledgerRows(d.ledgerCsv), period: d.period, balances: { opening: balanceRow(d.balances.opening), closing: balanceRow(d.balances.closing) }, disputes: disputeRows(d.disputes) });
    s.source = { kind: 'demo', label: `Demo: ${d.shop} · ${monthName(d.period)}` };
    return json(res, 200, view(s));
  }

  if (req.method === 'POST' && p === '/api/close/paypal') {
    const { period, ledgerCsv } = await body(req);
    return closeFromPayPal(s, res, period, ledgerCsv, `Your PayPal · ${monthName(period)}`);
  }

  // One click for judges: closebook's own sandbox account, read live through Transaction Search,
  // against the books file committed in samples/.
  if (req.method === 'POST' && p === '/api/close/sandbox') {
    return closeFromPayPal(s, res, SANDBOX.period, await readFile(SANDBOX.file, 'utf8'), `Test shop on PayPal · ${monthName(SANDBOX.period)}`);
  }

  if (req.method === 'GET' && p === '/api/sandbox-books.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="test-shop-books-${SANDBOX.period}.csv"` });
    return res.end(await readFile(SANDBOX.file, 'utf8'));
  }

  if (req.method === 'GET' && p === '/api/demo-ledger.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="example-books.csv"' });
    return res.end(demoMonth().ledgerCsv + '\n');
  }

  if (!s.close) return json(res, 409, { error: 'Open a month first.' });
  const c = s.close;

  if (req.method === 'GET' && p === '/api/journal.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="closebook-${c.period}-journal.csv"` });
    return res.end(journalCsv(c));
  }

  if (req.method === 'GET' && p === '/api/audit.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="closebook-${c.period}-audit.csv"` });
    return res.end(auditCsv(c));
  }

  // The close memo: code-built numbers, plus a narrative from the AI only if every number and ID in
  // it is one of them. One AI call per state of the close, counted against the same limits.
  if (req.method === 'GET' && p === '/api/memo.html') {
    const d = memoData(c, s.source);
    const sig = JSON.stringify([d.tieout, d.counts]);
    let narrative = null, note = null;
    if (c.memoNarrative?.sig === sig) ({ narrative, note } = c.memoNarrative);
    else {
      const unavailable = aiUnavailable(s);
      if (unavailable) note = `No summary paragraph this time: the AI isn't available (${unavailable}). Every figure below comes straight from your data.`;
      else {
        s.claudeCalls++;
        try {
          const text = await narrateClose(d);
          const verdict = checkNarrative(text, d);
          if (verdict.ok) narrative = text;
          else note = `The AI's summary paragraph was left out because it mentioned ${verdict.problems.slice(0, 3).join(', ')}, which ${verdict.problems.length > 1 ? 'aren\'t' : 'isn\'t'} in the figures below. Every figure below comes straight from your data.`;
        } catch (e) { console.warn(`[claude] memo: ${e.message}`); note = 'No summary paragraph this time: the AI didn\'t respond. Every figure below comes straight from your data.'; }
      }
      c.memoNarrative = { sig, narrative, note };
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(memoHtml(d, { narrative, note }));
  }

  if (req.method === 'POST' && p === '/api/rules') {
    for (const e of c.exceptions) if (e.status === 'open' && e.source === 'fee' && !e.fix) propose(c, e.id, ruleFix(c, e));
    return json(res, 200, view(s));
  }

  const m = /^\/api\/exceptions\/([^/]+)\/(propose|approve|reject|edit)$/.exec(p);
  if (req.method === 'POST' && m) {
    const [, id, action] = m;
    const ex = c.exceptions.find((e) => e.id === decodeURIComponent(id));
    if (!ex) return json(res, 404, { error: 'That item isn\'t here any more. Reload the page.' });
    if (action === 'propose') {
      if (ex.status !== 'open') return json(res, 200, { skipped: true, ...view(s) });
      const rule = ruleFix(c, ex);
      if (rule) { propose(c, ex.id, rule); return json(res, 200, view(s)); }
      // Live if possible; otherwise Claude's recorded proposal for this month, checked now like a
      // live one; otherwise a plain answer that Claude is unavailable and rule fixes still work.
      const unavailable = aiUnavailable(s);
      let live = null, failure = unavailable;
      if (!unavailable) {
        s.claudeCalls++;
        try { live = await proposeWithClaude(c, ex); } catch (e) { console.warn(`[claude] ${ex.id}: ${e.message}`); failure = 'the AI didn\'t respond'; }
      }
      if (ex.status !== 'open') return json(res, 200, { skipped: true, ...view(s) });
      if (live) {
        propose(c, ex.id, live.fix);
        ex.attempts = live.attempts.length;
        ex.firstFailures = live.attempts.length > 1 ? live.attempts[0].check.failures : null;
        return json(res, 200, view(s));
      }
      const rec = recordedFix(recordingOf(s), ex);
      if (rec) {
        propose(c, ex.id, { ...rec, recorded: { ...rec.recorded, why: failure } });
        ex.attempts = null; ex.firstFailures = null;
        return json(res, 200, { fallback: failure, ...view(s) });
      }
      return json(res, 503, { error: `The AI isn't available right now (${failure}), and there's no saved suggestion for this item. You can still fix it by hand, and the PayPal fee fixes still work.` });
    }
    // A refused approval (checks fail, nothing proposed, already settled) is the reviewer's to fix: 409.
    if (action === 'approve') { try { approve(c, ex.id); } catch (e) { return json(res, 409, { error: e.message }); } return json(res, 200, view(s)); }
    if (action === 'edit') {
      const { category, lines, memo, cites } = await body(req);
      const okIds = (xs) => Array.isArray(xs) && xs.length <= 50 && xs.every((x) => typeof x === 'string' && x.length <= 64);
      if (cites !== undefined && !(cites && okIds(cites.paypal) && okIds(cites.ledger))) return json(res, 400, { error: 'cites must be { paypal: [ids], ledger: [ids] }' });
      // Shape only; whether the entry is right is for the checks, which run inside edit().
      const okLine = (l) => l && typeof l.account === 'string' && l.account.length <= 10 && [l.debit ?? 0, l.credit ?? 0].every((v) => Number.isInteger(v) && v >= 0 && v < 1e13);
      if (lines !== undefined && (!Array.isArray(lines) || lines.length > 20 || !lines.every(okLine))) return json(res, 400, { error: 'lines must be up to 20 of { account, debit, credit } in whole cents' });
      if (category !== undefined && !(category in CATEGORIES)) return json(res, 400, { error: `unknown category ${category}` });
      try { edit(c, ex.id, { category, cites: cites && { paypal: [...cites.paypal], ledger: [...cites.ledger] }, lines: lines?.map((l) => ({ account: l.account, debit: l.debit ?? 0, credit: l.credit ?? 0 })), memo: memo === undefined ? undefined : String(memo).slice(0, 200) }); }
      catch (e) { return json(res, 409, { error: e.message }); }
      return json(res, 200, view(s));
    }
    if (action === 'reject') { const { reason } = await body(req); try { reject(c, ex.id, String(reason ?? '').slice(0, 500)); } catch (e) { return json(res, 409, { error: e.message }); } return json(res, 200, view(s)); }
  }
  json(res, 404, { error: 'not found' });
}

export function start(port = PORT, { quiet = false } = {}) {
  const server = createServer((req, res) => {
    route(req, res).catch((e) => { if (!e.status || e.status >= 500) console.error(e); if (!res.headersSent) json(res, e.status ?? 500, { error: e.status && e.status < 500 ? e.message : 'Something went wrong on our side. Please try again.' }); });
  });
  return new Promise((resolve) => server.listen(port, async () => {
    if (!quiet) console.log(`closebook on http://localhost:${server.address().port}  claude:${claudeReady() ? MODEL : 'off'}  paypal:${paypalConfigured() ? 'on' : 'off'}`);
    resolve(server);
    if (paypalConfigured()) {
      paypalStatus = await probe();
      if (!quiet) console[paypalStatus.ok ? 'log' : 'warn'](`[paypal] startup check: ${paypalStatus.message}`);
    } else paypalStatus = { ok: false, status: null, message: 'PayPal credentials are not set; only the demo month is available.' };
  }));
}

if (MAIN) {
  const server = await start();
  // Render and most hosts send SIGTERM before stopping an instance: finish requests in flight, then exit.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      console.log(`[server] ${sig}: closing`);
      server.close(() => process.exit(0));
      server.closeIdleConnections?.();
      setTimeout(() => process.exit(0), 10_000).unref();
    });
  }
}
