/* closebook front end: one AG Grid per tab, a detail panel, and calls to the server's JSON API. */
const $ = (id) => document.getElementById(id);
let state = null;
let tab = 'exceptions';
let grid = null;
let selected = null;
let busy = false;

const fmt = (c) => {
  if (c == null) return '';
  const a = Math.abs(c), s = `${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
  return c < 0 ? `-$${s}` : `$${s}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts = {}) {
  const init = { method: opts.body !== undefined || opts.post ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined };
  let res;
  // A 404 marked "x-render-routing: no-server" comes from the host's router: the request never
  // reached closebook, so sending it again cannot repeat anything.
  for (let i = 0; ; i++) {
    res = await fetch(path, init);
    if (res.status === 404 && res.headers.get('x-render-routing') === 'no-server' && i < 5) { await new Promise((r) => setTimeout(r, 300)); continue; }
    break;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function setStatus(t) { $('status').textContent = t; }

// The difference counts to its new value in whole cents. Off under reduced motion.
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
function countTo(el, to) {
  const from = Number(el.dataset.cents ?? to);
  el.dataset.cents = to;
  cancelAnimationFrame(el._raf);
  if (from === to || reduced.matches) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), ms = 700;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms), e = 1 - (1 - k) ** 3;
    el.textContent = fmt(Math.round(from + (to - from) * e));
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// Two views: the home page and the open close. The hash keeps them apart, so the browser's Back
// button and the closebook wordmark both lead home without losing the close in progress.
const onClose = () => location.hash === '#close' && Boolean(state?.summary);
window.addEventListener('hashchange', () => render());

function render() {
  $('back').hidden = !onClose();
  if (!onClose()) {
    $('start').hidden = false; $('app').hidden = true; $('source').textContent = '';
    const resume = $('resume');
    resume.hidden = !state?.summary;
    if (state?.summary) $('resumeLabel').textContent = `${state.source.label} · difference ${fmt(state.summary.difference)}`;
    const ps = state?.config?.paypalStatus;
    $('paypalHint').textContent = !state?.config?.paypal ? 'This server has no PayPal credentials configured, so only the demo month is available here.' : ps && !ps.ok && ps.status ? ps.message : '';
    $('openPaypal').disabled = !state?.config?.paypal;
    return;
  }
  $('start').hidden = true; $('app').hidden = false;
  const s = state.summary;
  $('source').innerHTML = [state.source.label, `${state.currency ?? 'USD'} · PayPal clearing 1010`, state.config.claude ? `AI: ${state.config.model}` : 'AI off: rules only'].map((t) => `<span>${esc(t)}</span>`).join('');
  $('tPaypal').textContent = fmt(s.paypalNet);
  $('tBooks').textContent = fmt(s.books);
  countTo($('tDiff'), s.difference);
  $('tDiffTile').className = `fig diff ${s.difference === 0 ? 'good' : 'bad'}`;
  // One tick per exception, in the order a reviewer works through them.
  const kindOf = (e) => (e.status !== 'open' ? 'done' : e.pending ? 'pending' : e.fix ? (e.check.ok ? 'ready' : 'fail') : 'open');
  const order = { done: 0, ready: 1, fail: 2, pending: 3, open: 4 };
  const kinds = state.exceptions.map(kindOf).sort((a, b) => order[a] - order[b]);
  $('ticks').innerHTML = kinds.map((k) => `<span class="tick ${k}"></span>`).join('');
  const n = (k) => kinds.filter((x) => x === k).length;
  $('counts').innerHTML = `<span><b>${s.matched}</b> matched by rule</span><span class="k-done"><i></i><b>${n('done')}</b> settled</span><span class="k-ready"><i></i><b>${n('ready')}</b> ready to approve</span>${n('fail') ? `<span class="k-fail"><i></i><b>${n('fail')}</b> failing checks</span>` : ''}<span><i></i><b>${n('open') + n('pending')}</b> open</span>`;
  $('nEx').textContent = s.open; $('nMatched').textContent = s.matched; $('nPaypal').textContent = state.paypal.length; $('nBooks').textContent = state.ledger.length;
  $('nJournal').textContent = s.approved;
  $('proposeAll').disabled = busy || !state.exceptions.some((e) => e.status === 'open' && !e.fix);
  $('approveRules').disabled = busy || !state.exceptions.some((e) => e.status === 'open' && e.fix?.by === 'rule' && e.check?.ok);
  drawGrid();
  drawDetail();
}

const badge = (cls, text, title = '') => `<span class="badge ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
const statusChip = (e) => {
  if (e.status === 'approved') return badge('good', 'Approved');
  if (e.status === 'covered') return badge('good', 'Settled', `settled by ${e.coveredBy}`);
  if (e.pending) return badge('info pulse', 'AI…');
  if (!e.fix) return badge('plain', 'Exception');
  return e.check.ok ? badge('ready', 'Ready') : badge('bad', 'Fails checks');
};
const byBadge = (e) => (!e.fix ? '' : e.fix.by === 'claude' ? badge('claude', 'AI') : badge('rule', 'Rule'));

function itemsLabel(e) {
  const byP = new Map(state.paypal.map((t) => [t.id, t]));
  const byL = new Map(state.ledger.map((l) => [l.id, l]));
  return [...e.paypal.map((id) => { const t = byP.get(id); return `PayPal ${t.code} ${t.subject ?? ''}`; }), ...e.ledger.map((id) => `Book ${id}: ${byL.get(id).memo}`)].join(' · ');
}

const moneyCol = (field, headerName, width = 124) => ({
  field, headerName, width, type: 'rightAligned', filter: 'agNumberColumnFilter',
  valueFormatter: (p) => fmt(p.value),
  cellClass: (p) => (p.value < 0 ? 'money neg' : 'money'),
});
const textCol = (field, headerName, more = {}) => ({ field, headerName, filter: 'agTextColumnFilter', ...more });

function columnsAndRows() {
  if (tab === 'exceptions') {
    const rows = state.exceptions.map((e) => ({
      ...e,
      what: itemsLabel(e),
      kind: e.source === 'fee' ? 'fee gap' : e.source === 'paypal' ? 'only in PayPal' : 'only in books',
      category: e.fix ? state.config.categories[e.fix.category] ?? e.fix.category : '',
      by: e.fix ? (e.fix.by === 'claude' ? 'AI' : 'rule') : '',
      entry: e.fix ? e.fix.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.account} ${fmt(l.debit || l.credit)}`).join(', ') : '',
      order: e.status === 'open' ? (e.fix ? (e.check.ok ? 1 : 0) : 2) : 3,
      // The cell shows a chip built from several fields; give it a value that changes with them
      // so AG Grid refreshes the cell.
      statusKey: `${e.status}|${e.pending ? 'p' : ''}|${e.fix ? (e.check.ok ? 'ok' : 'fail') : ''}|${e.coveredBy ?? ''}`,
      statusText: e.status === 'approved' ? 'approved' : e.status === 'covered' ? 'settled' : !e.fix ? 'exception' : e.check.ok ? 'ready' : 'fails checks',
    }));
    return {
      rows,
      cols: [
        { field: 'statusKey', headerName: 'Status', width: 130, pinned: 'left', cellRenderer: (p) => (p.node.rowPinned ? '' : statusChip(p.data)), sort: 'asc', comparator: (a, b, na, nb) => (na?.data?.order ?? 9) - (nb?.data?.order ?? 9), filter: 'agTextColumnFilter', filterValueGetter: (p) => p.data.statusText },
        textCol('kind', 'Found', { width: 120 }),
        moneyCol('gap', 'Gap'),
        textCol('what', 'Items', { flex: 2, minWidth: 220, tooltipField: 'what', cellRenderer: (p) => (p.node.rowPinned ? esc(p.value) : `${p.data.hints?.length ? badge('warn', 'Hint', p.data.hints.map((h) => h.detail).join('; ')) + ' ' : ''}${esc(p.value)}`) }),
        textCol('category', 'Proposed fix', { flex: 1, minWidth: 170 }),
        { field: 'by', headerName: 'By', width: 92, cellRenderer: (p) => (p.node.rowPinned ? '' : byBadge(p.data)), filter: 'agTextColumnFilter' },
        textCol('entry', 'Entry', { flex: 1.4, minWidth: 220, tooltipField: 'entry', cellClass: 'mono' }),
      ],
    };
  }
  if (tab === 'matched') {
    const byP = new Map(state.paypal.map((t) => [t.id, t]));
    const byL = new Map(state.ledger.map((l) => [l.id, l]));
    return {
      rows: state.matches.map((m) => { const t = byP.get(m.paypal), l = byL.get(m.ledger); return { date: t.date, paypal: t.id, code: t.code, subject: t.subject, gross: t.gross, net: t.net, line: l.id, memo: l.memo, amount: l.amount, rule: m.rule === 'reference' ? 'reference' : 'amount + date', basis: m.basis }; }),
      cols: [{ field: 'status', headerName: 'Status', width: 110, cellRenderer: (p) => (p.node.rowPinned ? '' : badge('good', 'Matched')) }, textCol('date', 'Date', { width: 110 }), textCol('paypal', 'PayPal ID', { width: 190, cellClass: 'mono' }), textCol('code', 'Code', { width: 84, cellClass: 'mono' }), textCol('subject', 'Subject', { flex: 1 }), moneyCol('gross', 'Gross'), moneyCol('net', 'Net'), textCol('line', 'Book line', { width: 100, cellClass: 'mono' }), textCol('memo', 'Memo', { flex: 1 }), moneyCol('amount', 'Booked'), textCol('rule', 'Rule', { width: 130 }), textCol('basis', 'Booked at', { width: 100 })],
    };
  }
  if (tab === 'paypal') {
    return {
      rows: state.paypal,
      cols: [textCol('date', 'Date', { width: 110 }), textCol('id', 'Transaction ID', { width: 190, cellClass: 'mono' }), textCol('code', 'Code', { width: 84, cellClass: 'mono' }), textCol('kind', 'Kind', { width: 104 }), textCol('subject', 'Subject', { flex: 1 }), textCol('payer', 'Payer', { width: 140 }), moneyCol('gross', 'Gross'), moneyCol('fee', 'Fee', 104), moneyCol('net', 'Net'), textCol('invoice', 'Invoice', { width: 110, cellClass: 'mono' }), textCol('ref', 'Refers to', { width: 190, cellClass: 'mono' })],
    };
  }
  if (tab === 'books') {
    return { rows: state.ledger, cols: [textCol('id', 'Line', { width: 90, cellClass: 'mono' }), textCol('date', 'Date', { width: 110 }), textCol('memo', 'Memo', { flex: 1 }), textCol('ref', 'Ref', { width: 140, cellClass: 'mono' }), moneyCol('amount', 'Amount')] };
  }
  const rows = [];
  state.exceptions.filter((e) => e.status === 'approved').forEach((e, i) => e.fix.lines.forEach((l) => rows.push({ entry: `JE-${String(i + 1).padStart(3, '0')}`, account: `${l.account} ${state.chart[l.account] ?? ''}`, debit: l.debit || null, credit: l.credit || null, memo: e.fix.memo, by: e.fix.by === 'claude' ? 'AI' : 'rule', exception: e.id })));
  return { rows, cols: [textCol('entry', 'Entry', { width: 96, cellClass: 'mono' }), textCol('account', 'Account', { width: 200 }), moneyCol('debit', 'Debit'), moneyCol('credit', 'Credit'), textCol('memo', 'Memo', { flex: 1, tooltipField: 'memo' }), { field: 'by', headerName: 'By', width: 92, cellRenderer: (p) => (p.node.rowPinned ? '' : p.value === 'AI' ? badge('claude', 'AI') : badge('rule', 'Rule')), filter: 'agTextColumnFilter' }, textCol('exception', 'Exception', { width: 210, cellClass: 'mono' })] };
}

