// Claude proposes a fix for one open exception. It sees the exception, every other open item it
// could pair with, the chart of accounts, and the reviewer's earlier decisions. Its answer is a
// journal entry in a fixed JSON schema; check.mjs then decides whether that entry is allowed.
// If the checks fail, Claude gets the failures back once and may try again.
import Anthropic from '@anthropic-ai/sdk';
import { CATEGORIES } from './codes.mjs';
import { check } from './check.mjs';
import { stateOf } from './close.mjs';
import { fmt } from './money.mjs';

export const MODEL = process.env.CLOSEBOOK_MODEL ?? 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'cites', 'lines', 'memo', 'explanation'],
  properties: {
    category: { type: 'string', enum: Object.keys(CATEGORIES) },
    cites: {
      type: 'object', additionalProperties: false, required: ['paypal', 'ledger'],
      properties: { paypal: { type: 'array', items: { type: 'string' } }, ledger: { type: 'array', items: { type: 'string' } } },
    },
    lines: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['account', 'side', 'amount_cents'],
        properties: { account: { type: 'string' }, side: { type: 'string', enum: ['debit', 'credit'] }, amount_cents: { type: 'integer' } },
      },
    },
    memo: { type: 'string' },
    explanation: { type: 'string' },
  },
};

const SYSTEM = `You are the reconciliation assistant in a month-end close for a small business that takes payments through PayPal.

The books keep a "PayPal clearing" account (1010) that should move exactly as the PayPal balance moves. Rules have already matched every book line they could to a PayPal transaction. You receive one exception the rules could not settle, plus the other open items, and you propose one journal entry that fixes it.

How the numbers work:
- Amounts are integer cents. A PayPal transaction's net = gross + fee (fees are negative). A book line's amount is its signed effect on PayPal clearing.
- The gap of a set of items = sum of PayPal net of the cited transactions - sum of the cited book line amounts.
- Your entry must move account 1010 (debits minus credits) by exactly the gap of the items you cite. Debits must equal credits.
- Cite the exception's own items, plus any other open items your entry also settles (for example the book line that was keyed with the wrong amount, or a related hold and its release). Do not cite items your entry does not settle. Citing an item settles its whole exception, so if you cite any item of another exception, cite every item of that exception.

Choose the category that describes what actually happened, and use the accounts a bookkeeper would expect: fees to 6100, refunds to 4900, chargebacks to 6150, payouts to contractors to 5100, transfers to the bank to 1000, dispute holds to 1210, duplicates and typos reversed against the account originally used (sales are 4000), and 3999 Suspense only when nothing else is supportable.

The memo is one line for the general ledger. The explanation is two or three plain sentences for the owner, naming the transaction IDs or book lines that show it.`;

function itemTable(close, st) {
  const rows = [];
  for (const e of st.open.values()) {
    for (const id of e.paypal) { const t = st.byP.get(id); rows.push(`PayPal ${t.id} | ${t.date} | ${t.code} (${t.kind}) | gross ${t.gross} fee ${t.fee} net ${t.net} | ${t.subject ?? ''}${t.ref ? ` | refers to ${t.ref}` : ''}${t.invoice ? ` | invoice ${t.invoice}` : ''} | exception ${e.id}`); }
    for (const id of e.ledger) { const l = st.byL.get(id); rows.push(`Book ${l.id} | ${l.date} | amount ${l.amount} | ${l.memo}${l.ref ? ` | ref ${l.ref}` : ''} | exception ${e.id}`); }
  }
  return [...new Set(rows)].join('\n');
}

function related(close, ex, st) {
  // Matched transactions that the open PayPal items refer to (a refund's original sale, for example).
  const refs = ex.paypal.map((id) => st.byP.get(id).ref).filter(Boolean);
  return close.paypal.filter((t) => refs.includes(t.id)).map((t) => `PayPal ${t.id} | ${t.date} | ${t.code} | gross ${t.gross} fee ${t.fee} | ${t.subject ?? ''}${t.invoice ? ` | invoice ${t.invoice}` : ''}`).join('\n') || '(none)';
}

export function prompt(close, ex) {
  const st = stateOf(close);
  const decisions = close.decisions.filter((d) => d.by === 'claude' || d.verdict === 'rejected').slice(-20)
    .map((d) => `- ${d.verdict}: ${d.category} "${d.memo}"${d.reason ? ` (reviewer: ${d.reason})` : ''}`).join('\n') || '(none yet)';
  const own = [...ex.paypal.map((id) => `PayPal ${id}`), ...ex.ledger.map((id) => `Book ${id}`)].join(', ');
  return `Period ${close.period}, currency ${close.currency}.

Chart of accounts:
${Object.entries(close.chart).map(([k, v]) => `${k} ${v}`).join('\n')}

Categories:
${Object.entries(CATEGORIES).map(([k, v]) => `${k}: ${v.label}`).join('\n')}

The reviewer's earlier decisions this close (follow them where they apply):
${decisions}

All open items:
${itemTable(close, st)}

Settled transactions these items refer to:
${related(close, ex, st)}

Exception to fix: ${ex.id} (${own}), gap ${ex.gap} cents (${fmt(ex.gap)}).${ex.hints?.length ? `\n\nFound by code (a pointer to check, not a decision): ${ex.hints.map((h) => `${h.kind} with ${h.with}: ${h.detail}`).join('; ')}.` : ''}${ex.rejected?.length ? `\n\nThe reviewer rejected an earlier fix for this exception: ${ex.rejected.map((r) => `"${r.fix.memo}"${r.reason ? `, because: ${r.reason}` : ''}`).join('; ')}.` : ''}`;
}

function toFix(ex, out) {
  return {
    exception: ex.id, by: 'claude', model: MODEL,
    category: out.category,
    cites: out.cites,
    lines: out.lines.map((l) => ({ account: l.account, debit: l.side === 'debit' ? l.amount_cents : 0, credit: l.side === 'credit' ? l.amount_cents : 0 })),
    memo: out.memo,
    explanation: out.explanation,
  };
}

async function ask(client, messages) {
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages,
  });
  if (res.stop_reason === 'refusal') throw new Error(`Claude declined: ${res.stop_details?.explanation ?? 'no reason given'}`);
  if (res.stop_reason === 'max_tokens') throw new Error('Claude ran out of output tokens');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { res, out: JSON.parse(text) };
}

// Returns { fix, check, attempts, usage }. Never approves anything.
export async function proposeWithClaude(close, ex, { client = new Anthropic() } = {}) {
  const messages = [{ role: 'user', content: prompt(close, ex) }];
  const attempts = [];
  for (let i = 0; i < 2; i++) {
    const { res, out } = await ask(client, messages);
    const fix = toFix(ex, out);
    const result = check(fix, stateOf(close), close.chart);
    attempts.push({ fix, check: result, usage: res.usage });
    if (result.ok) break;
    messages.push({ role: 'assistant', content: res.content.filter((b) => b.type === 'text') });
    messages.push({ role: 'user', content: `The entry failed these checks:\n${result.failures.map((f) => `- ${f.rule}: ${f.detail}`).join('\n')}\nPropose a corrected entry.` });
  }
  const last = attempts.at(-1);
  return { fix: last.fix, check: last.check, attempts };
}
