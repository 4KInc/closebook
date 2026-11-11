// QuickBooks Online exports as the books: the PayPal account's rows, mapped to date, amount, memo, ref.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isQuickBooks, quickBooksRows, booksRows } from '../src/qbo.mjs';

const sample = readFileSync(new URL('../samples/quickbooks-online-general-ledger-SAMPLE.csv', import.meta.url), 'utf8');

test('a General Ledger export: only the PayPal account, dates to ISO, amounts in cents, Num as the reference', () => {
  assert.ok(isQuickBooks(sample));
  const lines = booksRows(sample);
  assert.deepEqual(lines.map((l) => [l.date, l.amount, l.ref]), [
    ['2026-11-02', -9000, '290211066S9097000'], ['2026-11-11', 4800, '9S634543FF897504U'],
    ['2026-11-11', 7250, '5SY66963X4673292W'], ['2026-11-11', 12900, '00471269GD276451U'],
  ]);
  assert.equal(lines[0].memo, 'Operator - Operator reimbursement payout');
  assert.ok(!isQuickBooks('id,date,amount,memo,ref\nB1,2026-11-02,-90.00,x,'), 'closebook\'s own format is not mistaken for QuickBooks');
});

test('a Transaction Detail by Account export, with an Account column instead of sections', () => {
  const csv = ['Sample Co', 'Transaction Detail by Account', '', 'Date,Transaction Type,Num,Name,Memo/Description,Account,Split,Amount',
    '11/05/2026,Deposit,,Buyer,Mug,PayPal,Sales,"1,034.50"', '11/06/2026,Expense,77,Kiln Co,Clay,Checking,Supplies,-20.00'].join('\n');
  assert.deepEqual(quickBooksRows(csv).map((l) => [l.date, l.amount, l.memo]), [['2026-11-05', 103450, 'Buyer - Mug']]);
});

test('anything it cannot read gets a clear message', () => {
  const two = ['x', 'Date,Transaction Type,Num,Name,Memo/Description,Account,Split,Amount', '11/05/2026,Deposit,,A,B,Checking,Sales,1.00', '11/05/2026,Deposit,,A,B,Savings,Sales,2.00'].join('\n');
  assert.throws(() => quickBooksRows(two), /couldn't tell which account is PayPal\. This file has: Checking, Savings/);
  assert.throws(() => quickBooksRows('Report\nDate,Transaction Type,Name\n11/05/2026,Deposit,A'), /no row with "Date" and "Amount"/);
  const bad = ['x', 'Date,Transaction Type,Num,Name,Memo/Description,Account,Split,Amount', '11/05/2026,Deposit,,A,B,PayPal,Sales,twelve'].join('\n');
  assert.throws(() => booksRows(bad), /the amount "twelve" isn't a number/);
});
