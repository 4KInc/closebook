/* closebook front end: one AG Grid per tab, a detail panel, and calls to the server's JSON API.
   The HTML itself is built in view.mjs, where every value from the books or PayPal is escaped. */
import { fmt, words, esc, badge, statusChip, byBadge, itemsLabel, entryText, voucherHtml, itemsCellHtml, waterfallHtml, kindLabel, day } from './view.mjs';
const $ = (id) => document.getElementById(id);
let state = null;
let tab = 'exceptions';
let grid = null;
let selected = null;
let busy = false;

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
    $('paypalHint').textContent = !state?.config?.paypal ? 'PayPal isn\'t connected here yet, so only the demo month is available.' : ps && !ps.ok && ps.status ? 'We can\'t reach PayPal right now. Please try again in a few minutes.' : '';
    $('openPaypal').disabled = !state?.config?.paypal;
    $('openSandbox').disabled = !state?.config?.paypal;
    if (!state?.config?.paypal) $('sandboxHint').textContent = 'PayPal isn\'t connected here yet, so this month isn\'t available.';
    return;
  }
  $('start').hidden = true; $('app').hidden = false;
  const s = state.summary;
  $('source').innerHTML = [state.source.label, state.currency ?? 'USD', state.config.claude ? 'AI suggestions on' : state.recorded ? 'AI suggestions: saved' : 'AI suggestions off'].map((t) => `<span>${esc(t)}</span>`).join('');
  $('tPaypal').textContent = fmt(s.paypalNet);
  $('tBooks').textContent = fmt(s.books);
  countTo($('tDiff'), s.difference);
  $('tDiffTile').className = `fig diff ${s.difference === 0 ? 'good' : 'bad'}`;
  // One tick per exception, in the order a reviewer works through them.
  const kindOf = (e) => (e.status !== 'open' ? 'done' : e.pending ? 'pending' : e.fix ? (e.check.ok ? 'ready' : 'fail') : 'open');
  const order = { done: 0, ready: 1, fail: 2, pending: 3, open: 4 };
  const kinds = state.exceptions.map(kindOf).sort((a, b) => order[a] - order[b]);
  // PayPal's balance moved by exactly the net of the transactions read, or it did not.
  const b = s.balance;
  $('balcheck').hidden = !b;
  if (b) {
    const on = (x) => esc(day(x.asOf ?? x.asked));
    $('balcheck').innerHTML = `<span>Your PayPal balance went from <b>${fmt(b.opening.total)}</b> on ${on(b.opening)} to <b>${fmt(b.closing.total)}</b> on ${on(b.closing)}, a change of <b>${fmt(b.moved)}</b>.</span>${b.gap === 0 ? '<span class="ok">✓ every PayPal payment is accounted for</span>' : `<span class="off">✗ ${fmt(b.gap)} of it isn't in the payments we read</span>`}`;
  }
  $('waterfall').innerHTML = waterfallHtml(state);
  $('ticks').innerHTML = kinds.map((k) => `<span class="tick ${k}"></span>`).join('');
  const n = (k) => kinds.filter((x) => x === k).length;
  $('counts').innerHTML = `<span><b>${s.matched}</b> matched automatically</span><span class="k-done"><i></i><b>${n('done')}</b> done</span><span class="k-ready"><i></i><b>${n('ready')}</b> ready to approve</span>${n('fail') ? `<span class="k-fail"><i></i><b>${n('fail')}</b> need a fix</span>` : ''}<span><i></i><b>${n('open') + n('pending')}</b> to review</span>`;
  $('nEx').textContent = s.open; $('nMatched').textContent = s.matched; $('nPaypal').textContent = state.paypal.length; $('nBooks').textContent = state.ledger.length;
  $('nJournal').textContent = s.approved;
  $('proposeAll').disabled = busy || !state.exceptions.some((e) => e.status === 'open' && !e.fix);
  $('approveRules').disabled = busy || !state.exceptions.some((e) => e.status === 'open' && e.fix?.by === 'rule' && e.check?.ok);
  drawGrid();
  drawDetail();
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
      what: itemsLabel(state, e),
      kind: e.source === 'fee' ? 'PayPal fee missing' : e.source === 'paypal' ? 'Only in PayPal' : 'Only in your books',
      category: e.fix ? state.config.categories[e.fix.category] ?? e.fix.category : '',
      by: e.fix ? (e.fix.by === 'claude' ? 'AI' : 'auto') + (e.fix.recorded ? ' saved' : '') + (e.fix.original ? ' changed by you' : '') : '',
      entry: e.fix ? e.fix.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.account} ${fmt(l.debit || l.credit)}`).join(', ') : '',
      order: e.status === 'open' ? (e.fix ? (e.check.ok ? 1 : 0) : 2) : 3,
      // The cell shows a chip built from several fields; give it a value that changes with them
      // so AG Grid refreshes the cell.
      statusKey: `${e.status}|${e.pending ? 'p' : ''}|${e.fix ? (e.check.ok ? 'ok' : 'fail') : ''}|${e.coveredBy ?? ''}`,
      statusText: e.status === 'approved' ? 'approved' : e.status === 'covered' ? 'done' : !e.fix ? 'to review' : e.check.ok ? 'ready' : 'needs a fix',
    }));
    return {
      rows,
      cols: [
        { field: 'statusKey', headerName: 'Status', width: 130, pinned: 'left', cellRenderer: (p) => (p.node.rowPinned ? '' : statusChip(p.data)), sort: 'asc', comparator: (a, b, na, nb) => (na?.data?.order ?? 9) - (nb?.data?.order ?? 9), filter: 'agTextColumnFilter', filterValueGetter: (p) => p.data.statusText },
        textCol('kind', 'Found', { width: 150 }),
        moneyCol('gap', 'Difference'),
        textCol('what', 'What', { flex: 2, minWidth: 220, tooltipField: 'what', cellRenderer: (p) => (p.node.rowPinned ? esc(p.value) : itemsCellHtml(p.data, p.value)) }),
        textCol('category', 'Suggested fix', { flex: 1, minWidth: 170 }),
        { field: 'by', headerName: 'From', width: 196, cellRenderer: (p) => (p.node.rowPinned ? '' : byBadge(p.data)), filter: 'agTextColumnFilter' },
        textCol('entry', 'Journal entry', { flex: 1.4, minWidth: 220, tooltipField: 'entry', cellClass: 'mono' }),
      ],
    };
  }
  if (tab === 'matched') {
    const byP = new Map(state.paypal.map((t) => [t.id, t]));
    const byL = new Map(state.ledger.map((l) => [l.id, l]));
    return {
      rows: state.matches.map((m) => { const t = byP.get(m.paypal), l = byL.get(m.ledger); return { date: t.date, paypal: t.id, type: kindLabel(t), subject: t.subject, gross: t.gross, net: t.net, line: l.id, memo: l.memo, amount: l.amount, rule: m.rule === 'reference' ? 'invoice or ID' : 'amount and date', basis: m.basis === 'net' ? 'after fee' : m.basis === 'gross' ? 'before fee' : m.basis }; }),
      cols: [{ field: 'status', headerName: 'Status', width: 110, cellRenderer: (p) => (p.node.rowPinned ? '' : badge('good', 'Matched')) }, textCol('date', 'Date', { width: 110 }), textCol('type', 'Type', { width: 120 }), textCol('subject', 'Item', { flex: 1 }), moneyCol('gross', 'Amount'), moneyCol('net', 'You received'), textCol('memo', 'In your books', { flex: 1 }), moneyCol('amount', 'Booked'), textCol('rule', 'Matched by', { width: 140 }), textCol('basis', 'Booked', { width: 100 }), textCol('paypal', 'PayPal ID', { width: 190, cellClass: 'mono' }), textCol('line', 'Line', { width: 80, cellClass: 'mono' })],
    };
  }
  if (tab === 'paypal') {
    return {
      rows: state.paypal.map((t) => ({ ...t, type: kindLabel(t) })),
      cols: [textCol('date', 'Date', { width: 104 }), textCol('type', 'Type', { width: 120 }), textCol('subject', 'Item', { flex: 1, minWidth: 170, tooltipField: 'subject' }), textCol('payer', 'Customer', { width: 120 }), moneyCol('gross', 'Amount', 106), moneyCol('fee', 'PayPal fee', 100), moneyCol('net', 'You received', 116), textCol('invoice', 'Invoice', { width: 90, cellClass: 'mono' }), textCol('id', 'PayPal ID', { width: 170, cellClass: 'mono' })],
    };
  }
  if (tab === 'books') {
    return { rows: state.ledger, cols: [textCol('id', 'Line', { width: 90, cellClass: 'mono' }), textCol('date', 'Date', { width: 110 }), textCol('memo', 'Memo', { flex: 1 }), textCol('ref', 'Reference', { width: 140, cellClass: 'mono' }), moneyCol('amount', 'Amount')] };
  }
  const rows = [];
  state.exceptions.filter((e) => e.status === 'approved').forEach((e, i) => e.fix.lines.forEach((l) => rows.push({ entry: `JE-${String(i + 1).padStart(3, '0')}`, account: `${l.account} ${state.chart[l.account] ?? ''}`, debit: l.debit || null, credit: l.credit || null, memo: e.fix.memo, by: e.fix.by === 'claude' ? 'AI' : 'auto', exception: e.id })));
  return { rows, cols: [textCol('entry', 'Entry', { width: 96, cellClass: 'mono' }), textCol('account', 'Account', { width: 200 }), moneyCol('debit', 'Debit'), moneyCol('credit', 'Credit'), textCol('memo', 'Memo', { flex: 1, tooltipField: 'memo' }), { field: 'by', headerName: 'From', width: 92, cellRenderer: (p) => (p.node.rowPinned ? '' : p.value === 'AI' ? badge('claude', 'AI') : badge('rule', 'Auto')), filter: 'agTextColumnFilter' }, textCol('exception', 'Item', { width: 210, cellClass: 'mono' })] };
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

function drawDetail() {
  const el = $('detail');
  const e = state.exceptions.find((x) => x.id === selected);
  if (!e || tab !== 'exceptions') { el.innerHTML = voucherHtml(state, null, tab); return; }
  const html = voucherHtml(state, e, tab);
  entryGrid?.destroy(); entryGrid = null;
  el.innerHTML = html;
  if (e.fix && e.status === 'open') drawEntryGrid(e);
  $('cat')?.addEventListener('change', (ev) => editEntry(e.id, { category: ev.target.value }));
  $('revert')?.addEventListener('click', () => editEntry(e.id, { category: e.fix.original.category, lines: e.fix.original.lines, memo: e.fix.original.memo }));
  $('approve')?.addEventListener('click', () => act(`/api/exceptions/${encodeURIComponent(e.id)}/approve`, {}));
  $('reject')?.addEventListener('click', () => act(`/api/exceptions/${encodeURIComponent(e.id)}/reject`, { reason: $('reason').value }));
  $('proposeOne')?.addEventListener('click', () => proposeOne(e.id));
  $('citeOpen')?.addEventListener('click', () => {
    const open = state.exceptions.filter((x) => x.status === 'open');
    const openP = new Set(open.flatMap((x) => x.paypal)), openL = new Set(open.flatMap((x) => x.ledger));
    editEntry(e.id, { cites: { paypal: e.fix.cites.paypal.filter((id) => openP.has(id)), ledger: e.fix.cites.ledger.filter((id) => openL.has(id)) } });
  });
}

// The proposed entry as an AG Grid the reviewer can edit: account from the chart, debit or credit
// in dollars and cents. Each change is sent to the server, which re-runs every check.
let entryGrid = null;
// Dollars typed by a person into whole cents, without floating point; null if it is not an amount.
const parseDollars = (text) => {
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)?(?:\.(\d{1,2}))?$/.exec(String(text ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  return Number((m[1] ?? '0').replace(/,/g, '')) * 100 + Number(((m[2] ?? '') + '00').slice(0, 2));
};

function drawEntryGrid(e) {
  const rows = e.fix.lines.map((l, i) => ({ i, account: l.account, debit: l.debit || null, credit: l.credit || null }));
  const send = () => {
    const lines = [];
    entryGrid.forEachNode((n) => { if (!n.rowPinned) lines.push({ account: n.data.account, debit: n.data.debit ?? 0, credit: n.data.credit ?? 0 }); });
    editEntry(e.id, { lines });
  };
  const side = (field, other) => ({
    field, headerName: field === 'debit' ? 'Debit' : 'Credit', width: 104, type: 'rightAligned', editable: (p) => !p.node.rowPinned,
    cellClass: 'money ag-right-aligned-cell', valueFormatter: (p) => (p.value ? fmt(p.value) : ''),
    // A line is a debit or a credit: typing on one side clears the other. A blank cell is zero.
    valueSetter: (p) => { const c = p.newValue === '' || p.newValue == null ? 0 : parseDollars(p.newValue); if (c === null) { setStatus(`"${p.newValue}" isn't an amount. Type it like 12.50.`); return false; } p.data[field] = c || null; if (c) p.data[other] = null; return true; },
  });
  const totals = () => [{ account: 'Total', debit: rows.reduce((a, r) => a + (r.debit ?? 0), 0), credit: rows.reduce((a, r) => a + (r.credit ?? 0), 0) }];
  entryGrid = agGrid.createGrid($('entryGrid'), {
    theme: theme().withParams({ rowHeight: 30, headerHeight: 28, fontSize: 12.5 }),
    domLayout: 'autoHeight',
    rowData: rows,
    pinnedBottomRowData: totals(),
    getRowClass: (p) => (p.node.rowPinned ? 'totals' : undefined),
    singleClickEdit: true,
    stopEditingWhenCellsLoseFocus: true,
    rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
    columnDefs: [
      { field: 'account', headerName: 'Account', flex: 1, minWidth: 150, editable: (p) => !p.node.rowPinned, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: Object.keys(state.chart) },
        valueFormatter: (p) => (p.node.rowPinned ? 'Total' : `${p.value} ${state.chart[p.value] ?? 'not in chart'}`) },
      side('debit', 'credit'), side('credit', 'debit'),
    ],
    onCellValueChanged: send,
  });
  $('addLine').addEventListener('click', () => { rows.push({ i: rows.length, account: '3999', debit: null, credit: null }); entryGrid.setGridOption('rowData', rows); });
  $('dropLine').addEventListener('click', () => { const [sel] = entryGrid.getSelectedRows(); if (!sel) { setStatus('Click a line first, then remove it.'); return; } rows.splice(rows.indexOf(sel), 1); entryGrid.setGridOption('rowData', rows); send(); });
}

