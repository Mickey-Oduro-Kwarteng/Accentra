/**
 * The `payment_method` enum (§2), and how to say it in English.
 *
 * Lives on its own because three tables now reference it — an expense records
 * how money went out, an invoice how it is expected to come in, and a
 * transaction how it moved. One list, so the words never drift apart between
 * the pages that show them.
 *
 * `mobile_money` is in here because it is a first-class payment rail in Ghana,
 * not an afterthought behind the card options. `cheque` is deliberately absent:
 * §2 offers it as an optional `alter type` and this app cannot know whether
 * that was run, so offering it would fail the insert on a database that never
 * added it.
 */
export const PAYMENT_METHODS = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'mobile_money', label: 'Mobile money' },
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'reimbursement', label: 'Reimbursement' },
]

const LABELS = Object.fromEntries(
  PAYMENT_METHODS.map((method) => [method.value, method.label]),
)

/** 'mobile_money' → 'Mobile money'. Falls back to an em dash, not to blank. */
export function formatPaymentMethod(value) {
  if (!value) return '—'
  return LABELS[value] ?? String(value).replace(/_/g, ' ')
}

/**
 * How an invoice may be settled. Nobody is reimbursed an invoice — that value
 * exists for money going the other way.
 */
export const INVOICE_PAYMENT_METHODS = PAYMENT_METHODS.filter(
  (method) => method.value !== 'reimbursement',
)
