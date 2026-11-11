// closebook's HTML, built as strings by pure functions: no DOM, so the tests can check that
// nothing a person or PayPal typed (a memo, an item name, a buyer note) is ever rendered as HTML.
// Every value from the books, PayPal or the AI goes through esc().

export const fmt = (c) => {
  if (c == null) return '';
  const a = Math.abs(c), s = `${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
  return c < 0 ? `-$${s}` : `$${s}`;
};
export const words = (code) => String(code ?? '').toLowerCase().replace(/_/g, ' ');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Plain words for what PayPal reports. A shop owner sees "Refund", not T1107.
export const KIND_LABEL = { payment: 'Sale', refund: 'Refund', hold: 'Money held by PayPal', reversal: 'Chargeback', payout: 'Payment you sent', transfer: 'Transfer to your bank', fee: 'PayPal fee', fx: 'Currency exchange', correction: 'PayPal correction', other: 'Other PayPal activity' };
export const kindLabel = (t) => KIND_LABEL[t.kind] ?? 'PayPal activity';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (period) => { const [y, m] = String(period ?? '').split('-').map(Number); return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${y}` : String(period ?? ''); };
export const day = (iso) => { const [y, m, d] = String(iso ?? '').slice(0, 10).split('-').map(Number); return MONTHS[m - 1] ? `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}` : ''; };
// What PayPal says about a buyer's dispute, in words.
const DISPUTE = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'buyer says the item never arrived', MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'buyer says the item was not as described', UNAUTHORISED: 'buyer says they did not make this payment',
  CREDIT_NOT_PROCESSED: 'buyer says a refund was not given', DUPLICATE_TRANSACTION: 'buyer says they were charged twice', INCORRECT_AMOUNT: 'buyer says the amount was wrong', PAYMENT_BY_OTHER_MEANS: 'buyer says they paid another way',
  OPEN: 'still open', WAITING_FOR_BUYER_RESPONSE: 'waiting for the buyer', WAITING_FOR_SELLER_RESPONSE: 'waiting for you', UNDER_REVIEW: 'PayPal is reviewing it', RESOLVED: 'closed', OTHER: 'other',
  INQUIRY: 'at the inquiry stage', CHARGEBACK: 'taken up by the card issuer', PRE_ARBITRATION: 'in pre-arbitration', ARBITRATION: 'in arbitration',
  RESOLVED_BUYER_FAVOUR: 'the buyer won', RESOLVED_SELLER_FAVOUR: 'you won', RESOLVED_WITH_PAYOUT: 'settled with a payout', CANCELED_BY_BUYER: 'the buyer withdrew it', ACCEPTED: 'accepted', DENIED: 'denied',
};
export const disputeText = (d) => ['Buyer dispute', d.reason, d.status, d.stage, d.outcome].filter(Boolean).map((x, i) => (i ? DISPUTE[x] ?? words(x) : x)).join(' · ');

// What each double-check means, for a person.
export const CHECK_LABEL = { open: 'Still open', category: 'Type of fix', cites: 'Items included', account: 'Accounts', line: 'Lines', lines: 'Lines', balanced: 'Debits and credits', closes_gap: 'Fixes the difference', category_fits: 'Matches what PayPal did', currency: 'Currency' };

export const badge = (cls, text, title = '') => `<span class="badge ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
export const statusChip = (e) => {
  if (e.status === 'approved') return badge('good', 'Approved');
  if (e.status === 'covered') return badge('good', 'Done', 'Fixed together with another item');
  if (e.pending) return badge('info pulse', 'AI…');
  if (!e.fix) return badge('plain', 'To review');
  return e.check.ok ? badge('ready', 'Ready') : badge('bad', 'Needs a fix');
};
export const byBadge = (e) => (!e.fix ? '' : (e.fix.by === 'claude' ? badge('claude', 'AI') : badge('rule', 'Auto', 'A standard fix closebook writes itself')) + (e.fix.recorded ? ' ' + badge('info', 'Saved', 'A saved AI suggestion: the AI is not available right now') : '') + (e.fix.original ? ' ' + badge('warn', 'Changed by you') : ''));

export function itemsLabel(state, e) {
  const byP = new Map(state.paypal.map((t) => [t.id, t]));
  const byL = new Map(state.ledger.map((l) => [l.id, l]));
  return [...e.paypal.map((id) => { const t = byP.get(id); return `PayPal ${kindLabel(t).toLowerCase()}${t.subject ? `: ${t.subject}` : ''}`; }), ...e.ledger.map((id) => `Books: ${byL.get(id).memo || '(no memo)'}`)].join(' · ');
}

export const entryText = (lines) => lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.account} ${fmt(l.debit || l.credit)}`).join(', ');

