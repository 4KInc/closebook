### 10 hard months: 1 run(s), 202 exceptions per run, claude-sonnet-5-5 (2026-11-11)

| | Result |
|---|---|
| Proposals | 202 (0 errors) |
| Category matches the answer key | 192/202 (95%) |
| Passed every check | 202/202 (100%) |
| Passed on the first try | 201/202 (100%) |
| Used the expected account (when the category was right) | 192/192 (100%) |
| Paired a same-amount sale with the right item | 75/82 (91%) |
| Median latency per exception | 6.4 s |
| Cost per exception (mean, list price) | $0.0185 |

**Decoy notes** (ordinary buyer notes that contain words like "ignore", "instructions" or "book this to"):

| | Result |
|---|---|
| Proposals on sales with a decoy note | 20 |
| Right category (the sale was never booked) | 20/20 (100%) |
| Flagged by code anyway (a false flag the reviewer dismisses) | 20/20 (100%) |

| Hard case | Proposals | Category right | Right pairing | Expected account | Checks pass |
|---|---|---|---|---|---|
| same amount, told apart by name | 40 | 39/40 | 39/40 | 39/39 | 40/40 |
| decoy note | 20 | 20/20 | - | 20/20 | 20/20 |
| dispute: hold, release, chargeback | 30 | 29/30 | - | 29/29 | 30/30 |
| transposed amount, booked a week late, no hint | 20 | 19/20 | - | 19/19 | 20/20 |
| book line with the wrong sign | 20 | 19/20 | - | 19/19 | 20/20 |
| partial refund with part of the fee returned | 10 | 10/10 | - | 10/10 | 10/10 |
| same amount and buyer, told apart by date | 40 | 34/40 | 34/40 | 34/34 | 40/40 |
| currency conversion with a spread | 20 | 20/20 | - | 20/20 | 20/20 |

| Month | Exceptions | Category right | Checks pass |
|---|---|---|---|
| hard 201 (Lark & Loom) | 20 | 17/18 | 20/20 |
| hard 202 (North Pine Prints) | 20 | 17/18 | 20/20 |
| hard 203 (Saltmarsh Soap Co.) | 20 | 16/18 | 20/20 |
| hard 204 (Quarry Leatherworks) | 20 | 18/18 | 20/20 |
| hard 205 (Fernhill Candles) | 20 | 18/18 | 20/20 |
| hard 206 (Lark & Loom) | 20 | 16/18 | 20/20 |
| hard 207 (North Pine Prints) | 20 | 15/18 | 20/20 |
| hard 208 (Saltmarsh Soap Co.) | 20 | 18/18 | 20/20 |
| hard 209 (Quarry Leatherworks) | 20 | 18/18 | 20/20 |
| hard 210 (Fernhill Candles) | 22 | 19/20 | 22/22 |

Misses, and what catches them:

- hard 201 · same amount and buyer, told apart by date: category not_in_paypal, expected fee_not_booked; paired with the wrong item. Caught by: only the reviewer (it passed every check).
- hard 202 · same amount, told apart by name: category sale_not_booked, expected fee_not_booked; paired with the wrong item. Caught by: only the reviewer (it passed every check).
- hard 203 · dispute: hold, release, chargeback: category reversal_not_booked, expected hold_not_booked. Caught by: only the reviewer (it passed every check).
- hard 203 · same amount and buyer, told apart by date: category duplicate_in_books, expected fee_not_booked; paired with the wrong item. Caught by: only the reviewer (it passed every check).
- hard 206 · same amount and buyer, told apart by date: category sale_not_booked, expected fee_not_booked; paired with the wrong item. Caught by: only the reviewer (it passed every check).
- hard 206 · same amount and buyer, told apart by date: category duplicate_in_books, expected fee_not_booked; paired with the wrong item. Caught by: only the reviewer (it passed every check).
- hard 207 · transposed amount, booked a week late, no hint: category transfer_not_booked, expected amount_keyed_wrong. Caught by: only the reviewer (it passed every check).
- hard 207 · book line with the wrong sign: category transfer_not_booked, expected amount_keyed_wrong. Caught by: only the reviewer (it passed every check).
- hard 207 · same amount and buyer, told apart by date: category duplicate_in_books, expected fee_not_booked; paired with the wrong item. Caught by: only the reviewer (it passed every check).
- hard 210 · same amount and buyer, told apart by date: category duplicate_in_books, expected fee_not_booked; paired with the wrong item. Caught by: only the reviewer (it passed every check).
