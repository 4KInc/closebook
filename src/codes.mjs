// PayPal transaction event codes (Transaction Search `transaction_event_code`), grouped into the
// kinds the close cares about. Source: PayPal's "Transaction event codes" reference. A code not
// listed falls back to its two-digit group (T00, T01, ...), then to 'other'.

const EXACT = {
  T0001: 'payout',            // MassPay / Payouts payment sent
  T1105: 'hold',              // reversal of a general account hold
  T1106: 'reversal',          // payment reversal initiated by PayPal
  T1107: 'refund',            // payment refund initiated by the merchant
  T1110: 'hold',              // hold for dispute investigation
  T1111: 'hold',              // cancellation of a hold for dispute resolution
  T1201: 'reversal',          // chargeback
  T1202: 'reversal',          // chargeback reversal
};

const GROUP = {
  T00: 'payment',   // payments received or sent
  T01: 'fee',       // non-payment fees
  T02: 'fx',        // currency conversion
  T03: 'transfer',  // funding of the PayPal account (bank deposit)
  T04: 'transfer',  // withdrawal to bank
  T15: 'hold',      // temporary holds and releases
  T19: 'correction',
  T21: 'hold',      // reserves and releases
};

export function kindOf(code) {
  if (!code) return 'other';
  return EXACT[code] ?? GROUP[code.slice(0, 3)] ?? 'other';
}

// Which kinds of PayPal activity an exception category must cite. The checker uses this so a
// proposed fix cannot claim "refund not booked" about a transaction that is not a refund.
export const CATEGORIES = {
  fee_not_booked:            { needs: ['payment', 'refund', 'fee', 'payout'], label: 'PayPal fee not booked' },
  refund_not_booked:         { needs: ['refund'], label: 'Refund not booked' },
  reversal_not_booked:       { needs: ['reversal'], label: 'Chargeback or reversal not booked' },
  hold_not_booked:           { needs: ['hold'], label: 'Dispute hold or release not booked' },
  fx_not_booked:             { needs: ['fx'], label: 'Currency conversion not booked' },
  transfer_not_booked:       { needs: ['transfer'], label: 'Bank transfer not booked' },
  payout_not_booked:         { needs: ['payout', 'payment'], label: 'Payout not booked' },
  sale_not_booked:           { needs: ['payment'], label: 'Sale not booked' },
  amount_keyed_wrong:        { needs: ['payment', 'refund', 'payout', 'transfer'], books: true, label: 'Amount keyed wrong in the books' },
  duplicate_in_books:        { needs: [], books: true, label: 'Duplicate entry in the books' },
  not_in_paypal:             { needs: [], books: true, label: 'Book entry with no PayPal activity' },
  correction_not_booked:     { needs: ['correction', 'other'], label: 'PayPal account correction not booked' },
};
