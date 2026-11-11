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

export const badge = (cls, text, title = '') => `<span class="badge ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
export const statusChip = (e) => {
  if (e.status === 'approved') return badge('good', 'Approved');
  if (e.status === 'covered') return badge('good', 'Settled', `settled by ${e.coveredBy}`);
  if (e.pending) return badge('info pulse', 'AI…');
  if (!e.fix) return badge('plain', 'Exception');
  return e.check.ok ? badge('ready', 'Ready') : badge('bad', 'Fails checks');
};
export const byBadge = (e) => (!e.fix ? '' : (e.fix.by === 'claude' ? badge('claude', 'AI') : badge('rule', 'Rule')) + (e.fix.recorded ? ' ' + badge('info', 'Recorded', 'Recorded Claude proposal (live calls unavailable)') : '') + (e.fix.original ? ' ' + badge('warn', 'Edited') : ''));

export function itemsLabel(state, e) {
  const byP = new Map(state.paypal.map((t) => [t.id, t]));
  const byL = new Map(state.ledger.map((l) => [l.id, l]));
  return [...e.paypal.map((id) => { const t = byP.get(id); return `PayPal ${t.code} ${t.subject ?? ''}`; }), ...e.ledger.map((id) => `Book ${id}: ${byL.get(id).memo}`)].join(' · ');
}

export const entryText = (lines) => lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.account} ${fmt(l.debit || l.credit)}`).join(', ');

export const CHECKS = ['The exception is still open', 'The category is one of the twelve', 'Cites its own items, and only open ones', 'Every account is in the chart', 'Each line is one whole-cent debit or credit', 'Debits equal credits', 'Moves PayPal clearing by exactly the gap', 'Category fits the cited PayPal event codes', 'No foreign-currency item without a conversion'];