// The grid takes its colours from the page's tokens, so it is green-bar paper in both themes.
function theme() {
  const css = getComputedStyle(document.documentElement);
  const t = (name) => css.getPropertyValue(name).trim();
  return agGrid.themeQuartz.withParams({
    backgroundColor: t('--sheet'), foregroundColor: t('--ink'), textColor: t('--ink'),
    oddRowBackgroundColor: t('--bar'), headerBackgroundColor: t('--sheet'), headerTextColor: t('--ink-2'),
    borderColor: t('--rule'), accentColor: t('--ledger'), chromeBackgroundColor: t('--sheet'),
    fontFamily: t('--sans'), headerFontFamily: t('--mono'), headerFontSize: 10.5, headerFontWeight: 600,
    fontSize: 13, rowHeight: 32, headerHeight: 34, spacing: 6, wrapperBorder: false, wrapperBorderRadius: 0,
    rowBorder: false, columnBorder: false, headerColumnBorder: false,
  });
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (grid) grid.setGridOption('theme', theme()); });

// A pinned bottom row with the totals of every money column over the rows that pass the filters,
// so the tie-out can be checked in the grid itself (on the journal: debits equal credits).
function pinTotals(api) {
  const cols = api.getColumnDefs().filter((c) => c.filter === 'agNumberColumnFilter').map((c) => c.field);
  if (!cols.length) return;
  const sum = Object.fromEntries(cols.map((f) => [f, 0]));
  let n = 0;
  api.forEachNodeAfterFilter((node) => { if (!node.data) return; n++; for (const f of cols) sum[f] += node.data[f] ?? 0; });
  const first = api.getColumnDefs().find((c) => !cols.includes(c.field) && c.field !== 'statusKey' && c.field !== 'status' && c.field !== 'by')?.field;
  api.setGridOption('pinnedBottomRowData', [{ ...sum, ...(first ? { [first]: `Total (${n})` } : {}) }]);
}

