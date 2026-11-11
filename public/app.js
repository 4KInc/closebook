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

function render() {
  if (!state?.close && !state?.summary) {
    $('start').hidden = false; $('app').hidden = true; $('source').textContent = '';
    const ps = state?.config?.paypalStatus;
    $('paypalHint').textContent = !state?.config?.paypal ? 'This server has no PayPal credentials configured, so only the demo month is available here.' : ps && !ps.ok && ps.status ? ps.message : '';
    $('openPaypal').disabled = !state?.config?.paypal;
    return;
  }
  $('start').hidden = true; $('app').hidden = false;
  const s = state.summary;
  $('source').textContent = `${state.source.label} · Claude: ${state.config.claude ? state.config.model : 'off (rules only)'}`;
  $('tPaypal').textContent = fmt(s.paypalNet);
  $('tBooks').textContent = fmt(s.books);
  countTo($('tDiff'), s.difference);
  $('tDiffTile').className = `tile diff ${s.difference === 0 ? 'good' : 'bad'}`;
  const ready = state.exceptions.filter((e) => e.status === 'open' && e.check?.ok).length;
  const done = s.approved + s.covered;
  $('barDone').style.width = `${(100 * done) / Math.max(1, s.exceptions)}%`;
  $('barReady').style.width = `${(100 * ready) / Math.max(1, s.exceptions)}%`;
  $('counts').textContent = `${s.matched} matched by rules · ${s.exceptions} exceptions: ${done} resolved, ${ready} ready to approve, ${s.open - ready} still open`;
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
  if (e.pending) return badge('info pulse', 'Claude…');
  if (!e.fix) return badge('', 'Exception');
  return e.check.ok ? badge('info', 'Ready') : badge('bad', 'Fails checks');
};
const byBadge = (e) => (!e.fix ? '' : e.fix.by === 'claude' ? badge('claude', 'Claude') : badge('rule', 'Rule'));

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
      by: e.fix ? (e.fix.by === 'claude' ? 'Claude' : 'rule') : '',
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
  state.exceptions.filter((e) => e.status === 'approved').forEach((e, i) => e.fix.lines.forEach((l) => rows.push({ entry: `JE-${String(i + 1).padStart(3, '0')}`, account: `${l.account} ${state.chart[l.account] ?? ''}`, debit: l.debit || null, credit: l.credit || null, memo: e.fix.memo, by: e.fix.by === 'claude' ? 'Claude' : 'rule', exception: e.id })));
  return { rows, cols: [textCol('entry', 'Entry', { width: 96, cellClass: 'mono' }), textCol('account', 'Account', { width: 200 }), moneyCol('debit', 'Debit'), moneyCol('credit', 'Credit'), textCol('memo', 'Memo', { flex: 1, tooltipField: 'memo' }), { field: 'by', headerName: 'By', width: 92, cellRenderer: (p) => (p.node.rowPinned ? '' : p.value === 'Claude' ? badge('claude', 'Claude') : badge('rule', 'Rule')), filter: 'agTextColumnFilter' }, textCol('exception', 'Exception', { width: 210, cellClass: 'mono' })] };
}

function theme() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const base = agGrid.themeQuartz.withParams({ fontSize: 13, rowHeight: 34, headerHeight: 36, spacing: 6, headerFontWeight: 600, wrapperBorderRadius: 10, accentColor: dark ? '#3fb393' : '#146c5b' });
  return dark && agGrid.colorSchemeDark ? base.withPart(agGrid.colorSchemeDark) : base;
}

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