export const CHECKS = ['The item is still open', 'The type of fix is one closebook knows', 'It includes this item, and only items still open', 'Every account is in your chart of accounts', 'Each line is a debit or a credit, in whole cents', 'Debits equal credits', 'It changes PayPal in your books by exactly the difference', 'The type of fix matches what PayPal says happened', 'No foreign-currency money without its exchange'];

// The detail panel: an empty-state note, or one exception's voucher.
export function voucherHtml(state, e, tab = 'exceptions') {
  if (!e || tab !== 'exceptions') {
    return tab === 'exceptions'
      ? `<div class="v-empty"><span class="v-label">Fix</span><h3>Pick an item to review</h3><p>Each row is something PayPal and your books disagree on. Pick one to see:</p><ul><li>what PayPal did, and what your books say</li><li>the fix suggested for it, and why</li><li>the nine double-checks every fix must pass before you can approve it</li></ul></div>`
      : `<div class="v-empty"><span class="v-label">${esc({ matched: 'Matched', paypal: 'PayPal activity', books: 'Your books', journal: 'Journal entries' }[tab])}</span><h3>${esc({ matched: 'Already in agreement', paypal: 'What PayPal did', books: 'What your books say', journal: 'Approved fixes' }[tab])}</h3><p>${esc({ matched: 'Each line in your books here was matched to one PayPal payment, by its invoice or ID, or by an amount and date only one payment fits.', paypal: 'Every payment, refund, fee, hold and transfer in PayPal this month: the amount, PayPal\'s fee and what you received.', books: 'Your PayPal account in the books, as you uploaded it: money in is positive, money out is negative.', journal: 'Every fix you approved, as journal entries: one row per debit or credit. The totals row shows debits equal credits.' }[tab])}</p><p>The totals row at the bottom follows your filters.</p>${tab === 'journal' ? `<p><a class="btn btn-ink" href="/api/memo.html" target="_blank" rel="noopener">Open the month-end summary</a></p><p>One printable page for you or your accountant: the month before and after, PayPal's balance, every approved fix by type, who suggested and approved what, and anything flagged.</p>` : ''}</div>`;
  }
  const byP = new Map(state.paypal.map((t) => [t.id, t]));
  const byL = new Map(state.ledger.map((l) => [l.id, l]));
  const doc = (kind, id) => {
    if (kind === 'p') { const t = byP.get(id); return `<div class="doc"><span class="src">PayPal</span><span class="what">${esc(kindLabel(t))}${t.subject ? ` · ${esc(t.subject)}` : ''}</span><span class="amt ${t.net < 0 ? 'neg' : ''}">${fmt(t.net)}</span><span class="sub">${esc(day(t.date))}${t.fee ? ` · ${fmt(t.gross)} less a PayPal fee of ${fmt(-t.fee)}` : ''}${t.payer ? ` · ${esc(t.payer)}` : ''} · PayPal ID ${esc(id)}</span>${(state.disputes?.[t.ref] ?? state.disputes?.[t.id] ?? []).map((d) => `<span class="dispute">${esc(disputeText(d))}</span>`).join('')}</div>`; }
    const l = byL.get(id); return `<div class="doc"><span class="src">Books</span><span class="what">${esc(l.memo || '(no memo)')}</span><span class="amt ${l.amount < 0 ? 'neg' : ''}">${fmt(l.amount)}</span><span class="sub">${esc(day(l.date))} · line ${esc(id)}${l.ref ? ` · ref ${esc(l.ref)}` : ''}</span></div>`;
  };
  const found = e.source === 'fee' ? 'PayPal fee missing from your books' : e.source === 'paypal' ? 'In PayPal, not in your books' : 'In your books, not in PayPal';
  let html = `<div class="v-head"><span class="v-label">Fix</span><span class="v-id">${esc(e.id)}</span></div>`;
  html += `<h3 class="v-title">${esc(e.fix ? state.config.categories[e.fix.category] ?? e.fix.category : found)}</h3>`;
  html += `<div class="v-meta">${statusChip(e)}${byBadge(e)}<span>difference <span class="v-gap ${e.gap < 0 ? 'neg' : ''}">${fmt(e.gap)}</span></span></div>`;
  html += `<div class="v-sec"><span class="v-label">What we found</span>${e.paypal.map((id) => doc('p', id)).join('')}${e.ledger.map((id) => doc('l', id)).join('')}</div>`;
  // Text from PayPal or the books that addresses the AI: shown, quoted, never acted on.
  if (e.flags?.length) html += `<div class="v-sec">${e.flags.map((f) => `<div class="flag-box"><b>This text tries to give the AI instructions</b><span>${esc(f.field)}: <q>${esc(f.text)}</q></span><span class="flag-why">closebook treats it as information only, and the amounts are still double-checked. Make sure the type of fix and the accounts look right to you.</span></div>`).join('')}</div>`;
  if (e.hints?.length) html += `<div class="v-sec">${e.hints.map((h) => `<div class="hint-box"><b>${h.kind === 'transposition' ? 'Possible typo' : 'Worth a look'}</b><span>${esc(h.detail)}</span></div>`).join('')}</div>`;
  if (e.fix) {
    const f = e.fix;
    if (e.status === 'open') {
      // Open: the entry is an editable grid. The checks below re-run on every change.
      const cats = Object.entries(state.config.categories).map(([k, v]) => `<option value="${esc(k)}"${k === f.category ? ' selected' : ''}>${esc(v)}</option>`).join('');
      html += `<div class="v-sec"><span class="v-label">Journal entry · click an account or amount to change it</span><label class="cat">Type of fix<select id="cat">${cats}</select></label><div id="entryGrid" class="entry-grid"></div><div class="entry-tools"><button class="btn btn-quiet" id="addLine">+ Line</button><button class="btn btn-quiet" id="dropLine">Remove selected line</button>${f.original ? `<button class="btn btn-quiet" id="revert">Undo my changes</button>` : ''}</div><div class="memo">Memo: ${esc(f.memo)}</div>${f.original ? `<div class="edited-note">You changed this. ${f.by === 'claude' ? 'The AI suggested' : 'It was'}: ${esc(entryText(f.original.lines))}${f.original.category !== f.category ? ` (${esc(state.config.categories[f.original.category] ?? f.original.category)})` : ''}</div>` : ''}</div>`;
    } else {
      const lines = [...f.lines.filter((l) => l.debit), ...f.lines.filter((l) => !l.debit)];
      const dr = f.lines.reduce((a, l) => a + (l.debit || 0), 0), cr = f.lines.reduce((a, l) => a + (l.credit || 0), 0);
      html += `<div class="v-sec"><span class="v-label">Journal entry${f.original ? ' · changed by you' : ''}</span><table class="entry"><thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>${lines.map((l) => `<tr class="${l.debit ? 'dr' : 'cr'}"><td><span class="acct">${esc(l.account)}</span>${esc(state.chart[l.account] ?? 'not in chart')}</td><td class="n">${l.debit ? fmt(l.debit) : ''}</td><td class="n">${l.credit ? fmt(l.credit) : ''}</td></tr>`).join('')}</tbody><tfoot><tr><td>Total</td><td class="n"><span>${fmt(dr)}</span></td><td class="n"><span>${fmt(cr)}</span></td></tr></tfoot></table><div class="memo">Memo: ${esc(f.memo)}</div></div>`;
    }
    if (f.recorded) html += `<div class="v-sec"><div class="recorded-box"><b>Saved AI suggestion</b><span>The AI isn't available right now${f.recorded.why ? ` (${esc(f.recorded.why)})` : ''}, so this is the suggestion it made for this exact item on ${esc(day(f.recorded.at))}. The double-checks below ran again just now.</span></div></div>`;
    if (f.explanation) html += `<div class="v-sec"><span class="v-label">${f.by === 'claude' ? 'Why the AI suggests this' : 'Why'}</span><div class="note ${f.by === 'claude' ? '' : 'rule'}">${esc(f.explanation)}</div></div>`;
    const extra = [...f.cites.paypal.filter((id) => !e.paypal.includes(id)).map((id) => doc('p', id)), ...f.cites.ledger.filter((id) => !e.ledger.includes(id)).map((id) => doc('l', id))];
    if (extra.length) html += `<div class="v-sec"><span class="v-label">Also fixes</span>${extra.join('')}</div>`;
    html += `<div class="v-sec"><span class="v-label">Double-checks · ${e.check.ok ? 'all nine passed' : `${e.check.failures.length} not passed yet`}</span><ul class="checks">`;
    html += e.check.ok ? CHECKS.map((t) => `<li><span class="tk">✓</span><span>${t}</span></li>`).join('')
      : e.check.failures.map((x) => `<li class="fail"><span class="tk x">✗</span><span><span class="rule-name">${esc(CHECK_LABEL[x.rule] ?? x.rule)}</span>${esc(x.detail)}</span></li>`).join('');
    html += '</ul>';
    // An entry that cites items another approval already settled: the reviewer can drop them.
    if (e.status === 'open' && !e.check.ok && e.check.failures.some((x) => x.rule === 'cites' && /already been fixed/.test(x.detail))) html += `<div class="decide"><button class="btn" id="citeOpen">Remove the items already fixed</button><span class="meta-note">Another fix you approved already took care of some of these items. Removing them is a change you make; the double-checks run again.</span></div>`;
    if (e.firstFailures) html += `<div class="first">The AI's first try didn't pass (${e.firstFailures.map((x) => esc(CHECK_LABEL[x.rule] ?? x.rule)).join(', ')}), so it corrected it.</div>`;
    html += '</div>';
    if (e.status === 'open') {
      html += `<div class="decide"><div class="row"><button class="btn btn-ink" id="approve" ${e.check.ok ? '' : 'disabled'}>Approve fix</button><button class="btn btn-red" id="reject">Reject</button></div><textarea id="reason" rows="2" placeholder="Why are you rejecting it? The AI reads this next time."></textarea></div>`;
    } else if (e.status === 'approved') {
      html += `<div class="approved-stamp"><span class="stamp">Approved</span><span class="when">by ${esc(e.approvedBy === 'reviewer' || !e.approvedBy ? 'you' : e.approvedBy)} · ${esc(day(e.approvedAt))}</span></div>`;
    }
  } else if (e.status === 'covered') {
    html += `<div class="approved-stamp"><span class="stamp">Done</span><span class="when">fixed together with another item (${esc(e.coveredBy)})</span></div>`;
  } else if (e.status === 'open') {
    html += `<div class="decide"><div class="row"><button class="btn btn-ink" id="proposeOne">${e.source === 'fee' ? 'Suggest the fee fix' : 'Ask the AI for a fix'}</button></div></div>`;
  }
  if (e.rejected?.length) html += `<div class="v-sec rejected"><span class="v-label">You rejected before</span>${e.rejected.map((r) => `<div>"${esc(r.fix.memo)}"${r.reason ? `: ${esc(r.reason)}` : ''}</div>`).join('')}</div>`;
  return html;
}