function drawGrid() {
  const { rows, cols } = columnsAndRows();
  const key = `${tab}`;
  if (grid && grid.__key === key) {
    const before = new Map(); grid.forEachNode((n) => n.data?.id && before.set(n.data.id, n.data.statusKey));
    grid.setGridOption('rowData', rows);
    pinTotals(grid);
    // Flash the rows whose status just changed (an approval, and the items it settled).
    if (tab === 'exceptions') {
      const changed = []; grid.forEachNode((n) => { if (n.data?.id && before.has(n.data.id) && before.get(n.data.id) !== n.data.statusKey) changed.push(n); });
      if (changed.length && !reduced.matches) grid.flashCells({ rowNodes: changed, flashDuration: 900, fadeDuration: 600 });
    }
    if (selected && tab === 'exceptions') grid.forEachNode((n) => { if (n.data.id === selected) n.setSelected(true); });
    return;
  }
  grid?.destroy();
  grid = agGrid.createGrid($('grid'), {
    theme: theme(),
    columnDefs: cols,
    rowData: rows,
    defaultColDef: { sortable: true, filter: true, floatingFilter: true, resizable: true, suppressHeaderMenuButton: false },
    animateRows: !reduced.matches,
    onFilterChanged: (e) => pinTotals(e.api),
    getRowClass: (p) => (p.node.rowPinned ? 'totals' : undefined),
    getRowId: tab === 'exceptions' || tab === 'paypal' || tab === 'books' ? (p) => (p.rowPinned ? `pinned-${p.rowPinned}` : p.data.id) : undefined,
    rowSelection: tab === 'exceptions' ? { mode: 'singleRow', checkboxes: false, enableClickSelection: true } : undefined,
    onRowClicked: (p) => { if (tab === 'exceptions' && !p.node.rowPinned) { selected = p.data.id; drawDetail(); } },
    tooltipShowDelay: 300,
  });
  grid.__key = key;
  pinTotals(grid);
}