// The detail panel: an empty-state note, or one exception's voucher.
export function voucherHtml(state, e, tab = 'exceptions') {
  if (!e || tab !== 'exceptions') {
    return tab === 'exceptions'
      ? `<div class="v-empty"><span class="v-label">Journal voucher</span><h3>Pick an exception</h3><p>Each row is a line where PayPal and the books disagree. Select one to see:</p><ul><li>the PayPal transactions and book lines behind it</li><li>the entry proposed to settle it, and why</li><li>the nine checks it has to pass</li></ul></div>`
      : `<div class="v-empty"><span class="v-label">${esc({ matched: 'Matched lines', paypal: 'PayPal activity', books: 'Books', journal: 'Journal' }[tab])}</span><h3>${esc({ matched: 'Paired by rule', paypal: 'What PayPal did', books: 'What the books say', journal: 'Approved entries' }[tab])}</h3><p>${esc({ matched: 'Each book line here was paired with one PayPal transaction, by reference or by an amount and date only one candidate fits.', paypal: 'Every balance-affecting transaction from Transaction Search, with its event code, gross, fee and net.', books: 'The PayPal clearing account as uploaded: each line is the signed change to account 1010.', journal: 'Every approved entry, one row per debit or credit. The totals row shows debits equal credits.' }[tab])}</p><p>The totals row at the bottom follows your filters.</p>${tab === 'journal' ? `<p><a class="btn btn-ink" href="/api/memo.html" target="_blank" rel="noopener">Open the close memo</a></p><p>One printable page for the controller: the tie-out before and after, PayPal's balances, every approved entry by category, who proposed and approved what, rejections and flags.</p>` : ''}</div>`;
  }
  const byP = new Map(state.paypal.map((t) => [t.id, t]));
  const byL = new Map(state.ledger.map((l) => [l.id, l]));
  const doc = (kind, id) => {
    if (kind === 'p') { const t = byP.get(id); return `<div class="doc"><span class="src">PayPal</span><span class="what">${esc(t.code)} · ${esc(t.subject ?? t.kind)}</span><span class="amt ${t.net < 0 ? 'neg' : ''}">${fmt(t.net)}</span><span class="sub">${esc(t.date)} · ${esc(id)} · gross ${fmt(t.gross)}, fee ${fmt(t.fee)}${t.ref ? ` · refers to ${esc(t.ref)}` : ''}</span>${(state.disputes?.[t.ref] ?? state.disputes?.[t.id] ?? []).map((d) => `<span class="dispute">PayPal dispute ${esc(d.id)} · ${esc(words(d.reason))} · ${esc(words(d.status))}${d.stage ? ` · ${esc(words(d.stage))}` : ''}${d.outcome ? ` · ${esc(words(d.outcome))}` : ''}</span>`).join('')}</div>`; }
    const l = byL.get(id); return `<div class="doc"><span class="src">Books</span><span class="what">${esc(l.memo || '(no memo)')}</span><span class="amt ${l.amount < 0 ? 'neg' : ''}">${fmt(l.amount)}</span><span class="sub">${esc(l.date)} · line ${esc(id)}${l.ref ? ` · ref ${esc(l.ref)}` : ''}</span></div>`;
  };
  const found = e.source === 'fee' ? 'Fee not booked' : e.source === 'paypal' ? 'Only in PayPal' : 'Only in the books';
  let html = `<div class="v-head"><span class="v-label">Journal voucher</span><span class="v-id">${esc(e.id)}</span></div>`;
  html += `<h3 class="v-title">${esc(e.fix ? state.config.categories[e.fix.category] ?? e.fix.category : found)}</h3>`;
  html += `<div class="v-meta">${statusChip(e)}${byBadge(e)}<span>gap <span class="v-gap ${e.gap < 0 ? 'neg' : ''}">${fmt(e.gap)}</span></span></div>`;
  html += `<div class="v-sec"><span class="v-label">Supporting items</span>${e.paypal.map((id) => doc('p', id)).join('')}${e.ledger.map((id) => doc('l', id)).join('')}</div>`;
  // Text from PayPal or the books that addresses the AI: shown, quoted, never acted on.
  if (e.flags?.length) html += `<div class="v-sec">${e.flags.map((f) => `<div class="flag-box"><b>Untrusted text addressed to the AI</b><span>${esc(f.field)}: <q>${esc(f.text)}</q></span><span class="flag-why">Treated as data. The checks still hold; judge the category and accounts yourself.</span></div>`).join('')}</div>`;
  if (e.hints?.length) html += `<div class="v-sec">${e.hints.map((h) => `<div class="hint-box"><b>Found by code${h.kind === 'transposition' ? ' · possible transposition' : ''}</b><span>${esc(h.detail)} (see <code>${esc(h.with)}</code>)</span></div>`).join('')}</div>`;
  if (e.fix) {
    const f = e.fix;
    if (e.status === 'open') {
      // Open: the entry is an editable grid. The checks below re-run on every change.
      const cats = Object.entries(state.config.categories).map(([k, v]) => `<option value="${esc(k)}"${k === f.category ? ' selected' : ''}>${esc(v)}</option>`).join('');
      html += `<div class="v-sec"><span class="v-label">Entry · edit any cell, the checks re-run</span><label class="cat">Category<select id="cat">${cats}</select></label><div id="entryGrid" class="entry-grid"></div><div class="entry-tools"><button class="btn btn-quiet" id="addLine">+ Line</button><button class="btn btn-quiet" id="dropLine">Remove selected line</button>${f.original ? `<button class="btn btn-quiet" id="revert">Revert to the ${f.by === 'claude' ? 'AI' : 'rule'}'s entry</button>` : ''}</div><div class="memo">Memo: ${esc(f.memo)}</div>${f.original ? `<div class="edited-note">Edited by the reviewer. Was: ${esc(entryText(f.original.lines))}${f.original.category !== f.category ? ` (${esc(state.config.categories[f.original.category] ?? f.original.category)})` : ''}</div>` : ''}</div>`;
    } else {
      const lines = [...f.lines.filter((l) => l.debit), ...f.lines.filter((l) => !l.debit)];
      const dr = f.lines.reduce((a, l) => a + (l.debit || 0), 0), cr = f.lines.reduce((a, l) => a + (l.credit || 0), 0);
      html += `<div class="v-sec"><span class="v-label">Entry${f.original ? ' · edited by the reviewer' : ''}</span><table class="entry"><thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>${lines.map((l) => `<tr class="${l.debit ? 'dr' : 'cr'}"><td><span class="acct">${esc(l.account)}</span>${esc(state.chart[l.account] ?? 'not in chart')}</td><td class="n">${l.debit ? fmt(l.debit) : ''}</td><td class="n">${l.credit ? fmt(l.credit) : ''}</td></tr>`).join('')}</tbody><tfoot><tr><td>Total</td><td class="n"><span>${fmt(dr)}</span></td><td class="n"><span>${fmt(cr)}</span></td></tr></tfoot></table><div class="memo">Memo: ${esc(f.memo)}</div></div>`;
    }
    if (f.recorded) html += `<div class="v-sec"><div class="recorded-box"><b>Recorded Claude proposal (live calls unavailable)</b><span>${esc(f.recorded.why ? `Live calls are unavailable here: ${f.recorded.why}.` : 'Live calls are unavailable here.')} This is what ${esc(f.recorded.model ?? 'Claude')} proposed for this exact exception in a recorded run on ${esc(String(f.recorded.at ?? '').slice(0, 10))}. The checks below ran now, on this close.</span></div></div>`;
    if (f.explanation) html += `<div class="v-sec"><span class="v-label">${f.by === 'claude' ? `Why · AI (${esc(f.model ?? '')})` : 'Why · rule'}</span><div class="note ${f.by === 'claude' ? '' : 'rule'}">${esc(f.explanation)}</div></div>`;
    const extra = [...f.cites.paypal.filter((id) => !e.paypal.includes(id)).map((id) => doc('p', id)), ...f.cites.ledger.filter((id) => !e.ledger.includes(id)).map((id) => doc('l', id))];
    if (extra.length) html += `<div class="v-sec"><span class="v-label">Also settles</span>${extra.join('')}</div>`;
    html += `<div class="v-sec"><span class="v-label">Checks · ${e.check.ok ? 'all nine pass' : `${e.check.failures.length} failing`}</span><ul class="checks">`;
    html += e.check.ok ? CHECKS.map((t) => `<li><span class="tk">✓</span><span>${t}</span></li>`).join('')
      : e.check.failures.map((x) => `<li class="fail"><span class="tk x">✗</span><span><span class="rule-name">${esc(x.rule)}</span>${esc(x.detail)}</span></li>`).join('');
    html += '</ul>';
    // An entry that cites items another approval already settled: the reviewer can drop them.
    if (e.status === 'open' && !e.check.ok && e.check.failures.some((x) => x.rule === 'cites' && /is not part of an open exception/.test(x.detail))) html += `<div class="decide"><button class="btn" id="citeOpen">Drop the items already settled</button><span class="meta-note">Another approved entry settled some of the items this one cites. Dropping them is a correction: the checks run again.</span></div>`;
    if (e.firstFailures) html += `<div class="first">The AI's first attempt failed (${e.firstFailures.map((x) => esc(x.rule)).join(', ')}) and was corrected.</div>`;
    html += '</div>';
    if (e.status === 'open') {
      html += `<div class="decide"><div class="row"><button class="btn btn-ink" id="approve" ${e.check.ok ? '' : 'disabled'}>Approve entry</button><button class="btn btn-red" id="reject">Reject</button></div><textarea id="reason" rows="2" placeholder="Reason for rejecting. The AI reads it next time it proposes."></textarea></div>`;
    } else if (e.status === 'approved') {
      html += `<div class="approved-stamp"><span class="stamp">Approved</span><span class="when">${esc(e.approvedBy ?? 'reviewer')} · ${esc((e.approvedAt ?? '').replace('T', ' ').slice(0, 16))} UTC</span></div>`;
    }
  } else if (e.status === 'covered') {
    html += `<div class="approved-stamp"><span class="stamp">Settled</span><span class="when">by the entry on ${esc(e.coveredBy)}</span></div>`;
  } else if (e.status === 'open') {
    html += `<div class="decide"><div class="row"><button class="btn btn-ink" id="proposeOne">${e.source === 'fee' ? 'Propose the fee entry' : 'Ask AI for an entry'}</button></div></div>`;
  }
  if (e.rejected?.length) html += `<div class="v-sec rejected"><span class="v-label">Rejected before</span>${e.rejected.map((r) => `<div>"${esc(r.fix.memo)}"${r.reason ? `: ${esc(r.reason)}` : ''}</div>`).join('')}</div>`;
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
  const bars = [{ kind: 'total', label: 'Starting difference', from: 0, to: start }, ...steps.map((s) => ({ kind: 'step', label: s.label, from: s.from, to: s.to, entries: s.entries })), { kind: end === 0 ? 'zero' : 'total', label: end === 0 ? 'Difference now' : 'Still to settle', from: 0, to: end }];
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
    return `<g class="${cls}"><title>${esc(b.label)}: ${esc(fmt(amount))}${b.entries ? ` (${b.entries} entr${b.entries === 1 ? 'y' : 'ies'})` : ''}</title><rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"></rect>`
      + `<text class="wf-amt" x="${(x + w / 2).toFixed(1)}" y="${(y1 - 4).toFixed(1)}">${esc(b.kind === 'step' && amount > 0 ? `+${fmt(amount)}` : fmt(amount))}</text>`
      + `<text class="wf-label" x="${(x + w / 2).toFixed(1)}" y="${H - bottom + 14}">${esc(short(b.label))}</text></g>`
      + (i < bars.length - 1 ? `<line class="wf-link" x1="${(x + w).toFixed(1)}" x2="${((i + 1) * bw + bw * 0.14).toFixed(1)}" y1="${y(b.to).toFixed(1)}" y2="${y(b.to).toFixed(1)}"></line>` : '');
  }).join('');
  const table = `<table class="sr-only"><caption>How the difference moves to zero</caption><thead><tr><th>Step</th><th>Entries</th><th>Change</th><th>Difference after</th></tr></thead><tbody>`
    + `<tr><td>Starting difference</td><td></td><td></td><td>${esc(fmt(start))}</td></tr>`
    + steps.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.entries}</td><td>${esc(fmt(s.to - s.from))}</td><td>${esc(fmt(s.to))}</td></tr>`).join('')
    + `</tbody></table>`;
  return `<svg class="wf" viewBox="0 0 ${W} ${H}" aria-hidden="true"><line class="wf-zero-line" x1="0" x2="${(bars.length * bw).toFixed(1)}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"></line>${rects}</svg>${table}`;
}
