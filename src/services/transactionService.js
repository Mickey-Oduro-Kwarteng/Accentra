import { supabase } from '../lib/supabaseClient'
import { formatCurrency, formatDate, formatStatus } from '../utils/format'
import { escapeFilterValue, unwrap } from './helpers'

/** Queries behind /portal/transactions. */

/**
 * Account cards. Reads the `account_balances` view, which sums transactions
 * onto each opening balance. An "All accounts" row is prepended so the card
 * strip doubles as the filter control.
 */
export async function listAccountBalances(organizationId) {
  const rows =
    unwrap(
      await supabase
        .from('account_balances')
        .select('account_id, name, institution, type, balance, transaction_count')
        .eq('organization_id', organizationId)
        .order('balance', { ascending: false }),
      'account balances',
    ) ?? []

  const total = rows.reduce((sum, row) => sum + Number(row.balance ?? 0), 0)

  return [
    {
      id: null,
      name: 'All accounts',
      balance: formatCurrency(total),
      institution: '',
      transactionCount: rows.reduce((sum, row) => sum + Number(row.transaction_count ?? 0), 0),
    },
    ...rows.map((row) => ({
      id: row.account_id,
      name: row.name,
      balance: formatCurrency(row.balance),
      institution: row.institution ?? '',
      transactionCount: row.transaction_count,
    })),
  ]
}

export async function listTransactions(organizationId, {
  accountId = null,
  filter = 'All',
  search = '',
  limit = 50,
} = {}) {
  let query = supabase
    .from('transactions')
    .select(
      `
      id, occurred_on, description, amount, status, reconciled,
      accounts (id, name),
      expense_categories (id, name)
    `,
    )
    .eq('organization_id', organizationId)
    .order('occurred_on', { ascending: false })
    .limit(limit)

  if (accountId) query = query.eq('account_id', accountId)
  if (filter === 'Money in') query = query.gt('amount', 0)
  if (filter === 'Money out') query = query.lt('amount', 0)
  if (filter === 'Uncategorised') query = query.is('category_id', null)

  const term = escapeFilterValue(search)
  if (term) query = query.ilike('description', `%${term}%`)

  const rows = unwrap(await query, 'transaction list') ?? []

  return rows.map((row) => ({
    id: row.id,
    date: formatDate(row.occurred_on),
    description: row.description,
    account: row.accounts?.name ?? '—',
    category: row.expense_categories?.name ?? 'Uncategorised',
    amount: formatCurrency(row.amount, { decimals: true }),
    positive: Number(row.amount) > 0,
    status: formatStatus(row.status),
    reconciled: row.reconciled,
  }))
}

/** Count for the reconciliation banner. `head: true` skips fetching the rows. */
export async function countUnreconciled(organizationId) {
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('reconciled', false)

  if (error) throw error
  return count ?? 0
}

/** The reconciliation queue, with enough detail to categorise and match each row. */
export async function listUnreconciled(organizationId, limit = 100) {
  const rows =
    unwrap(
      await supabase
        .from('transactions')
        .select(
          `
          id, occurred_on, description, amount, status, category_id, expense_id,
          accounts (id, name)
        `,
        )
        .eq('organization_id', organizationId)
        .eq('reconciled', false)
        .order('occurred_on', { ascending: false })
        .limit(limit),
      'unreconciled transactions',
    ) ?? []

  return rows.map((row) => ({
    id: row.id,
    date: formatDate(row.occurred_on),
    description: row.description,
    account: row.accounts?.name ?? '—',
    amount: formatCurrency(row.amount, { decimals: true }),
    // The raw figure, so an expense of the same size can be spotted.
    rawAmount: Number(row.amount),
    positive: Number(row.amount) > 0,
    status: formatStatus(row.status),
    categoryId: row.category_id ?? '',
    expenseId: row.expense_id ?? '',
  }))
}

/** Every transaction already pointing at an expense — the ones not to offer again. */
export async function listLinkedExpenseIds(organizationId) {
  const rows =
    unwrap(
      await supabase
        .from('transactions')
        .select('expense_id')
        .eq('organization_id', organizationId)
        .not('expense_id', 'is', null),
      'expense links',
    ) ?? []

  return new Set(rows.map((row) => row.expense_id))
}