const CHECKS = ['The exception is still open', 'The category is one of the twelve', 'Cites its own items, and only open ones', 'Every account is in the chart', 'Each line is one whole-cent debit or credit', 'Debits equal credits', 'Moves PayPal clearing by exactly the gap', 'Category fits the cited PayPal event codes', 'No foreign-currency item without a conversion'];

function drawDetail() {
  const el = $('detail');
  const e = state.exceptions.find((x) => x.id === selected);
  if (!e || tab !== 'exceptions') {
    el.innerHTML = tab === 'exceptions'
      ? `<div class="v-empty"><span class="v-label">Journal voucher</span><h3>Pick an exception</h3><p>Each row is a line where PayPal and the books disagree. Select one to see:</p><ul><li>the PayPal transactions and book lines behind it</li><li>the entry proposed to settle it, and why</li><li>the nine checks it has to pass</li></ul></div>`
      : `<div class="v-empty"><span class="v-label">${esc({ matched: 'Matched lines', paypal: 'PayPal activity', books: 'Books', journal: 'Journal' }[tab])}</span><h3>${esc({ matched: 'Paired by rule', paypal: 'What PayPal did', books: 'What the books say', journal: 'Approved entries' }[tab])}</h3><p>${esc({ matched: 'Each book line here was paired with one PayPal transaction, by reference or by an amount and date only one candidate fits.', paypal: 'Every balance-affecting transaction from Transaction Search, with its event code, gross, fee and net.', books: 'The PayPal clearing account as uploaded: each line is the signed change to account 1010.', journal: 'Every approved entry, one row per debit or credit. The totals row shows debits equal credits.' }[tab])}</p><p>The totals row at the bottom follows your filters.</p></div>`;
    return;
  }
  const byP = new Map(state.paypal.map((t) => [t.id, t]));
  const byL = new Map(state.ledger.map((l) => [l.id, l]));
  const doc = (kind, id) => {
    if (kind === 'p') { const t = byP.get(id); return `<div class="doc"><span class="src">PayPal</span><span class="what">${esc(t.code)} · ${esc(t.subject ?? t.kind)}</span><span class="amt ${t.net < 0 ? 'neg' : ''}">${fmt(t.net)}</span><span class="sub">${esc(t.date)} · ${esc(id)} · gross ${fmt(t.gross)}, fee ${fmt(t.fee)}${t.ref ? ` · refers to ${esc(t.ref)}` : ''}</span></div>`; }
    const l = byL.get(id); return `<div class="doc"><span class="src">Books</span><span class="what">${esc(l.memo || '(no memo)')}</span><span class="amt ${l.amount < 0 ? 'neg' : ''}">${fmt(l.amount)}</span><span class="sub">${esc(l.date)} · line ${esc(id)}${l.ref ? ` · ref ${esc(l.ref)}` : ''}</span></div>`;
  };
  const found = e.source === 'fee' ? 'Fee not booked' : e.source === 'paypal' ? 'Only in PayPal' : 'Only in the books';
  let html = `<div class="v-head"><span class="v-label">Journal voucher</span><span class="v-id">${esc(e.id)}</span></div>`;
  html += `<h3 class="v-title">${esc(e.fix ? state.config.categories[e.fix.category] ?? e.fix.category : found)}</h3>`;
  html += `<div class="v-meta">${statusChip(e)}${e.fix ? (e.fix.by === 'claude' ? badge('claude', 'AI') : badge('rule', 'Rule')) : ''}<span>gap <span class="v-gap ${e.gap < 0 ? 'neg' : ''}">${fmt(e.gap)}</span></span></div>`;
  html += `<div class="v-sec"><span class="v-label">Supporting items</span>${e.paypal.map((id) => doc('p', id)).join('')}${e.ledger.map((id) => doc('l', id)).join('')}</div>`;
  if (e.hints?.length) html += `<div class="v-sec">${e.hints.map((h) => `<div class="hint-box"><b>Found by code${h.kind === 'transposition' ? ' · possible transposition' : ''}</b><span>${esc(h.detail)} (see <code>${esc(h.with)}</code>)</span></div>`).join('')}</div>`;
  if (e.fix) {
    const f = e.fix;
    const lines = [...f.lines.filter((l) => l.debit), ...f.lines.filter((l) => !l.debit)];
    const dr = f.lines.reduce((a, l) => a + (l.debit || 0), 0), cr = f.lines.reduce((a, l) => a + (l.credit || 0), 0);
    html += `<div class="v-sec"><span class="v-label">Entry</span><table class="entry"><thead><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>${lines.map((l) => `<tr class="${l.debit ? 'dr' : 'cr'}"><td><span class="acct">${esc(l.account)}</span>${esc(state.chart[l.account] ?? 'not in chart')}</td><td class="n">${l.debit ? fmt(l.debit) : ''}</td><td class="n">${l.credit ? fmt(l.credit) : ''}</td></tr>`).join('')}</tbody><tfoot><tr><td>Total</td><td class="n"><span>${fmt(dr)}</span></td><td class="n"><span>${fmt(cr)}</span></td></tr></tfoot></table><div class="memo">Memo: ${esc(f.memo)}</div></div>`;
    if (f.explanation) html += `<div class="v-sec"><span class="v-label">${f.by === 'claude' ? `Why · AI (${esc(f.model ?? '')})` : 'Why · rule'}</span><div class="note ${f.by === 'claude' ? '' : 'rule'}">${esc(f.explanation)}</div></div>`;
    const extra = [...f.cites.paypal.filter((id) => !e.paypal.includes(id)).map((id) => doc('p', id)), ...f.cites.ledger.filter((id) => !e.ledger.includes(id)).map((id) => doc('l', id))];
    if (extra.length) html += `<div class="v-sec"><span class="v-label">Also settles</span>${extra.join('')}</div>`;
    html += `<div class="v-sec"><span class="v-label">Checks · ${e.check.ok ? 'all nine pass' : `${e.check.failures.length} failing`}</span><ul class="checks">`;
    html += e.check.ok ? CHECKS.map((t) => `<li><span class="tk">✓</span><span>${t}</span></li>`).join('')
      : e.check.failures.map((x) => `<li class="fail"><span class="tk x">✗</span><span><span class="rule-name">${esc(x.rule)}</span>${esc(x.detail)}</span></li>`).join('');
    html += '</ul>';
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
  el.innerHTML = html;
  $('approve')?.addEventListener('click', () => act(`/api/exceptions/${encodeURIComponent(e.id)}/approve`, {}));
  $('reject')?.addEventListener('click', () => act(`/api/exceptions/${encodeURIComponent(e.id)}/reject`, { reason: $('reason').value }));
  $('proposeOne')?.addEventListener('click', () => proposeOne(e.id));
}

async function act(path, body) {
  try { state = await api(path, { body }); render(); } catch (err) { setStatus(err.message); }
}

async function proposeOne(id) {
  const e = state.exceptions.find((x) => x.id === id);
  e.pending = true; render();
  try {
    const next = await api(`/api/exceptions/${encodeURIComponent(id)}/propose`, { post: true, body: {} });
    state = next;
  } catch (err) { e.pending = false; setStatus(`${id}: ${err.message}`); render(); return false; }
  render();
  return true;
}

$('proposeAll').addEventListener('click', async () => {
  busy = true; render();
  state = await api('/api/rules', { post: true, body: {} }); render();
  const tried = new Set();
  const todo = () => state.exceptions.filter((e) => e.status === 'open' && !e.fix && !tried.has(e.id));
  let n = 0;
  if (state.config.claude) {
    for (let next = todo()[0]; next; next = todo()[0]) {
      n++; setStatus(`AI is proposing ${n} of ~${n + todo().length - 1}…`);
      tried.add(next.id);
      const ok = await proposeOne(next.id);
      if (!ok) break;
    }
    setStatus('Proposals done. Review each one and approve or reject.');
  } else setStatus('Rule fixes proposed. AI is off on this server, so the other exceptions need a manual fix.');
  busy = false; render();
});

$('approveRules').addEventListener('click', async () => {
  for (const e of state.exceptions.filter((x) => x.status === 'open' && x.fix?.by === 'rule' && x.check?.ok)) {
    state = await api(`/api/exceptions/${encodeURIComponent(e.id)}/approve`, { post: true, body: {} });
  }
  setStatus('Rule fixes approved.'); render();
});

$('tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  tab = b.dataset.tab;
  for (const x of $('tabs').querySelectorAll('button')) x.classList.toggle('on', x === b);
  render();
});

