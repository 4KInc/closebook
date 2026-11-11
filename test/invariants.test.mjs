// Property tests: thousands of generated cases from a fixed seed, so every run checks the same
// cases and a failure prints the case that broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, fmt } from '../src/money.mjs';
import { match, tieOut, transposed } from '../src/match.mjs';
import { check, CLEARING, CHART } from '../src/check.mjs';
import { openClose, stateOf, propose, approve, summary, journal } from '../src/close.mjs';

function rng(seed) { // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const ACCOUNTS = Object.keys(CHART);

test('money: every whole-cent amount survives format then parse, with no float drift', () => {
  const r = rng(1);
  for (let i = 0; i < 20000; i++) {
    const c = int(r, -1e11, 1e11);
    assert.equal(cents(fmt(c)), c, `round trip of ${c}`);
    assert.ok(Number.isSafeInteger(c));
  }
  assert.equal(cents('0.10') + cents('0.20'), cents('0.30')); // 0.1 + 0.2 !== 0.3 in floats
  assert.throws(() => cents(0.1 + 0.2), /not an amount/);    // a float that is not whole cents is refused
  assert.equal(cents(19.8), 1980);
});

test('property: a balanced entry passes "balanced", and one cent off always fails it', () => {
  const r = rng(2);
  for (let i = 0; i < 3000; i++) {
    // Random debits; credits are the same total split randomly across other accounts.
    const debits = Array.from({ length: int(r, 1, 4) }, () => int(r, 1, 5_000_000));
    const total = debits.reduce((a, b) => a + b, 0);
    const n = int(r, 1, 4), cuts = Array.from({ length: n - 1 }, () => int(r, 1, total - 1)).sort((a, b) => a - b);
    const credits = [...cuts, total].map((c, k) => c - ([0, ...cuts][k])).filter((c) => c > 0);
    const lines = [...debits.map((d) => ({ account: ACCOUNTS[int(r, 0, ACCOUNTS.length - 1)], debit: d, credit: 0 })), ...credits.map((c) => ({ account: ACCOUNTS[int(r, 0, ACCOUNTS.length - 1)], debit: 0, credit: c }))];
    const sum = lines.reduce((s, l) => s + l.debit - l.credit, 0);
    assert.equal(sum, 0);
    const st = { byP: new Map(), byL: new Map([['L1', { id: 'L1', amount: 0 }]]), open: new Map([['X', { id: 'X', paypal: [], ledger: ['L1'] }]]), currency: 'USD' };
    const fix = { exception: 'X', category: 'not_in_paypal', cites: { paypal: [], ledger: ['L1'] }, lines };
    assert.ok(!check(fix, st).failures.some((f) => f.rule === 'balanced'), `balanced case ${i}`);
    const off = { ...fix, lines: [...lines.slice(0, -1), { ...lines.at(-1), credit: lines.at(-1).credit + 1 }] };
    assert.ok(check(off, st).failures.some((f) => f.rule === 'balanced'), `one cent off, case ${i}`);
  }
});

test('property: for random months, the gaps of all exceptions add up to the difference, and fixing each gap closes it', () => {
  const r = rng(3);
  for (let m = 0; m < 300; m++) {
    const paypal = [], ledger = [];
    const n = int(r, 1, 25);
    for (let i = 0; i < n; i++) {
      const gross = int(r, -500_000, 500_000) || 1, fee = r() < 0.6 ? -int(r, 0, Math.abs(gross) >> 4) : 0;
      const date = `2026-10-${String(int(r, 1, 28)).padStart(2, '0')}`;
      paypal.push({ id: `P${i}`, code: 'T0006', kind: 'payment', currency: 'USD', date, gross, fee, net: gross + fee, invoice: r() < 0.3 ? `INV-${i}` : null, custom: null });
      const roll = r();
      if (roll < 0.35) ledger.push({ id: `L${i}`, date, amount: gross + fee, ref: null });
      else if (roll < 0.6) ledger.push({ id: `L${i}`, date, amount: gross, ref: paypal[i].invoice });
      else if (roll < 0.75) ledger.push({ id: `L${i}`, date, amount: gross + int(r, -999, 999), ref: null });
      // otherwise: never booked
    }
    for (let k = 0; k < int(r, 0, 3); k++) ledger.push({ id: `LX${k}`, date: '2026-10-15', amount: int(r, -90_000, 90_000) || 7, ref: null });

    const close = openClose({ paypal, ledger, period: '2026-10' });
    const s0 = summary(close);
    assert.equal(close.exceptions.reduce((a, e) => a + e.gap, 0), s0.difference, `month ${m}`);

    for (const e of close.exceptions) {
      if (e.status !== 'open') continue;
      const g = e.gap;
      const lines = g >= 0 ? [{ account: CLEARING, debit: g, credit: 0 }, { account: '3999', debit: 0, credit: g }] : [{ account: '3999', debit: -g, credit: 0 }, { account: CLEARING, debit: 0, credit: -g }];
      const category = e.paypal.length ? 'sale_not_booked' : 'not_in_paypal';
      if (g === 0) continue;
      propose(close, e.id, { by: 'test', category, cites: { paypal: e.paypal, ledger: e.ledger }, lines });
      assert.equal(e.check.ok, true, `month ${m} ${e.id}: ${JSON.stringify(e.check.failures)}`);
      approve(close, e.id);
    }
    assert.equal(summary(close).difference, 0, `month ${m} closes`);
    for (const f of journal(close)) assert.equal(f.lines.reduce((s, l) => s + l.debit - l.credit, 0), 0);
  }
});

test('transposition: adjacent digits swapped are found, and nothing else is', () => {
  assert.equal(transposed(198000, 189000), true);
  assert.equal(transposed(-198000, -189000), true);
  assert.equal(transposed(1234, 1243), true);
  assert.equal(transposed(1234, 1432), false); // not adjacent
  assert.equal(transposed(1234, 1235), false);
  assert.equal(transposed(-12, 12), false);
  const r = rng(4);
  for (let i = 0; i < 5000; i++) {
    const a = int(r, 10, 10_000_000), b = int(r, 10, 10_000_000);
    if (transposed(a, b)) assert.equal(Math.abs(a - b) % 9, 0, `${a} ${b}`); // every transposition differs by a multiple of 9
  }
  assert.equal(tieOut([], []).difference, 0);
  assert.deepEqual(match([], []).exceptions, []);
});

test('generated months: the same seed gives the same month, every planted mistake stays open, gaps add up', async () => {
  const { generatedMonth } = await import('../src/generate.mjs');
  const { paypalRows, ledgerRows } = await import('../src/normalize.mjs');
  const { readFileSync } = await import('node:fs');
  const { seeds } = JSON.parse(readFileSync(new URL('../eval/seeds.json', import.meta.url), 'utf8'));
  for (const seed of [...seeds, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const g = generatedMonth(seed);
    assert.deepEqual(generatedMonth(seed), g, `seed ${seed} is reproducible`);
    const close = openClose({ paypal: paypalRows(g.transaction_details), ledger: ledgerRows(g.ledgerCsv), period: g.period });
    const open = new Set(close.exceptions.flatMap((e) => [...e.paypal, ...e.ledger]));
    for (const p of g.planted) assert.ok(open.has(p.paypal) || open.has(p.ledger), `seed ${seed}: ${p.kind} was silently matched`);
    assert.equal(close.exceptions.reduce((a, e) => a + e.gap, 0), summary(close).difference, `seed ${seed}`);
  }
});

test('hard months: reproducible, every planted case stays open, no hint for the late transposition, gaps add up', async () => {
  const { hardMonth } = await import('../src/generate.mjs');
  const { paypalRows, ledgerRows } = await import('../src/normalize.mjs');
  for (let seed = 201; seed <= 210; seed++) {
    const g = hardMonth(seed);
    assert.deepEqual(hardMonth(seed), g);
    const close = openClose({ paypal: paypalRows(g.transaction_details), ledger: ledgerRows(g.ledgerCsv), period: g.period });
    const open = new Set(close.exceptions.flatMap((e) => [...e.paypal, ...e.ledger]));
    for (const p of g.planted) assert.ok(open.has(p.paypal) || open.has(p.ledger), `seed ${seed}: ${p.hard} was matched`);
    const late = g.planted.filter((p) => p.hard?.startsWith('transposed')).map((p) => `X-${p.paypal ?? p.ledger}`);
    assert.ok(close.exceptions.filter((e) => late.includes(e.id)).every((e) => !e.hints.length), `seed ${seed}: the late transposition must get no hint`);
    assert.equal(close.foreign.length, 2, 'the EUR sale and its EUR conversion leg stay out of the USD tie-out');
    assert.equal(close.exceptions.reduce((a, e) => a + e.gap, 0), summary(close).difference);
  }
});
