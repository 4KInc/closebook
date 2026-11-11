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

export function memoHtml(d, { narrative = null, note = null } = {}) {
  const b = d.balance, t = d.tieout, c = d.counts;
  const rows = (xs, f) => xs.map(f).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Month-end summary · ${esc(monthName(d.period))}</title>
<style>
:root { --ink: #16241d; --ink-2: #55675d; --rule: #cfdccb; --bar: #e9f2e6; --red: #b42318; --green: #0f5a3c; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: var(--ink); font: 13px/1.5 "Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 32px 24px 48px; }
h1 { font: 400 30px/1.1 Georgia, serif; margin: 4px 0 2px; }
h2 { font: 600 11px ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-2); margin: 22px 0 6px; border-bottom: 1px solid var(--ink-2); padding-bottom: 3px; }
.eyebrow, .meta { font: 11px ui-monospace, Menlo, monospace; color: var(--ink-2); }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th { text-align: left; font: 600 10.5px ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); padding: 4px 6px; border-bottom: 1px solid var(--rule); }
td { padding: 4px 6px; border-bottom: 1px solid var(--rule); vertical-align: top; }
tr:nth-child(even) td { background: var(--bar); }
.n { text-align: right; font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
.ref { font: 11.5px ui-monospace, Menlo, monospace; color: var(--ink-2); overflow-wrap: anywhere; }
.when { white-space: nowrap; }
.total td { font-weight: 700; border-top: 1px solid var(--ink); background: none; }
.neg { color: var(--red); } .zero { color: var(--green); font-weight: 700; }
.narrative { background: var(--bar); border-left: 3px solid var(--green); padding: 8px 12px; margin: 14px 0 0; }
.note { color: var(--ink-2); font-size: 12px; margin-top: 6px; }
.flag { color: var(--red); }
.tools { margin-top: 18px; } .tools button { font: 600 13px system-ui; padding: 6px 12px; border: 1px solid var(--ink); background: #fff; border-radius: 4px; cursor: pointer; }
@media print { main { padding: 0; max-width: none; } .tools { display: none; } h2 { break-after: avoid; } tr { break-inside: avoid; } @page { margin: 14mm 12mm; } body { font-size: 11px; } }
</style></head><body><main>
<div class="eyebrow">closebook · month-end summary · your PayPal account</div>
<h1>${esc(monthName(d.period))}: ${t.after === 0 ? 'your books match PayPal' : `${money(t.after)} still to fix`}</h1>
<div class="meta">${esc(d.source)} · ${esc(d.currency)} · prepared ${when(new Date().toISOString())}</div>
${narrative ? `<p class="narrative">${esc(narrative)}</p><div class="note">Written by the AI from the figures below. closebook checked that every number in it is one of them.</div>` : note ? `<div class="note">${esc(note)}</div>` : ''}

<h2>The month</h2>
<table><tbody>
<tr><td>Money in and out of PayPal this month</td><td class="n">${money(t.paypalNet)}</td></tr>
<tr><td>What your books said, as uploaded</td><td class="n">${money(t.booksBefore)}</td></tr>
<tr><td>Difference before any fixes</td><td class="n ${t.before ? 'neg' : 'zero'}">${money(t.before)}</td></tr>
<tr><td>Approved fixes, total change to PayPal in your books</td><td class="n">${money(t.adjustments)}</td></tr>
<tr class="total"><td>Difference now</td><td class="n ${t.after ? 'neg' : 'zero'}">${money(t.after)}</td></tr>
</tbody></table>
${b ? `<h2>Your PayPal balance</h2><table><tbody>
<tr><td>On ${when(b.openingAt)}</td><td class="n">${money(b.opening)}</td></tr>
<tr><td>On ${when(b.closingAt)}</td><td class="n">${money(b.closing)}</td></tr>
<tr><td>Change</td><td class="n">${money(b.moved)}</td></tr>
<tr><td>Total of the PayPal payments we read</td><td class="n">${money(b.activity)}</td></tr>
<tr class="total"><td>${b.gap === 0 ? 'Every PayPal payment is accounted for' : 'Not in the payments we read'}</td><td class="n ${b.gap ? 'neg' : 'zero'}">${money(b.gap)}</td></tr>
</tbody></table>` : ''}

<h2>Approved fixes by type</h2>
<table><thead><tr><th>Type of fix</th><th class="n">Fixes</th><th class="n">Debits</th><th class="n">Change to PayPal in your books</th></tr></thead><tbody>
${rows(d.categories, (x) => `<tr><td>${esc(x.label)}</td><td class="n">${x.entries}</td><td class="n">${money(x.debits)}</td><td class="n">${money(x.moved)}</td></tr>`) || '<tr><td colspan="4">No fixes approved yet.</td></tr>'}
<tr class="total"><td>Total</td><td class="n">${d.categories.reduce((a, x) => a + x.entries, 0)}</td><td class="n">${money(d.categories.reduce((a, x) => a + x.debits, 0))}</td><td class="n">${money(t.adjustments)}</td></tr>
</tbody></table>

<h2>Who suggested what</h2>
<table><tbody>
<tr><td>Items to review (after ${c.matched} lines matched automatically)</td><td class="n">${c.exceptions}</td></tr>
<tr><td>Approved standard fixes (PayPal fees)</td><td class="n">${c.byRule}</td></tr>
<tr><td>Approved AI suggestions</td><td class="n">${c.byClaude}</td></tr>
<tr><td>Approved saved AI suggestions</td><td class="n">${c.recorded}</td></tr>
<tr><td>Approved fixes you changed first</td><td class="n">${c.corrected}</td></tr>
<tr><td>Items fixed together with another</td><td class="n">${c.settledWithAnother}</td></tr>
<tr><td>Suggestions you rejected</td><td class="n">${c.rejected}</td></tr>
<tr class="total"><td>Items still to review</td><td class="n ${c.open ? 'neg' : 'zero'}">${c.open}</td></tr>
</tbody></table>

${d.flags.length ? `<h2>Text that tried to give the AI instructions</h2><table><thead><tr><th>Item</th><th>Where</th><th>Text</th><th>Outcome</th></tr></thead><tbody>
${rows(d.flags, (f) => rows(f.flags, (x) => `<tr><td class="ref">${esc(f.exception)}</td><td>${esc(x.field)}</td><td class="flag">“${esc(x.text)}”</td><td>${esc(OUTCOME[f.status] ?? f.status)}${f.category ? `: ${esc(CATEGORIES[f.category]?.label ?? f.category)}` : ''}</td></tr>`))}
</tbody></table>` : ''}

${d.rejected.length ? `<h2>Suggestions you rejected</h2><table><thead><tr><th>When</th><th>Item</th><th>Suggested</th><th>Your reason</th></tr></thead><tbody>
${rows(d.rejected, (r) => `<tr><td class="when">${when(r.at)}</td><td class="ref">${esc(r.exception)}</td><td>${esc(CATEGORIES[r.category]?.label ?? r.category)} by ${esc(r.by === 'claude' ? 'the AI' : 'closebook')}: ${esc(r.memo)}</td><td>${esc(r.reason || '(none given)')}</td></tr>`)}
</tbody></table>` : ''}

<h2>Approved fixes</h2>
<table><thead><tr><th>When</th><th>Item</th><th>Fix</th><th>Suggested by</th><th>Approved by</th></tr></thead><tbody>
${rows(d.approvals, (a) => `<tr><td class="when">${when(a.at)}</td><td class="ref">${esc(a.exception)}${a.covers.length ? `<br><span class="meta">also fixes ${esc(a.covers.join(', '))}</span>` : ''}</td><td>${esc(CATEGORIES[a.category]?.label ?? a.category)}<br><span class="meta">${esc(a.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.account} ${fmt(l.debit || l.credit)}`).join(', '))}</span></td><td>${esc(a.by)}</td><td>${esc(a.reviewer)}</td></tr>`) || '<tr><td colspan="5">Nothing approved yet.</td></tr>'}
</tbody></table>
<div class="tools"><button onclick="window.print()">Print</button></div>
</main></body></html>`;
}