const openView = () => { if (location.hash === '#close') render(); else location.hash = 'close'; };
$('openDemo').addEventListener('click', async () => { state = await api('/api/close/demo', { post: true, body: {} }); selected = null; grid?.destroy(); grid = null; openView(); });
$('resumeBtn').addEventListener('click', openView);
$('openPaypal').addEventListener('click', async () => {
  const file = $('csv').files[0];
  if (!$('period').value || !file) { $('paypalHint').textContent = 'Pick a month and a CSV first.'; return; }
  $('paypalHint').textContent = 'Reading PayPal Transaction Search…';
  try { state = await api('/api/close/paypal', { body: { period: $('period').value, ledgerCsv: await file.text() } }); selected = null; grid?.destroy(); grid = null; $('paypalHint').textContent = ''; openView(); }
  catch (err) { $('paypalHint').textContent = err.message; }
});
$('restart').addEventListener('click', () => { state = { config: state.config }; grid?.destroy(); grid = null; selected = null; history.pushState(null, '', location.pathname); render(); });
$('back').addEventListener('click', () => { history.pushState(null, '', location.pathname); render(); });

(async () => {
  const now = new Date(); now.setMonth(now.getMonth() - 1);
  $('period').value = now.toISOString().slice(0, 7);
  state = await api('/api/close');
  render();
})();