function drawDetail() {
  const el = $('detail');
  const e = state.exceptions.find((x) => x.id === selected);
  if (!e || tab !== 'exceptions') { el.innerHTML = '<p class="muted">Select an exception to see the proposed entry, what it cites, and the checks.</p>'; return; }
  const byP = new Map(state.paypal.map((t) => [t.id, t]));
  const byL = new Map(state.ledger.map((l) => [l.id, l]));
  const item = (kind, id) => {
    if (kind === 'p') { const t = byP.get(id); return `<div><code>${esc(id)}</code> ${esc(t.date)} ${esc(t.code)} ${esc(t.subject ?? '')}<br><span class="muted">gross ${fmt(t.gross)} · fee ${fmt(t.fee)} · net ${fmt(t.net)}${t.ref ? ` · refers to ${esc(t.ref)}` : ''}</span></div>`; }
    const l = byL.get(id); return `<div><code>${esc(id)}</code> ${esc(l.date)} ${esc(l.memo)} <span class="money">${fmt(l.amount)}</span></div>`;
  };
  let html = `<h3>${esc(e.id)}</h3><div class="sub">${statusChip(e)} · gap <b class="money">${fmt(e.gap)}</b></div>`;
  html += `<div class="items">${e.paypal.map((id) => item('p', id)).join('')}${e.ledger.map((id) => item('l', id)).join('')}</div>`;
  if (e.hints?.length) html += e.hints.map((h) => `<div class="hint">${badge('warn', 'Found by code')} ${h.kind === 'transposition' ? 'Possible transposition' : esc(h.kind)} with <code>${esc(h.with)}</code>: ${esc(h.detail)}</div>`).join('');
  if (e.fix) {
    const f = e.fix;
    html += `<h3 style="margin-top:14px">${esc(state.config.categories[f.category] ?? f.category)}</h3><div class="sub">proposed by ${f.by === 'claude' ? `Claude (${esc(f.model ?? '')})` : 'a rule'}${e.attempts > 1 ? ' · corrected after failing its first checks' : ''}</div>`;
    html += `<table><tr><th>Account</th><th class="n">Debit</th><th class="n">Credit</th></tr>${f.lines.map((l) => `<tr><td>${esc(l.account)} ${esc(state.chart[l.account] ?? '?')}</td><td class="n">${l.debit ? fmt(l.debit) : ''}</td><td class="n">${l.credit ? fmt(l.credit) : ''}</td></tr>`).join('')}</table>`;
    html += `<div class="muted" style="font-size:13px">Memo: ${esc(f.memo)}</div>`;
    if (f.explanation) html += `<div class="why">${esc(f.explanation)}</div>`;
    const extra = [...f.cites.paypal.filter((id) => !e.paypal.includes(id)).map((id) => item('p', id)), ...f.cites.ledger.filter((id) => !e.ledger.includes(id)).map((id) => item('l', id))];
    if (extra.length) html += `<div class="muted" style="margin-top:8px">Also settles:</div><div class="items">${extra.join('')}</div>`;
    html += '<div class="muted" style="margin-top:10px">Checks</div><ul class="checks">';
    if (e.check.ok) html += ['The exception is still open', 'The category is a known one', 'Cites its own items, and only open ones', 'Every line uses an account in the chart', 'Each line is one positive whole-cent debit or credit', 'Debits equal credits', 'Moves PayPal clearing by exactly the gap', 'Category fits the cited PayPal event codes', 'No foreign-currency item without a conversion'].map((t) => `<li><span class="chip good">pass</span> ${t}</li>`).join('');
    else html += e.check.failures.map((x) => `<li><span class="chip bad">${esc(x.rule)}</span> ${esc(x.detail)}</li>`).join('');
    html += '</ul>';
    if (e.firstFailures) html += `<div class="muted" style="font-size:12.5px">First attempt failed: ${e.firstFailures.map((x) => esc(x.detail)).join('; ')}</div>`;
    if (e.status === 'open') {
      html += `<div class="btns"><button class="primary" id="approve" ${e.check.ok ? '' : 'disabled'}>Approve entry</button><button id="reject">Reject</button></div><textarea id="reason" rows="2" placeholder="Why reject? Claude reads this next time it proposes."></textarea>`;
    }
  } else if (e.status === 'open') {
    html += `<div class="btns"><button class="primary" id="proposeOne">${e.source === 'fee' ? 'Propose rule fix' : 'Ask Claude for a fix'}</button></div>`;
  }
  if (e.rejected?.length) html += `<div class="muted" style="margin-top:10px;font-size:12.5px">Rejected before: ${e.rejected.map((r) => `"${esc(r.fix.memo)}"${r.reason ? ` (${esc(r.reason)})` : ''}`).join('; ')}</div>`;
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
      n++; setStatus(`Claude is proposing ${n} of ~${n + todo().length - 1}…`);
      tried.add(next.id);
      const ok = await proposeOne(next.id);
      if (!ok) break;
    }
    setStatus('Proposals done. Review each one and approve or reject.');
  } else setStatus('Rule fixes proposed. Claude is off on this server, so the other exceptions need a manual fix.');
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

$('openDemo').addEventListener('click', async () => { state = await api('/api/close/demo', { post: true, body: {} }); selected = null; render(); });
$('openPaypal').addEventListener('click', async () => {
  const file = $('csv').files[0];
  if (!$('period').value || !file) { $('paypalHint').textContent = 'Pick a month and a CSV first.'; return; }
  $('paypalHint').textContent = 'Reading PayPal Transaction Search…';
  try { state = await api('/api/close/paypal', { body: { period: $('period').value, ledgerCsv: await file.text() } }); selected = null; render(); }
  catch (err) { $('paypalHint').textContent = err.message; }
});
$('restart').addEventListener('click', () => { state = { config: state.config }; grid?.destroy(); grid = null; render(); });

(async () => {
  const now = new Date(); now.setMonth(now.getMonth() - 1);
  $('period').value = now.toISOString().slice(0, 7);
  state = await api('/api/close');
  render();
})();
