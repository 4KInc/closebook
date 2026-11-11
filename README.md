# closebook

Month-end close for businesses that take payments through PayPal.

Every month a bookkeeper has to make the books' PayPal account agree with what PayPal actually did:
sales booked at the gross amount when PayPal kept a fee, refunds nobody recorded, a chargeback and
the hold before it, a payout sent from PayPal, a bank transfer typed with two digits swapped. Finding
and fixing those lines by hand takes hours.

closebook does it in three layers:

1. **Rules match.** PayPal activity comes from PayPal's Transaction Search API. Each book line is
   matched to a PayPal transaction by reference (transaction ID, invoice ID or custom field), or
   else by amount (gross or net) and a date within 3 days, if that pairing is the only candidate
   both ways. A sale booked at gross gets a rule-made fix for its fee.
2. **Claude proposes.** For every line the rules cannot settle, Claude proposes one journal entry:
   a category, the PayPal transactions and book lines it settles, debit and credit lines from the
   chart of accounts, a memo, and a plain explanation.
3. **Checks decide, and a person approves.** Each entry is checked before it can be approved:
   every account is in the chart, debits equal credits, it cites its own items and only open ones,
   it moves PayPal clearing by **exactly** the gap of the items it cites, and its category fits
   the cited PayPal event codes (a "refund not booked" fix must cite a refund). A fix that fails
   goes back to Claude once, with the failures attached. Nothing is approved automatically. A
   rejection's reason is shown to Claude for the rest of the close.

The gaps of all exceptions add up to the tie-out difference, so when every exception is fixed by
an entry that passed the checks, the difference is $0.00. The approved entries export as a journal
CSV.

closebook only reads PayPal. It never moves money.

## Run it

Node 24.

```sh
npm install
ANTHROPIC_API_KEY=... npm start        # http://localhost:8080
```

Open **the demo month**: a small ceramics shop's October with planted mistakes. It needs no PayPal
credentials. Without `ANTHROPIC_API_KEY`, only the rule fixes are proposed.

To close a real sandbox month, also set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` for a
sandbox REST app that has **Transaction search** enabled in the PayPal developer dashboard. Then
pick the month and upload the books for the PayPal clearing account as CSV with the columns
`date, amount` and optionally `id, memo, ref` (amount is the signed change to PayPal clearing).
Note from PayPal's API reference: new transactions can take up to three hours to appear in
Transaction Search, and one search covers at most 31 days.

```sh
npm test
```

## How it is built

| File | What it does |
|---|---|
| `src/paypal.mjs` | Transaction Search through PayPal's Server SDK (`@paypal/paypal-server-sdk`), paged |
| `src/normalize.mjs` | PayPal rows and the ledger CSV into one shape, amounts in whole cents |
| `src/codes.mjs` | PayPal event codes (T0006, T1107, T1201, ...) to kinds, and the fix categories |
| `src/match.mjs` | The matching rules, the exceptions and their gaps, the tie-out |
| `src/check.mjs` | The checks every fix must pass, and the default chart of accounts |
| `src/close.mjs` | One month's close: propose, approve, reject, journal, summary |
| `src/claude.mjs` | Claude's proposal: one structured-output call per exception, one retry on failed checks |
| `src/demo.mjs` | The demo month, with an answer key of what was planted |
| `public/` | The review screen, built on AG Grid |

## Built with

- PayPal Transaction Search API, through PayPal's Server SDK
- Claude (`claude-opus-5-5`) through the Anthropic SDK, with structured outputs
- AG Grid Community for the review grids

## License

MIT