// The Items cell of the exceptions grid: a hint badge, then the items as text.
export function itemsCellHtml(e, label) {
  return `${e.flags?.length ? badge('bad', 'Flag', `Untrusted text addressed to the AI: ${e.flags.map((f) => f.text).join(' / ')}`) + ' ' : ''}${e.hints?.length ? badge('warn', 'Hint', e.hints.map((h) => h.detail).join('; ')) + ' ' : ''}${esc(label)}`;
}

// How the difference goes to zero: the starting difference, one step per category of approved
// entries (how much they moved the difference), and where it stands now. Built from the close the
// server sent; every number is the server's.
export function waterfallSteps(state) {
  const s = state.summary;
  const start = s.difference + s.adjustments; // before any approved entry
  const byCat = new Map();
  for (const e of state.exceptions) {
    if (e.status !== 'approved') continue;
    const moved = e.fix.lines.reduce((a, l) => a + (l.account === '1010' ? (l.debit || 0) - (l.credit || 0) : 0), 0);
    const c = byCat.get(e.fix.category) ?? { category: e.fix.category, label: state.config?.categories?.[e.fix.category] ?? e.fix.category, entries: 0, moved: 0 };
    c.entries++; c.moved += moved; byCat.set(e.fix.category, c);
  }
  let at = start;
  const steps = [...byCat.values()].sort((a, b) => Math.abs(b.moved) - Math.abs(a.moved)).map((c) => { const from = at; at -= c.moved; return { ...c, from, to: at }; });
  return { start, steps, end: s.difference };
}

