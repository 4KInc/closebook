// closebook web server. Each browser gets its own close (cookie session, kept in memory).
//   PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET  sandbox REST app with Transaction search enabled (optional)
//   ANTHROPIC_API_KEY                        for Claude's proposals (optional; without it only rules propose)
//   PORT                                     default 8080
//   CLAUDE_CALLS_PER_SESSION                 default 80
//   CLAUDE_CALLS_PER_DAY                     server-wide cap for a public deploy, default 600
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize as normPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoMonth } from './src/demo.mjs';
import { paypalRows, ledgerRows } from './src/normalize.mjs';
import { openClose, ruleFix, propose, approve, reject, summary, journal } from './src/close.mjs';
import { proposeWithClaude, MODEL } from './src/claude.mjs';
import { fetchMonth, paypalConfigured } from './src/paypal.mjs';
import { CATEGORIES } from './src/codes.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, 'public');
const PORT = Number(process.env.PORT ?? 8080);
const CLAUDE_LIMIT = Number(process.env.CLAUDE_CALLS_PER_SESSION ?? 80);
const CLAUDE_DAILY = Number(process.env.CLAUDE_CALLS_PER_DAY ?? 600);
const MAX_SESSIONS = 2000;
const daily = { day: '', calls: 0 };
function takeDailyCall() {
  const today = new Date().toISOString().slice(0, 10);
  if (daily.day !== today) { daily.day = today; daily.calls = 0; }
  if (daily.calls >= CLAUDE_DAILY) return false;
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

async function body(req, limit = 2_000_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('request too large'), { status: 413 }); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

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
    exceptions: c.exceptions,
    decisions: c.decisions,
    claudeCallsLeft: CLAUDE_LIMIT - s.claudeCalls,
  };
}

function config() {
  return { claude: claudeReady(), model: MODEL, paypal: paypalConfigured(), categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])) };
}

function journalCsv(close) {
  const rows = [['entry', 'exception', 'date', 'account', 'account_name', 'debit', 'credit', 'memo', 'proposed_by', 'paypal_ids', 'book_lines']];
  journal(close).forEach((f, i) => {
    for (const l of f.lines) rows.push([`JE-${String(i + 1).padStart(3, '0')}`, f.exception, `${close.period}-01`, l.account, close.chart[l.account], (l.debit / 100).toFixed(2), (l.credit / 100).toFixed(2), f.memo, f.by, f.cites.paypal.join(' '), f.cites.ledger.join(' ')]);
  });
  return rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.csv': 'text/csv' };

async function staticFile(req, res) {
  const path = new URL(req.url, 'http://x').pathname;
  const file = normPath(join(PUBLIC, path === '/' ? 'index.html' : path));
  if (!file.startsWith(PUBLIC)) return json(res, 404, { error: 'not found' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch { json(res, 404, { error: 'not found' }); }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (!p.startsWith('/api/')) return staticFile(req, res);
  const s = session(req, res);

  if (req.method === 'GET' && p === '/api/close') return json(res, 200, view(s));

  if (req.method === 'POST' && p === '/api/close/demo') {
    const d = demoMonth();
    s.close = openClose({ paypal: paypalRows(d.transaction_details), ledger: ledgerRows(d.ledgerCsv), period: d.period });
    s.source = { kind: 'demo', label: `Demo month: ${d.shop}, ${d.period}` };
    return json(res, 200, view(s));
  }

  if (req.method === 'POST' && p === '/api/close/paypal') {
    const { period, ledgerCsv } = await body(req);
    if (!paypalConfigured()) return json(res, 400, { error: 'PayPal credentials are not configured on this server' });
    const ledger = ledgerRows(ledgerCsv ?? '');
    const details = await fetchMonth(period);
    s.close = openClose({ paypal: paypalRows(details), ledger, period });
    s.source = { kind: 'paypal', label: `PayPal sandbox, ${period}` };
    return json(res, 200, view(s));
  }

  if (req.method === 'GET' && p === '/api/demo-ledger.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="demo-ledger.csv"' });
    return res.end(demoMonth().ledgerCsv + '\n');
  }

  if (!s.close) return json(res, 409, { error: 'open a month first' });
  const c = s.close;

  if (req.method === 'GET' && p === '/api/journal.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="closebook-${c.period}-journal.csv"` });
    return res.end(journalCsv(c));
  }

  if (req.method === 'POST' && p === '/api/rules') {
    for (const e of c.exceptions) if (e.status === 'open' && e.source === 'fee' && !e.fix) propose(c, e.id, ruleFix(c, e));
    return json(res, 200, view(s));
  }

  const m = /^\/api\/exceptions\/([^/]+)\/(propose|approve|reject)$/.exec(p);
  if (req.method === 'POST' && m) {
    const [, id, action] = m;
    const ex = c.exceptions.find((e) => e.id === decodeURIComponent(id));
    if (!ex) return json(res, 404, { error: 'no such exception' });
    if (action === 'propose') {
      if (ex.status !== 'open') return json(res, 200, { skipped: true, ...view(s) });
      const rule = ruleFix(c, ex);
      if (rule) { propose(c, ex.id, rule); return json(res, 200, view(s)); }
      if (!claudeReady()) return json(res, 400, { error: 'ANTHROPIC_API_KEY is not set on this server, so only rule fixes are available' });
      if (s.claudeCalls >= CLAUDE_LIMIT) return json(res, 429, { error: 'this session has used its Claude proposals; reload the month to start over' });
      if (!takeDailyCall()) return json(res, 429, { error: 'this server has used its Claude proposals for today; rule fixes still work' });
      s.claudeCalls++;
      const r = await proposeWithClaude(c, ex);
      if (ex.status !== 'open') return json(res, 200, { skipped: true, ...view(s) });
      propose(c, ex.id, r.fix);
      ex.attempts = r.attempts.length;
      ex.firstFailures = r.attempts.length > 1 ? r.attempts[0].check.failures : null;
      return json(res, 200, view(s));
    }
    if (action === 'approve') { approve(c, ex.id); return json(res, 200, view(s)); }
    if (action === 'reject') { const { reason } = await body(req); reject(c, ex.id, String(reason ?? '').slice(0, 500)); return json(res, 200, view(s)); }
  }
  json(res, 404, { error: 'not found' });
}

createServer((req, res) => {
  route(req, res).catch((e) => { console.error(e); if (!res.headersSent) json(res, e.status ?? 500, { error: e.message }); });
}).listen(PORT, () => console.log(`closebook on http://localhost:${PORT}  claude:${claudeReady() ? MODEL : 'off'}  paypal:${paypalConfigured() ? 'on' : 'off'}`));
