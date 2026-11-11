# closebook

**Month-end close for businesses paid through PayPal.** closebook reads what PayPal actually did
that month (Transaction Search, the Balances API and the Disputes API), matches it line by line
against the books, and has Claude propose a journal entry for every line that does not match.
**Every proposed entry is checked by code to close its gap to the cent before a person can
approve it**, and the person can correct it in place.

> **For judges: two minutes, no setup.** Open
> [closebook-uju5.onrender.com](https://closebook-uju5.onrender.com) (free hosting: the first
> visit after a quiet spell can take up to a minute).
>
> 1. **Close November from PayPal**: closebook's own sandbox account, read live through
>    Transaction Search and the Balances API, against
>    [a four-line books file](samples/sandbox-2026-11-books.csv). Under the tie-out, PayPal's own
>    balance moved by exactly the net of the transactions read: *every transaction accounted
>    for*. Click **Propose fixes**, then approve: −$120.68 becomes **$0.00**.
> 2. **Open the demo month**: a ceramics shop's October with planted mistakes, including a
>    chargeback whose dispute comes from the Disputes API. **Propose fixes** asks Claude for an
>    entry for each of the 16 exceptions rules cannot settle. Click one: the voucher shows the
>    evidence, the entry, Claude's reasoning and the nine checks. **Edit any cell of the entry**
>    and watch the checks re-run.
> 3. What to look for: the difference reaching $0.00, an entry you break by one cent failing at
>    once, and the [accuracy measurement](#how-accurate-is-the-ai) against the demo's answer key.

**What happens to each line of the month:**

- **The books and PayPal agree →** a rule matches them by reference, or by amount and date when
  only one pairing fits. No model is involved.
- **A sale was booked at gross and PayPal kept a fee →** a rule writes the fee entry
  (Dr 6100 PayPal fees, Cr 1010 PayPal clearing) for the reviewer to approve.
- **Anything else** (an unrecorded refund, a chargeback and the hold before it, a payout, a
  transfer typed wrong, a duplicate, a cash sale posted to PayPal) **→** Claude proposes one
  entry with a category, the items it settles, debit and credit lines and a plain explanation.
- **Every entry, from a rule or from Claude →** fixed checks: it must balance, use accounts in the
  chart, cite only open items (and whole exceptions), fit the PayPal event codes it cites, and move
  PayPal clearing by **exactly** the gap it claims to close. An entry that fails cannot be approved.
- **Nothing is approved automatically.** A person approves, corrects or rejects every entry. A
  correction re-runs the checks at once; corrections and rejections are shown to Claude for the
  rest of the close.
- **PayPal checks itself.** PayPal's own balance at the start and end of the month (Balances API)
  must move by exactly the net of the transactions Transaction Search returned, so a transaction
  the search missed cannot hide.

> Built for the PayPal AI Hackathon. closebook only **reads** PayPal; it never moves money.

**State:** 37 tests, including property tests over thousands of generated entries and months. The
demo month opens with a difference of **−$897.44**; rule fixes bring it to −$825.15, and a correct
entry for each remaining exception brings it to **$0.00** (tested). On 11 November 2026 closebook
closed a real PayPal sandbox month (payouts, holds, sales, fees and a refund), read through
Transaction Search, to $0.00
([below](#closed-against-a-real-paypal-sandbox-account)).

## Why Claude proposes and code decides

A reconciliation is arithmetic with judgement on top. The judgement is the hard part for people:
which PayPal event explains this gap, which account it belongs in, whether two lines are a
duplicate or two sales. That is where Claude helps. The arithmetic is where a model must not be
trusted: an entry that is off by one cent, or that balances but moves the wrong account, leaves the
books wrong while looking finished.

So the work is split by what can be proved:

- **Code matches** what can be matched by rule, and never guesses between two candidates.
- **Claude proposes** an entry for the rest, in a fixed schema, with the items it settles cited by
  ID.
- **Code decides** whether the entry is admissible: nine checks, all arithmetic or lookups, none of
  them a model. An entry that fails cannot be approved.
- **A person approves** every entry, including rule-made ones, and can correct any of them in the
  grid; the checks run again on every change. Claude never approves, never posts, and nothing in
  closebook can move money in PayPal: it only reads (Transaction Search, Balances, Disputes).

Because every exception carries a gap, and the gaps add up to the tie-out difference, "every
exception closed by an entry that passed the checks" means the difference is exactly $0.00. The
checks do not prove an entry tells the right story (Claude can pass the checks with the wrong
category), which is why the last step is a person.

## The problem

At the end of every month a bookkeeper has to make the books' PayPal clearing account agree with
what PayPal did. PayPal's numbers rarely match the books on the first try:

- sales recorded at the gross price when PayPal paid out the net, after its fee;
- refunds and chargebacks nobody recorded, and the dispute hold PayPal placed before them;
- payouts sent from the PayPal balance and transfers to the bank, sometimes typed wrong;
- entries recorded twice, or posted to PayPal when the money arrived some other way.

Each one is easy once found. Finding them among hundreds of lines, and writing an entry that is
right to the cent, is what takes the hours.

## Closed against a real PayPal sandbox account

**Close November from PayPal** on the home page runs this close live, from the books file in
[`samples/`](samples/sandbox-2026-11-books.csv).

closebook has its own sandbox REST app with the **Transaction search** permission. Its November
2026 activity, read through Transaction Search, is ten rows:

- two Payouts (T0001, $90.00 plus a $0.25 fee each), and for each the hold PayPal placed and
  released around it (T1503, T1105);
- three sales paid by a sandbox buyer on 11 November (T0006: $48.00, $72.50 and $129.00, with
  PayPal fees of $2.17, $3.02 and $4.99);
- a $20.00 partial refund of the $129.00 sale (T1107).

We closed that month against a four-line books file
(`id,date,amount,memo,ref`): the first payout booked at $90.00 without its fee, and the three
sales booked at their gross amounts. The fees, the refund, the second payout and the holds were
not booked.

| Exception | Proposed by | Entry | Checks |
|---|---|---|---|
| Payout booked without its $0.25 fee | rule | Dr 6100 $0.25, Cr 1010 $0.25 | pass |
| Three sales booked without their fees | rule | Dr 6100, Cr 1010: $2.17, $3.02, $4.99 | pass |
| Hold and release, 2 November | Claude | Dr 1210, Cr 1010 $90.25; Dr 1010, Cr 1210 $90.25 (settles both) | pass |
| Hold and release, 7 November | Claude | the same, for the second pair | pass |
| Second payout, not booked | Claude | Dr 5100 $90.00, Dr 6100 $0.25, Cr 1010 $90.25 | pass |
| $20.00 partial refund, not booked | Claude | Dr 4900 $20.00, Cr 1010 $20.00 | pass |

Four lines matched, ten exceptions, eight entries approved (two of them settled a hold and its
release together), and the difference went from −$120.68 to **$0.00**. That run was on a local
server on 11 November 2026, after the sales reached Transaction Search. Earlier the same day, before
they appeared, the live site closed the six payout rows from −$90.50 to $0.00 the same way. In one
earlier local run Claude put the unbooked payout in 3999 Suspense instead of 5100: both pass the
checks, because the account is a judgement the checks cannot make. That is what the reviewer's
approval is for.

## How accurate is the AI

The demo month knows what it planted, so Claude's proposals can be graded. `scripts/eval.mjs`
opens a fresh demo month per run, asks for one proposal for each of the 16 exceptions the rules
leave open (without approving anything), and grades each against the answer key: the category,
whether the entry passed every check (first try, or after the one retry with the failures), the
account a bookkeeper would use, and, for two sales of the same amount, whether Claude paired each
with the right book line (only the buyer's name tells them apart).

<!-- eval:start -->
A first run (1 run, 16 proposals, `claude-opus-5-5`, 11 November 2026, against the version
deployed before the balance and dispute checks): **16/16 categories match the answer key, 16/16
entries pass every check, 15/16 on the first try**, 14/14 use the expected account, and 5/5
same-amount sales are paired with the right book line. A five-run measurement of the current
version replaces this.
<!-- eval:end -->

The checks are what make that number safe to use: an entry that is wrong in its arithmetic cannot
be approved however confident it looks, and the measurement above is about the judgement the checks
cannot make.

## Walk through the demo month

0. For a live month instead, click **Close November from PayPal** on the home page: ten real
   sandbox transactions against four book lines, −$120.68 to $0.00 the same way.
1. Open the app and click **Open the demo month**. The tiles show PayPal's net activity, the
   books' PayPal clearing balance, and the difference: **−$897.44**. 31 book lines are matched by
   rule; 39 exceptions are open.
2. Click **Propose fixes**. Rules write the 23 fee entries at once; Claude then proposes an entry
   for each of the other 16, one at a time (a few seconds each). Each row's badge shows **Ready**
   when its entry passed every check, or **Fails checks**.
3. Click **Approve all rule fixes that pass**. The difference counts down to **−$825.15**.
4. Click any Claude row. The panel shows the PayPal transactions and book lines it settles, the
   debit and credit lines, Claude's explanation and all nine checks. The $1,980.00 transfer booked
   as $1,890.00 carries a **Hint**: code found the two swapped digits, and the hint is part of
   Claude's prompt.
5. To correct an entry, edit its cells in the voucher (an account, an amount, a line); the checks
   re-run on every change, and **Revert** restores Claude's version. Approve the entries one by
   one. An entry that cites several items settles them all (a dispute
   hold and its release, for example). Any other pending entry that cited the same items fails its
   checks at once; **Reject** it with a reason and ask Claude again, and the reason is in Claude's
   next prompt.
6. When the last entry is approved the difference reads **$0.00**. The **Journal** tab's totals
   row shows debits equal to credits. **Export journal (CSV)** and **Export audit trail (CSV)**
   download the result.

## What the demo month contains

Juniper Ceramics, October 2026: 41 PayPal transactions and 37 book lines. The demo knows what it
planted (`src/demo.mjs`), so the tests can check closebook against it.

| Planted in the books | PayPal event | What closebook sees |
|---|---|---|
| 34 sales: most booked at gross, every fifth at net with its invoice ID | T0006 with a fee | 31 book lines matched; 23 sales at gross get a fee fix by rule |
| A sale never booked | T0006 | an open PayPal item |
| A sale booked twice | T0006 | two identical book lines; neither is matched by guessing |
| A refund never booked, with part of the fee returned | T1107 | an open PayPal item |
| A chargeback, the hold before it and the hold's release | T1201, T1110, T1111 | three open PayPal items, with the dispute (item not received, buyer won) from the Disputes API shape |
| A contractor payout with its fee | T0001 | an open PayPal item |
| A transfer to the bank of $1,980.00 typed as $1,890.00 | T0400 | an open PayPal item and an open book line |
| A $65 cash sale at a craft fair posted to PayPal | none | an open book line |

Two more sales of the same amount, close in date, are left open too: two book lines fit two PayPal
sales, so the date-and-amount rule refuses to pick and leaves them for review.

## How it works

1. **Read PayPal.** Three read-only APIs:
   - `GET /v1/reporting/transactions` through PayPal's Server SDK (`@paypal/paypal-server-sdk`,
     generated by APIMatic), with `fields=all`, balance-affecting records only, 500 a page, every
     page. Amounts become whole cents, and each event code becomes a kind (see
     [PayPal event codes](#paypal-event-codes)).
   - `GET /v1/reporting/balances` through the same SDK, as of the first and the last moment of
     the month. PayPal's balance must move by exactly the net of the transactions read; the
     screen shows the two balances, the times PayPal answered for, and ✓ or the amount missing.
   - `GET /v1/customer/disputes?disputed_transaction_id=…` for the original sale behind each hold
     and chargeback (a REST call with the app's own token; the Server SDK has no disputes
     controller). The reason, status, stage and outcome go into the voucher and Claude's prompt.
2. **Read the books.** A CSV of the PayPal clearing account: `date, amount` and optionally
   `id, memo, ref`, where amount is the signed change to PayPal clearing.
3. **Match by rule.** First by reference: the book line's `ref` equals the PayPal transaction ID,
   invoice ID or custom field, and the amount equals gross or net. Then by amount and date: the
   amount equals gross or net, the dates are at most 3 days apart, and the pairing is the only
   candidate both ways. Ambiguous pairs are never guessed. Code also flags an unmatched book line
   whose amount is a PayPal amount with two adjacent digits swapped, within the same date window;
   the flag is shown to Claude and to the reviewer as a hint, not a match.
4. **Open the exceptions.** Every unmatched PayPal transaction, every unmatched book line, and
   every sale matched at gross whose fee is unbooked becomes an exception with a **gap**: the
   PayPal net of its transactions minus the book amount of its lines. The gaps of all exceptions
   add up to the tie-out difference, which is tested.
5. **Propose a fix.** A rule writes the fee entry. For everything else Claude gets the chart of
   accounts, the categories, every open item, the settled transactions they refer to, the
   reviewer's earlier decisions and rejections, and returns one entry in a fixed JSON schema
   (structured outputs). Claude may cite several open items in one entry, such as a hold and its
   release.
6. **Check it.** Code, not a model, runs the checks below. A Claude entry that fails goes back to
   Claude once with the failures attached; if it still fails, it is shown with its failures and
   cannot be approved.
7. **A person corrects, if needed.** The entry in the voucher is an AG Grid: pick an account from
   the chart, type a debit or credit, add or remove a line, change the category. Each change goes
   to the server, which runs every check again; the original entry is kept and can be restored,
   and the change is one row in the audit trail and part of Claude's next prompt.
8. **A person approves.** Approval runs the checks again, closes the exception and every other
   open exception the entry cites, then re-checks every other pending entry, so one that clashes
   with what was just approved shows as failing at once (both lines of the duplicate, for
   example). Approved entries export as a journal CSV, and every approval and rejection as an
   audit trail.

### The checks

| Check | What it requires |
|---|---|
| open | the exception is still open |
| category | the category is one of the 12 below |
| cites | the entry cites its own exception's items, only items of open exceptions, and every item of any other exception it touches (approval settles that whole exception) |
| account | every account is in the chart of accounts |
| line | each line has exactly one positive whole-cent debit or credit |
| balanced | debits equal credits |
| closes_gap | the entry moves 1010 PayPal clearing by exactly the gap of the items it cites |
| category_fits | a cited PayPal transaction has a kind the category needs (a refund fix must cite a refund); a books-only category cites no PayPal transaction and must cite a book line; a fee fix's gap must equal the cited fees |
| currency | a transaction in another currency can only be cited by a currency conversion entry |

### PayPal event codes

Transaction Search reports each balance movement with an event code. A payment wrapper that only
sees "paid" and "refunded" cannot tell a chargeback from a refund, or a dispute hold from a
withdrawal; the close needs those differences, because each one goes to a different account.

| Code | What PayPal did | Kind | Usual entry |
|---|---|---|---|
| T0006 | checkout payment received, fee withheld | payment | Dr 1010 net, Dr 6100 fee, Cr 4000 gross |
| T1107 | refund sent by the merchant, part of the fee returned | refund | Dr 4900, Cr 6100 returned fee, Cr 1010 |
| T1110 | funds held for a dispute | hold | Dr 1210, Cr 1010 |
| T1111 | dispute hold released | hold | Dr 1010, Cr 1210 |
| T1201 | chargeback, with its fee | reversal | Dr 6150 (and 6100), Cr 1010 |
| T0001 | payout sent from the PayPal balance | payout | Dr 5100, Dr 6100 fee, Cr 1010 |
| T0400 | withdrawal to the bank | transfer | Dr 1000, Cr 1010 |
| T02xx | currency conversion | fx | the spread to 7100 |

Codes not listed exactly fall back to their group (T00 payments, T01 fees, T02 conversions, T03
and T04 transfers, T15 and T21 holds, T19 corrections) and then to "other" (`src/codes.mjs`).

### Reading PayPal safely

- **Paging:** every page up to `total_pages`, 500 at a time, stopping with a clear error past
  200 pages.
- **Too many results:** if PayPal answers `RESULTSET_TOO_LARGE`, the date window is split in half
  and each half read on its own.
- **Rate limits and outages:** 429, 5xx and network errors are retried up to five times with
  exponential backoff and jitter, honouring PayPal's `Retry-After`. The search is read-only, so a
  retry cannot repeat anything.
- **Clear errors:** a 401 names the credentials; a 403 says to enable **Transaction search** on
  the REST app; an empty month says that new transactions can take up to three hours to appear.
- **Balances and disputes are extra checks, not requirements:** if either call fails, the close
  still opens, without them, and the server logs why.
- **Startup check:** with PayPal credentials set, the server makes one small search at startup and
  logs (and shows on the start screen) whether the permission is missing.

### The categories

PayPal fee not booked · Refund not booked · Chargeback or reversal not booked · Dispute hold or
release not booked · Currency conversion not booked · Bank transfer not booked · Payout not booked
· Sale not booked · Amount keyed wrong in the books · Duplicate entry in the books · Book entry
with no PayPal activity · PayPal account correction not booked.

### The chart of accounts

1000 Bank checking · 1010 PayPal clearing · 1210 PayPal funds on hold · 3999 Suspense · 4000 Sales
· 4900 Refunds and returns · 5100 Contractor payouts · 6100 PayPal fees · 6150 Chargeback losses ·
7100 Currency gain or loss.

## What it does not do

- **It only reads PayPal.** It never refunds, pays out or changes anything in PayPal.
- **It does not post to accounting software.** Approved entries leave as a journal CSV.
- **One currency.** Transactions in another currency are kept out of the tie-out.
- **One account.** It reconciles PayPal clearing (1010) only, not the whole ledger.
- **The checks prove the entry closes the gap, not that the category is the right story.** An
  entry can pass and still be wrong in a way only the reviewer can judge, which is why every one
  needs a person.
- **Transaction Search limits:** per PayPal's API reference, new transactions can take up to three
  hours to appear, and one search covers at most 31 days.
- **No row grouping.** The grids use AG Grid Community, which has sorting, filters, pinned
  columns, pinned totals rows and cell flashing; row grouping is an Enterprise feature and is not
  used.
- **State is in memory.** Each browser gets its own close; it is lost on restart, sessions idle
  for 6 hours are dropped, and at most 2,000 are kept.

## Run it

Node 24.

```sh
npm install
npm test                               # 37 tests
npm start                              # http://localhost:8080, the demo month with rule fixes only
ANTHROPIC_API_KEY=... npm start        # with Claude's proposals
```

A `.env` file next to `server.mjs` is loaded at startup if present. `GET /health` answers
`{"ok":true,...}` for the host's health check. On `SIGTERM` or `SIGINT` the server stops taking
new connections, finishes the ones in flight, then exits.

To close a real sandbox month, also set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` for a sandbox
REST app with **Transaction search** enabled in the PayPal developer dashboard (without it PayPal
answers 403 NOT_AUTHORIZED). Then pick the month and upload the books as CSV; the
example at `/api/demo-ledger.csv` is the demo month's books. The books CSV must have `date`
(YYYY-MM-DD) and `amount` columns; a file that cannot be read is refused with the row numbers of
every problem.

To measure Claude against the demo's answer key (see [below](#how-accurate-is-the-ai)):

```sh
ANTHROPIC_API_KEY=... node scripts/eval.mjs --runs 5        # calls the model directly
node scripts/eval.mjs --runs 5 --server http://localhost:8080  # or drives a running closebook
```

| Variable | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on Claude's proposals. Without it, only rule fixes are proposed. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | A sandbox REST app with Transaction search enabled. Without them, only the demo month works. |
| `PAYPAL_ENVIRONMENT` | `production` to read a live account; sandbox otherwise. |
| `CLOSEBOOK_MODEL` | The Claude model, default `claude-opus-5-5`. |
| `CLAUDE_CALLS_PER_SESSION` | Claude proposals one browser session may ask for, default 80. |
| `CLAUDE_CALLS_PER_DAY` | Claude proposals the whole server may make per day (UTC), default 600. Rule fixes keep working past it. |
| `PORT` | Default 8080. |

## Layout

| File | What |
|---|---|
| `src/paypal.mjs` | Transaction Search and Balances through PayPal's Server SDK, Disputes over REST: paging, retries with backoff, window splitting, the startup check |
| `src/normalize.mjs` | PayPal rows and the books CSV into one shape, amounts in whole cents |
| `src/codes.mjs` | PayPal event codes to kinds, and the 12 fix categories |
| `src/match.mjs` | the matching rules, the exceptions and their gaps, the tie-out, the transposition hint |
| `src/check.mjs` | the checks every fix must pass, and the chart of accounts |
| `src/close.mjs` | one month's close: propose, approve, reject, journal, summary |
| `src/claude.mjs` | Claude's proposal: one structured-output call per exception, one retry on failed checks |
| `src/money.mjs` | parsing and formatting money without floating point |
| `src/demo.mjs` | the demo month, with an answer key of what was planted, its balances and its dispute |
| `samples/sandbox-2026-11-books.csv` | the books for the live sandbox month on the home page |
| `scripts/eval.mjs` | grades Claude's proposals against the demo's answer key, over several runs |
| `server.mjs` | the HTTP server: sessions, the API, the journal and audit exports, the Claude call limits, `/health`, graceful shutdown |
| `render.yaml` | the Render Blueprint the live demo runs from |
| `public/` | the review screen: tie-out, exceptions, matched lines, PayPal activity, books and journal, each an AG Grid |
| `test/close.test.mjs` | money, CSV, event codes, matching, every check, approval and rejection, a full close to $0.00 |
| `test/invariants.test.mjs` | property tests: money round trips, balanced entries, gaps summing to the difference over 300 generated months |
| `test/scenarios.test.mjs` | chargeback lifecycle, partial refund with part of the fee returned, currency conversion with a spread, the transposed transfer |
| `test/paypal.test.mjs` | the PayPal clients against a fake PayPal: paging, backoff, Retry-After, window splitting, balances, disputes, error messages |

## Built with

- PayPal Transaction Search and Balances APIs, through PayPal's Server SDK (generated by
  **APIMatic**), and the PayPal Disputes API
- Claude (`claude-opus-5-5`) through the Anthropic SDK, with structured outputs
- **AG Grid** Community for the review grids (filters on every column, pinned totals rows, status
  badges, cell flashing on approval) and for the editable entry in the voucher (select and text
  cell editors, a live totals row, every edit re-checked by the server)
- **Render** for the live demo: a Blueprint (`render.yaml`), a health check, graceful shutdown
- Node 24, no web framework; two dependencies

## License

MIT, see [LICENSE](LICENSE).
