// The close memo: one printable page for the controller. Code writes every number. Claude may add
// a short narrative from those numbers, and code checks it: a narrative that mentions any number,
// account or ID that is not in the summary below is dropped, and the memo says so.
import { fmt } from './money.mjs';
import { CHART, CLEARING } from './check.mjs';
import { CATEGORIES } from './codes.mjs';
import { journal, summary } from './close.mjs';
import { monthName, day } from '../public/view.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const moved = (lines) => lines.reduce((a, l) => a + (l.account === CLEARING ? (l.debit || 0) - (l.credit || 0) : 0), 0);

export function memoData(close, source) {
  const s = summary(close);
  const j = journal(close);
  const byCat = new Map();
  for (const f of j) {
    const c = byCat.get(f.category) ?? { category: f.category, label: CATEGORIES[f.category]?.label ?? f.category, entries: 0, moved: 0, debits: 0 };
    c.entries++; c.moved += moved(f.lines); c.debits += f.lines.reduce((a, l) => a + (l.debit || 0), 0);
    byCat.set(f.category, c);
  }
  const ex = close.exceptions;
  return {
    period: close.period,
    source: source?.label ?? '',
    currency: close.currency,
    balance: s.balance ? { opening: s.balance.opening.total, closing: s.balance.closing.total, openingAt: s.balance.opening.asOf ?? s.balance.opening.asked, closingAt: s.balance.closing.asOf ?? s.balance.closing.asked, moved: s.balance.moved, activity: s.balance.activity, gap: s.balance.gap } : null,
    tieout: { paypalNet: s.paypalNet, booksBefore: s.books - s.adjustments, booksAfter: s.books, before: s.difference + s.adjustments, adjustments: s.adjustments, after: s.difference },
    categories: [...byCat.values()].sort((a, b) => Math.abs(b.moved) - Math.abs(a.moved)),
    counts: {
      exceptions: ex.length, matched: s.matched, approved: s.approved, settledWithAnother: s.covered, open: s.open,
      byRule: j.filter((f) => f.by === 'rule' && !f.editedBy).length,
      byClaude: j.filter((f) => f.by === 'claude' && !f.editedBy && !f.recorded).length,
      recorded: j.filter((f) => f.recorded && !f.editedBy).length,
      corrected: j.filter((f) => f.editedBy).length,
      rejected: close.decisions.filter((d) => d.verdict === 'rejected').length,
    },
    rejected: close.decisions.filter((d) => d.verdict === 'rejected').map((d) => ({ exception: d.exception, category: d.category, by: d.by, memo: d.memo, reason: d.reason, at: d.at })),
    flags: ex.filter((e) => e.flags?.length).map((e) => ({ exception: e.id, status: e.status, flags: e.flags, category: e.fix?.category ?? null })),
    approvals: j.map((f) => ({ exception: f.exception, category: f.category, by: (f.by === 'claude' ? 'AI' : 'closebook (standard fix)') + (f.recorded ? ', saved suggestion' : '') + (f.editedBy ? ', changed by you' : ''), reviewer: f.approvedBy === 'reviewer' || !f.approvedBy ? 'you' : f.approvedBy, at: f.approvedAt, lines: f.lines, memo: f.memo, covers: f.covers })),
  };
}

// Every number, account and ID the narrative is allowed to mention: the ones in the summary.
export function allowedTokens(d) {
  const nums = new Set(), ids = new Set();
  const addMoney = (c) => { if (!Number.isFinite(c)) return; const a = fmt(Math.abs(c)).replace('$', ''); nums.add(a.replace(/,/g, '')); nums.add(a.replace(/,/g, '').replace(/\.00$/, '')); };
  const addNum = (n) => nums.add(String(n));
  if (d.balance) for (const v of [d.balance.opening, d.balance.closing, d.balance.moved, d.balance.activity, d.balance.gap]) addMoney(v);
  for (const v of Object.values(d.tieout)) addMoney(v);
  for (const c of d.categories) { addMoney(c.moved); addMoney(c.debits); addNum(c.entries); }
  for (const v of Object.values(d.counts)) addNum(v);
  for (const a of d.approvals) { ids.add(a.exception); for (const l of a.lines) { addNum(l.account); addMoney(l.debit || l.credit); } }
  for (const r of d.rejected) ids.add(r.exception);
  for (const f of d.flags) ids.add(f.exception);
  addNum(d.flags.length); // the narrative's input says how many items were flagged
  const [y, m] = d.period.split('-');
  addNum(y); addNum(Number(m)); addNum(m);
  for (const code of Object.keys(CHART)) if ([...d.approvals].some((a) => a.lines.some((l) => l.account === code))) addNum(code);
  return { nums, ids };
}