/**
 * Clear a batch in one round trip.
 *
 * Per-row edits — the category and the matched expense — go one at a time
 * because each row gets a different value; the reconcile flag is a single `in`
 * update. All of it runs through RLS unchanged, so a viewer's batch simply
 * updates nothing.
 */
export async function bulkReconcile(
  transactionIds,
  { categoryByTransaction = {}, expenseByTransaction = {} } = {},
) {
  if (!transactionIds.length) return 0

  for (const id of transactionIds) {
    const patch = {}
    if (categoryByTransaction[id]) patch.category_id = categoryByTransaction[id]
    // An empty string means "no match" — but so does clearing one that was set,
    // so both map to null rather than being skipped.
    if (id in expenseByTransaction) patch.expense_id = expenseByTransaction[id] || null

    if (Object.keys(patch).length) {
      unwrap(
        await supabase.from('transactions').update(patch).eq('id', id),
        'transaction update',
      )
    }
  }

  unwrap(
    await supabase
      .from('transactions')
      .update({
        reconciled: true,
        reconciled_at: new Date().toISOString(),
        status: 'cleared',
      })
      .in('id', transactionIds),
    'reconciliation',
  )

  return transactionIds.length
}

export async function reconcileTransaction(transactionId) {
  return unwrap(
    await supabase
      .from('transactions')
      .update({ reconciled: true, reconciled_at: new Date().toISOString(), status: 'cleared' })
      .eq('id', transactionId)
      .select()
      .single(),
    'reconciliation',
  )
}

export async function categoriseTransaction(transactionId, categoryId) {
  return unwrap(
    await supabase
      .from('transactions')
      .update({ category_id: categoryId })
      .eq('id', transactionId)
      .select()
      .single(),
    'categorisation',
  )
}

export const TRANSACTION_STATUSES = [
  { value: 'cleared', label: 'Cleared' },
  { value: 'pending', label: 'Pending' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'failed', label: 'Failed' },
]

/**
 * `amount` is signed: positive is money in, negative is money out. The form
 * collects a magnitude and a direction and applies the sign before calling
 * this — a zero is rejected by the `transactions_amount_nonzero` constraint.
 */
export async function createTransaction(organizationId, transaction) {
  return unwrap(
    await supabase
      .from('transactions')
      .insert({
        organization_id: organizationId,
        account_id: transaction.accountId,
        category_id: transaction.categoryId ?? null,
        // The seam between the cost and the cash. Set on either side and the
        // two records stop being independent guesses at the same event.
        expense_id: transaction.expenseId ?? null,
        invoice_id: transaction.invoiceId ?? null,
        occurred_on: transaction.occurredOn,
        description: transaction.description,
        amount: transaction.amount,
        currency: transaction.currency ?? 'GHS',
        fx_rate: transaction.fxRate ?? 1,
        status: transaction.status ?? 'cleared',
        external_ref: transaction.externalRef || null,
      })
      .select()
      .single(),
    'transaction creation',
  )
}

export async function deleteTransaction(transactionId) {
  return unwrap(
    await supabase.from('transactions').delete().eq('id', transactionId),
    'transaction delete',
  )
}

/**
 * Live feed. Realtime respects RLS, so this only ever delivers rows the caller
 * may already read — but the table must be added to the publication first:
 *   alter publication supabase_realtime add table public.transactions;
 *
 * Returns an unsubscribe function; call it in onBeforeUnmount.
 */
export function subscribeToTransactions(organizationId, onInsert) {
  const channel = supabase
    .channel(`transactions:${organizationId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'transactions',
        filter: `organization_id=eq.${organizationId}`,
      },
      (payload) => onInsert(payload.new),
    )
    .subscribe()

  return () => supabase.removeChannel(channel)
}

/** Everything the transactions page needs, fetched in parallel. */
export async function getTransactionPageData(organizationId, options = {}) {
  const [accounts, rows, unreconciled] = await Promise.all([
    listAccountBalances(organizationId),
    listTransactions(organizationId, options),
    countUnreconciled(organizationId),
  ])
  return { accounts, rows, unreconciled }
}