async function editEntry(id, changes) {
  try { state = await api(`/api/exceptions/${encodeURIComponent(id)}/edit`, { body: changes }); render(); } catch (err) { setStatus(err.message); }
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
    if (next.fallback) setStatus(`The AI isn't available right now (${next.fallback}), so you're seeing its saved suggestions. Each one was double-checked again just now.`);
  } catch (err) { e.pending = false; setStatus(err.message); render(); return false; }
  render();
  return true;
}

$('proposeAll').addEventListener('click', async () => {
  busy = true; render();
  try { state = await api('/api/rules', { post: true, body: {} }); } catch (err) { setStatus(err.message); busy = false; render(); return; }
  render();
  const tried = new Set();
  const todo = () => state.exceptions.filter((e) => e.status === 'open' && !e.fix && !tried.has(e.id));
  let n = 0;
  if (state.config.claude || state.recorded) {
    let fellBack = false;
    for (let next = todo()[0]; next; next = todo()[0]) {
      n++; if (!fellBack) setStatus(`The AI is suggesting a fix for item ${n} of ${n + todo().length - 1}…`);
      tried.add(next.id);
      const ok = await proposeOne(next.id);
      if (!ok) break;
      fellBack ||= state.exceptions.some((e) => e.fix?.recorded);
    }
    if (!fellBack) setStatus('Every item has a suggested fix. Look each one over, then approve or reject it.');
  } else setStatus('The PayPal fee fixes are ready. AI suggestions aren\'t available here, so the other items need a fix by hand.');
  busy = false; render();
});