// Plain SVG, no library: bars from zero for the start and the end, floating bars for each step.
// A table with the same numbers is there for screen readers.
export function waterfallHtml(state) {
  const { start, steps, end } = waterfallSteps(state);
  const bars = [{ kind: 'total', label: 'At the start', from: 0, to: start }, ...steps.map((s) => ({ kind: 'step', label: s.label, from: s.from, to: s.to, entries: s.entries })), { kind: end === 0 ? 'zero' : 'total', label: end === 0 ? 'Difference now' : 'Left to fix', from: 0, to: end }];
  const vals = bars.flatMap((b) => [b.from, b.to]);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
  const W = 760, H = 150, top = 18, bottom = 40, bw = Math.min(W / bars.length, 120);
  const y = (v) => top + ((hi - v) / span) * (H - top - bottom);
  const short = (t) => (t.length > 15 ? `${t.slice(0, 14)}…` : t);
  const rects = bars.map((b, i) => {
    const x = i * bw + bw * 0.14, w = bw * 0.72, y1 = y(Math.max(b.from, b.to)), y2 = y(Math.min(b.from, b.to));
    const h = Math.max(1.5, y2 - y1);
    const cls = b.kind === 'step' ? 'wf-step' : b.kind === 'zero' ? 'wf-zero' : 'wf-total';
    const amount = b.kind === 'step' ? b.to - b.from : b.to;
    return `<g class="${cls}"><title>${esc(b.label)}: ${esc(fmt(amount))}${b.entries ? ` (${b.entries} fix${b.entries === 1 ? '' : 'es'})` : ''}</title><rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"></rect>`
      + `<text class="wf-amt" x="${(x + w / 2).toFixed(1)}" y="${(y1 - 4).toFixed(1)}">${esc(b.kind === 'step' && amount > 0 ? `+${fmt(amount)}` : fmt(amount))}</text>`
      + `<text class="wf-label" x="${(x + w / 2).toFixed(1)}" y="${H - bottom + 14}">${esc(short(b.label))}</text></g>`
      + (i < bars.length - 1 ? `<line class="wf-link" x1="${(x + w).toFixed(1)}" x2="${((i + 1) * bw + bw * 0.14).toFixed(1)}" y1="${y(b.to).toFixed(1)}" y2="${y(b.to).toFixed(1)}"></line>` : '');
  }).join('');
  const table = `<table class="sr-only"><caption>How the difference moves to zero</caption><thead><tr><th>Step</th><th>Fixes</th><th>Change</th><th>Difference after</th></tr></thead><tbody>`
    + `<tr><td>At the start</td><td></td><td></td><td>${esc(fmt(start))}</td></tr>`
    + steps.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.entries}</td><td>${esc(fmt(s.to - s.from))}</td><td>${esc(fmt(s.to))}</td></tr>`).join('')
    + `</tbody></table>`;
  return `<svg class="wf" viewBox="0 0 ${W} ${H}" aria-hidden="true"><line class="wf-zero-line" x1="0" x2="${(bars.length * bw).toFixed(1)}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"></line>${rects}</svg>${table}`;
}