// The narrative is kept only if every number and ID in it is one of the summary's.
export function checkNarrative(text, d) {
  if (!text?.trim()) return { ok: false, problems: ['empty'] };
  const { nums, ids } = allowedTokens(d);
  const problems = [];
  // IDs first (letters and digits mixed, like 3A1F13556DEMO0010 or X-L036), then the numbers left.
  let rest = text;
  for (const m of text.matchAll(/\bX-[A-Z0-9-]+\b|\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,}\b/g)) {
    if (!ids.has(m[0]) && !ids.has(`X-${m[0]}`)) problems.push(`id ${m[0]}`);
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, '').replace(/\.$/, '');
    if (!nums.has(n) && !nums.has(n.replace(/\.00$/, ''))) problems.push(`number ${m[0]}`);
  }
  return { ok: problems.length === 0, problems };
}

const money = (c) => esc(fmt(c));
const OUTCOME = { approved: 'Approved', covered: 'Fixed together with another item', open: 'Still to review' };
const when = (t) => esc(day(t));

// The summary as CSV rows: the same figures as the page, one row per figure, amounts in dollars.
export function memoCsvRows(d) {
  const $ = (c) => (c / 100).toFixed(2);
  const t = d.tieout, b = d.balance, c = d.counts;
  const rows = [['section', 'item', 'count', 'amount', 'detail']];
  const add = (section, item, count = '', amount = '', detail = '') => rows.push([section, item, count, amount, detail]);
  add('Summary', 'Month', '', '', d.period); add('Summary', 'Source', '', '', d.source); add('Summary', 'Currency', '', '', d.currency);
  add('The month', 'Money in and out of PayPal this month', '', $(t.paypalNet));
  add('The month', 'What your books said, as uploaded', '', $(t.booksBefore));
  add('The month', 'Difference before any fixes', '', $(t.before));
  add('The month', 'Approved fixes, total change to PayPal in your books', '', $(t.adjustments));
  add('The month', 'Difference now', '', $(t.after));
  if (b) {
    add('PayPal balance', `On ${b.openingAt?.slice(0, 10) ?? ''}`, '', $(b.opening));
    add('PayPal balance', `On ${b.closingAt?.slice(0, 10) ?? ''}`, '', $(b.closing));
    add('PayPal balance', 'Change', '', $(b.moved));
    add('PayPal balance', 'Total of the PayPal payments we read', '', $(b.activity));
    add('PayPal balance', 'Not in the payments we read', '', $(b.gap));
  }
  for (const x of d.categories) add('Fixes by type', x.label, x.entries, $(x.moved), `debits ${$(x.debits)}`);
  add('Who suggested what', 'Items to review', c.exceptions, '', `after ${c.matched} lines matched automatically`);
  add('Who suggested what', 'Approved standard fixes (PayPal fees)', c.byRule);
  add('Who suggested what', 'Approved AI suggestions', c.byClaude);
  add('Who suggested what', 'Approved saved AI suggestions', c.recorded);
  add('Who suggested what', 'Approved fixes you changed first', c.corrected);
  add('Who suggested what', 'Items fixed together with another', c.settledWithAnother);
  add('Who suggested what', 'Suggestions you rejected', c.rejected);
  add('Who suggested what', 'Items still to review', c.open);
  for (const f of d.flags) for (const x of f.flags) add('Flagged text', f.exception, '', '', `${x.field}: "${x.text}" (${OUTCOME[f.status] ?? f.status})`);
  for (const r of d.rejected) add('Rejected', r.exception, '', '', `${CATEGORIES[r.category]?.label ?? r.category}: ${r.memo}; reason: ${r.reason || '(none given)'}`);
  for (const x of d.approvals) add('Approved fixes', x.exception, '', $(x.lines.reduce((a, l) => a + (l.debit || 0), 0)), `${CATEGORIES[x.category]?.label ?? x.category}; ${x.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.account} ${$(l.debit || l.credit)}`).join(', ')}; suggested by ${x.by}; approved by ${x.reviewer} ${x.at ?? ''}`);
  return rows;
}

export function memoHtml(d, { narrative = null, note = null } = {}) {
  const b = d.balance, t = d.tieout, c = d.counts;
  const rows = (xs, f) => xs.map(f).join('');
  const tied = t.after === 0;
  const maxMoved = Math.max(1, ...d.categories.map((x) => Math.abs(x.moved)));
  const fixes = d.categories.reduce((a, x) => a + x.entries, 0);
  // Who suggested the approved fixes, as one stacked bar.
  const who = [['Standard fix', c.byRule, 'w-rule'], ['AI', c.byClaude, 'w-ai'], ['Saved AI', c.recorded, 'w-saved'], ['Changed by you', c.corrected, 'w-you']].filter(([, n]) => n > 0);
  const whoTotal = who.reduce((a, [, n]) => a + n, 0) || 1;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Month-end summary · ${esc(monthName(d.period))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Gloock&family=IBM+Plex+Mono:wght@400;500;600&family=Public+Sans:wght@400;500;600;700&display=swap">
<style>
:root { --paper: #fbfcf8; --sheet: #fff; --ink: #16241d; --ink-2: #55675d; --rule: #cfdccb; --bar: #e9f2e6; --red: #b42318; --red-bg: #fbe9e6; --green: #0f5a3c; --amber: #8a5a00; --amber-bg: #fbf0d4; --claude: #9a4a17; --claude-bg: #f6e8dc; --stamp: #2f3c9e;
  --display: "Gloock", Georgia, serif; --sans: "Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif; --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace; }
@media (prefers-color-scheme: dark) { :root { --paper: #0d1411; --sheet: #121c17; --ink: #e3ebe5; --ink-2: #94a69b; --rule: #25362d; --bar: #15231c; --red: #ff8274; --red-bg: #361a17; --green: #63c79c; --amber: #f2c46a; --amber-bg: #2f2612; --claude: #f2a46e; --claude-bg: #33231a; --stamp: #a5aefc; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
.bar-top { position: sticky; top: 0; z-index: 2; background: var(--green); color: #fbfcf8; }
.bar-top .in { max-width: 960px; margin: 0 auto; padding: 10px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.brand { font: 22px/1 var(--display); }
.brand small { font: 500 11px var(--mono); letter-spacing: .1em; text-transform: uppercase; opacity: .8; margin-left: 10px; }
.tools { display: flex; gap: 8px; }
.btn { font: 600 13px var(--sans); padding: 8px 14px; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 7px; border: 1px solid rgba(251,252,248,.5); color: #fbfcf8; background: transparent; }
.btn:hover { background: rgba(251,252,248,.12); }
.btn.solid { background: #fbfcf8; color: #0f5a3c; border-color: #fbfcf8; }
.btn.solid:hover { background: #e9f2e6; }
.btn svg { width: 15px; height: 15px; }
main { max-width: 960px; margin: 0 auto; padding: 28px 20px 56px; display: grid; gap: 18px; }
.eyebrow { font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .12em; color: var(--green); }
.hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px 24px; flex-wrap: wrap; }
h1 { font: 400 clamp(28px, 4.4vw, 40px)/1.08 var(--display); margin: 6px 0 6px; letter-spacing: -.01em; }
.meta { font: 12px var(--mono); color: var(--ink-2); }
.stamp { font: 800 15px/1 var(--sans); letter-spacing: .18em; text-transform: uppercase; color: var(--stamp); border: 2.5px solid currentColor; outline: 1px solid currentColor; outline-offset: 2px; border-radius: 3px; padding: 8px 12px 7px; transform: rotate(-7deg); white-space: nowrap; }
.stamp.open { color: var(--red); }
.card { background: var(--sheet); border: 1px solid var(--rule); border-radius: 12px; padding: 18px 20px; }
.card h2 { font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .1em; color: var(--ink-2); margin: 0 0 14px; display: flex; justify-content: space-between; gap: 10px; }
.card h2 span { text-transform: none; letter-spacing: 0; font-weight: 500; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.kpi { background: var(--sheet); border: 1px solid var(--rule); border-radius: 12px; padding: 14px 16px; display: grid; gap: 4px; align-content: start; }
.kpi .k { font: 600 10.5px var(--mono); text-transform: uppercase; letter-spacing: .1em; color: var(--ink-2); }
.kpi .v { font: 500 24px/1.15 var(--mono); font-variant-numeric: tabular-nums; letter-spacing: -.02em; white-space: nowrap; }
.kpi .s { font-size: 12px; color: var(--ink-2); }
.kpi.good { border-color: color-mix(in srgb, var(--green) 45%, var(--rule)); background: color-mix(in srgb, var(--green) 6%, var(--sheet)); }
.neg { color: var(--red); } .zero { color: var(--green); }
.narrative { margin: 0; font-size: 15px; line-height: 1.6; border-left: 3px solid var(--claude); padding-left: 14px; }
.note { color: var(--ink-2); font-size: 12px; margin-top: 8px; }
.ai-tag { font: 600 10px var(--mono); letter-spacing: .08em; color: var(--claude); background: var(--claude-bg); border-radius: 4px; padding: 2px 6px; }
/* The difference, step by step to zero */
.flow { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; align-items: center; gap: 10px; text-align: center; }
.flow .step { background: var(--paper); border: 1px solid var(--rule); border-radius: 10px; padding: 12px 8px; display: grid; gap: 2px; }
.flow .step b { font: 500 20px var(--mono); font-variant-numeric: tabular-nums; }
.flow .step span { font-size: 12px; color: var(--ink-2); }
.flow .arrow { color: var(--ink-2); font: 18px var(--mono); }
.cats { display: grid; gap: 10px; margin-top: 18px; }
.cat { display: grid; grid-template-columns: minmax(130px, 220px) minmax(0, 1fr) 96px; gap: 12px; align-items: center; font-size: 13px; }
.cat .lbl { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; }
.cat .lbl em { font: normal 500 11px var(--mono); color: var(--ink-2); background: var(--bar); border-radius: 999px; padding: 1px 7px; flex: none; }
.cat .track { height: 12px; background: var(--bar); border-radius: 999px; overflow: hidden; }
.cat .fill { display: block; height: 100%; background: var(--green); border-radius: 999px; opacity: .85; }
.cat .amt { font: 500 13px var(--mono); text-align: right; font-variant-numeric: tabular-nums; }
.empty { color: var(--ink-2); font-size: 13px; margin: 0; }
/* Balance */
.bal { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.bal div { display: grid; gap: 2px; }
.bal span { font-size: 12px; color: var(--ink-2); }
.bal b { font: 500 18px var(--mono); font-variant-numeric: tabular-nums; }
.check { margin-top: 14px; display: flex; align-items: center; gap: 10px; border-radius: 8px; padding: 9px 12px; font-size: 13px; background: color-mix(in srgb, var(--green) 9%, var(--sheet)); color: var(--green); font-weight: 600; }
.check.off { background: var(--red-bg); color: var(--red); }
.check .n { margin-left: auto; font: 600 13px var(--mono); }
/* Who suggested */
.two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
.stack { display: flex; height: 14px; border-radius: 999px; overflow: hidden; background: var(--bar); }
.stack i { display: block; height: 100%; }
.w-rule { background: var(--ink-2); } .w-ai { background: var(--claude); } .w-saved { background: var(--stamp); } .w-you { background: var(--amber); }
.legend { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 6px; font-size: 13px; }
.legend li { display: flex; align-items: center; gap: 8px; }
.legend li i { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.legend li b { margin-left: auto; font: 600 13px var(--mono); }
.mini { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
.mini div { background: var(--paper); border: 1px solid var(--rule); border-radius: 8px; padding: 8px 10px; display: grid; }
.mini b { font: 600 17px var(--mono); }
.mini span { font-size: 11.5px; color: var(--ink-2); }
/* Flags and rejections */
.items { display: grid; gap: 8px; }
.item { border-radius: 8px; padding: 10px 12px; display: grid; gap: 3px; font-size: 13px; background: var(--paper); border: 1px solid var(--rule); }
.item.flag { background: var(--red-bg); border-color: transparent; border-left: 3px solid var(--red); }
.item .top { display: flex; justify-content: space-between; gap: 10px; font: 11.5px var(--mono); color: var(--ink-2); flex-wrap: wrap; }
.item q { color: var(--red); font-weight: 500; }
/* The approved fixes table, folded */
details.list summary { cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: center; font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .1em; color: var(--ink-2); }
details.list summary::-webkit-details-marker { display: none; }
details.list summary::after { content: "Show"; font: 600 12px var(--sans); text-transform: none; letter-spacing: 0; color: var(--green); }
details.list[open] summary::after { content: "Hide"; }
details.list[open] summary { margin-bottom: 12px; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 12.5px; }
th { text-align: left; font: 600 10px var(--mono); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); padding: 6px 8px; border-bottom: 1px solid var(--rule); }
td { padding: 7px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; }
.ref { font: 11.5px var(--mono); color: var(--ink-2); overflow-wrap: anywhere; }
.sub { display: block; font: 11px var(--mono); color: var(--ink-2); }
.when { white-space: nowrap; }
@media (max-width: 760px) { .kpis { grid-template-columns: 1fr 1fr; } .two, .bal { grid-template-columns: 1fr; } .flow { grid-template-columns: 1fr; } .flow .arrow { transform: rotate(90deg); } .cat { grid-template-columns: minmax(0, 1fr) 90px; } .cat .track { grid-column: 1 / -1; grid-row: 2; } }
@media print { .bar-top { position: static; } .tools { display: none; } body { background: #fff; font-size: 12px; } main { padding: 12px 0; } .card, .kpi { break-inside: avoid; } @page { margin: 12mm; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>
<header class="bar-top"><div class="in"><span class="brand">closebook<small>Month-end summary</small></span>
<div class="tools"><a class="btn solid" href="/api/memo.csv" download><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11"/></svg>Download CSV</a><button class="btn" onclick="window.print()"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M4 6V2h8v4M4 12H2.5V6.5h11V12H12M4 9.5h8V14H4z"/></svg>Print</button></div></div></header>
<main>
<section class="hero"><div><div class="eyebrow">${esc(d.source)} · ${esc(d.currency)}</div>
<h1>${esc(monthName(d.period))}: ${tied ? 'your books match PayPal' : `${money(t.after)} still to fix`}</h1>
<div class="meta">Prepared ${when(new Date().toISOString())}</div></div>
<span class="stamp ${tied ? '' : 'open'}">${tied ? 'Tied out' : 'Open'}</span></section>

<section class="kpis">
<div class="kpi"><span class="k">Difference at the start</span><span class="v ${t.before ? 'neg' : 'zero'}">${money(t.before)}</span><span class="s">PayPal vs. your books</span></div>
<div class="kpi ${tied ? 'good' : ''}"><span class="k">Difference now</span><span class="v ${t.after ? 'neg' : 'zero'}">${money(t.after)}</span><span class="s">${tied ? 'Nothing left to fix' : 'Still to fix'}</span></div>
<div class="kpi"><span class="k">Fixes approved</span><span class="v">${fixes}</span><span class="s">${c.matched} lines matched on their own</span></div>
<div class="kpi ${c.open ? '' : 'good'}"><span class="k">Still to review</span><span class="v ${c.open ? 'neg' : 'zero'}">${c.open}</span><span class="s">of ${c.exceptions} items</span></div>
</section>

${narrative ? `<section class="card"><h2>In short <span class="ai-tag">AI</span></h2><p class="narrative">${esc(narrative)}</p><div class="note">Written by the AI from the figures below. closebook checked that every number in it is one of them.</div></section>` : note ? `<section class="card"><div class="note" style="margin:0">${esc(note)}</div></section>` : ''}

<section class="card"><h2>How the difference went to zero</h2>
<div class="flow"><div class="step"><span>At the start</span><b class="${t.before ? 'neg' : 'zero'}">${money(t.before)}</b></div><span class="arrow">→</span>
<div class="step"><span>Approved fixes</span><b>${money(t.adjustments)}</b></div><span class="arrow">→</span>
<div class="step"><span>Difference now</span><b class="${t.after ? 'neg' : 'zero'}">${money(t.after)}</b></div></div>
<div class="cats">${rows(d.categories, (x) => `<div class="cat"><span class="lbl">${esc(x.label)}<em>${x.entries}</em></span><span class="track"><span class="fill" style="width:${Math.max(2, Math.round((Math.abs(x.moved) / maxMoved) * 100))}%"></span></span><span class="amt">${money(x.moved)}</span></div>`) || '<p class="empty">No fixes approved yet.</p>'}</div>
<div class="note">Money in and out of PayPal this month ${money(t.paypalNet)} · your books as uploaded ${money(t.booksBefore)}</div>
</section>

<div class="two">
${b ? `<section class="card"><h2>Your PayPal balance</h2>
<div class="bal"><div><span>On ${when(b.openingAt)}</span><b>${money(b.opening)}</b></div><div><span>On ${when(b.closingAt)}</span><b>${money(b.closing)}</b></div><div><span>Change</span><b>${money(b.moved)}</b></div></div>
<div class="check ${b.gap ? 'off' : ''}">${b.gap === 0 ? '✓ Every PayPal payment is accounted for' : '✗ Not in the payments we read'}<span class="n">${money(b.gap)}</span></div>
<div class="note">Total of the PayPal payments we read: ${money(b.activity)}</div></section>` : ''}
<section class="card"><h2>Who suggested the fixes</h2>
<div class="stack" role="img" aria-label="${who.map(([l, n]) => `${l} ${n}`).join(', ') || 'No fixes yet'}">${who.map(([, n, cls]) => `<i class="${cls}" style="width:${(n / whoTotal) * 100}%"></i>`).join('')}</div>
<ul class="legend">${who.map(([l, n, cls]) => `<li><i class="${cls}"></i>${esc(l)}<b>${n}</b></li>`).join('') || '<li>No fixes approved yet.</li>'}</ul>
<div class="mini"><div><b>${c.settledWithAnother}</b><span>fixed with another</span></div><div><b>${c.rejected}</b><span>rejected</span></div><div><b class="${c.open ? 'neg' : ''}">${c.open}</b><span>still to review</span></div></div>
</section>
</div>

${d.flags.length ? `<section class="card"><h2>Text that tried to give the AI instructions <span>${d.flags.length}</span></h2><div class="items">
${rows(d.flags, (f) => rows(f.flags, (x) => `<div class="item flag"><div class="top"><span>${esc(f.exception)} · ${esc(x.field)}</span><span>${esc(OUTCOME[f.status] ?? f.status)}${f.category ? `: ${esc(CATEGORIES[f.category]?.label ?? f.category)}` : ''}</span></div><q>${esc(x.text)}</q></div>`))}
</div></section>` : ''}

${d.rejected.length ? `<section class="card"><h2>Suggestions you rejected <span>${d.rejected.length}</span></h2><div class="items">
${rows(d.rejected, (r) => `<div class="item"><div class="top"><span>${esc(r.exception)}</span><span class="when">${when(r.at)}</span></div><span>${esc(CATEGORIES[r.category]?.label ?? r.category)} by ${esc(r.by === 'claude' ? 'the AI' : 'closebook')}: ${esc(r.memo)}</span><span><b>Your reason:</b> ${esc(r.reason || '(none given)')}</span></div>`)}
</div></section>` : ''}

<section class="card"><details class="list" id="all"><summary>Every approved fix (${d.approvals.length})</summary><div class="scroll">
<table><thead><tr><th>When</th><th>Item</th><th>Fix</th><th>Suggested by</th><th>Approved by</th></tr></thead><tbody>
${rows(d.approvals, (a) => `<tr><td class="when">${when(a.at)}</td><td class="ref">${esc(a.exception)}${a.covers.length ? `<span class="sub">also fixes ${esc(a.covers.join(', '))}</span>` : ''}</td><td>${esc(CATEGORIES[a.category]?.label ?? a.category)}<span class="sub">${esc(a.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.account} ${fmt(l.debit || l.credit)}`).join(', '))}</span></td><td>${esc(a.by)}</td><td>${esc(a.reviewer)}</td></tr>`) || '<tr><td colspan="5">Nothing approved yet.</td></tr>'}
</tbody></table></div></details></section>
</main>
<script>addEventListener('beforeprint', () => { document.getElementById('all').open = true; });</script>
</body></html>`;
}