$('approveRules').addEventListener('click', async () => {
  busy = true; render();
  try {
    for (const e of state.exceptions.filter((x) => x.status === 'open' && x.fix?.by === 'rule' && x.check?.ok)) {
      state = await api(`/api/exceptions/${encodeURIComponent(e.id)}/approve`, { post: true, body: {} });
    }
    setStatus('PayPal fee fixes approved.');
  } catch (err) { setStatus(err.message); }
  busy = false; render();
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
$('openSandbox').addEventListener('click', async () => {
  $('openSandbox').disabled = true;
  $('sandboxHint').textContent = 'Reading the month from PayPal…';
  try { state = await api('/api/close/sandbox', { post: true, body: {} }); selected = null; grid?.destroy(); grid = null; $('sandboxHint').textContent = ''; openView(); }
  catch (err) { $('sandboxHint').textContent = err.message; }
  $('openSandbox').disabled = false;
});
$('openPaypal').addEventListener('click', async () => {
  const file = $('csv').files[0];
  if (!$('period').value || !file) { $('paypalHint').textContent = 'Pick a month and choose your file first.'; return; }
  if (file.size > 2 * 1024 * 1024) { $('paypalHint').textContent = `That file is ${(file.size / 1048576).toFixed(1)} MB. It can be at most 2 MB: one month of PayPal activity is usually far less.`; return; }
  $('paypalHint').textContent = 'Reading the month from PayPal…';
  try { state = await api('/api/close/paypal', { body: { period: $('period').value, ledgerCsv: await file.text() } }); selected = null; grid?.destroy(); grid = null; $('paypalHint').textContent = ''; openView(); if (state.outside) setStatus(`${state.outside} line${state.outside > 1 ? 's' : ''} in your file ${state.outside > 1 ? 'are' : 'is'} dated outside this month, so ${state.outside > 1 ? 'they were' : 'it was'} left out.`); }
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
