### Demo month: 5 runs, 16 exceptions each, model claude-opus-5-5 (2026-11-11)

| | Result |
|---|---|
| Proposals | 80 (0 errors) |
| Category matches the answer key | 80/80 (100%) |
| Passed every check | 80/80 (100%) |
| Passed on the first try | 78/80 (98%) |
| Used the expected account (when the category was right) | 67/67 (100%) |
| Paired a same-amount sale with the right book line | 25/25 (100%) |

| Exception | Expected | Category right | Checks pass | Most common answer |
|---|---|---|---|---|
| T1107 Refund JC-1043 | refund_not_booked | 5/5 | 5/5 | refund_not_booked (5) |
| T0006 1 x Bud vase | sale_not_booked | 5/5 | 5/5 | sale_not_booked (5) |
| T0006 1 x Pour-over set | fee_not_booked | 5/5 | 5/5 | fee_not_booked (5) |
| T0006 1 x Dinner plate set | fee_not_booked | 5/5 | 5/5 | fee_not_booked (5) |
| T0006 1 x Dinner plate set | fee_not_booked | 5/5 | 5/5 | fee_not_booked (5) |
| T0001 Kiln service - October | payout_not_booked | 5/5 | 5/5 | payout_not_booked (5) |
| T1110 Hold for dispute investigation | hold_not_booked | 5/5 | 5/5 | hold_not_booked (5) |
| T0400 Withdrawal to bank | amount_keyed_wrong | 5/5 | 5/5 | amount_keyed_wrong (5) |
| T1111 Cancellation of hold for dispute resolution | hold_not_booked | 5/5 | 5/5 | hold_not_booked (5) |
| T1201 Chargeback | reversal_not_booked | 5/5 | 5/5 | reversal_not_booked (5) |
| book L037: Craft fair sale - cash | not_in_paypal | 5/5 | 5/5 | not_in_paypal (5) |
| book L014: 1 x Pour-over set - Ava Brooks | fee_not_booked or duplicate_in_books | 5/5 | 5/5 | duplicate_in_books (3) |
| book L015: 1 x Pour-over set - Ava Brooks | duplicate_in_books or fee_not_booked | 5/5 | 5/5 | duplicate_in_books (5) |
| book L017: 1 x Dinner plate set - Zoe Rivera | fee_not_booked | 5/5 | 5/5 | fee_not_booked (5) |
| book L019: 1 x Dinner plate set - Ruby Shah | fee_not_booked | 5/5 | 5/5 | fee_not_booked (5) |
| book L036: Transfer to Chase checking | amount_keyed_wrong | 5/5 | 5/5 | amount_keyed_wrong (5) |
