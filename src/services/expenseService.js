import { supabase } from '../lib/supabaseClient'
import { formatCurrency, formatDate, formatStatus } from '../utils/format'
import { escapeFilterValue, unwrap } from './helpers'
import { formatPaymentMethod } from './paymentMethods'
import { createTransaction, listLinkedExpenseIds } from './transactionService'

export { PAYMENT_METHODS } from './paymentMethods'

/** Queries behind /portal/expenses. */

const STATUS_BY_LABEL = {
  Approved: 'approved',
  Pending: 'pending',
  Rejected: 'rejected',
  Reimbursed: 'reimbursed',
}

export async function getExpenseStats(organizationId) {
  const row = unwrap(
    await supabase.rpc('expense_stats', { org: organizationId }).single(),
    'expense stats',
  )

  return {
    spentThisMonth: formatCurrency(row.spent_this_month),
    expenseCount: row.expense_count,
    pendingAmount: formatCurrency(row.pending_amount),
    pendingCount: row.pending_count,
    reimbursable: formatCurrency(row.reimbursable),
    reimbursablePeople: row.reimbursable_people,
    topCategory: row.top_category ?? '—',
    topCategoryShare: row.top_category_share == null ? '—' : `${row.top_category_share}%`,
  }
}

/** Category meters. `share` is already a percentage from the RPC. */
export async function getExpenseBreakdown(organizationId, since = null) {
  const rows =
    unwrap(
      await supabase.rpc('expense_breakdown', { org: organizationId, since }),
      'expense breakdown',
    ) ?? []

  return rows.map((row) => ({
    id: row.category_id,
    label: row.label,
    amount: formatCurrency(row.amount),
    share: Number(row.share ?? 0),
  }))
}

/**
 * Expense table. "Reimbursable" is a boolean flag rather than a status, so it
 * filters on a different column from the other tabs.
 */
export async function listExpenses(organizationId, { filter = 'All', search = '', limit = 50 } = {}) {
  let query = supabase
    .from('expenses')
    .select(
      `
      id, vendor, spent_on, amount, method, method_detail, status, reimbursable, receipt_url,
      submitted_by,
      expense_categories (id, name),
      profiles!expenses_submitted_by_fkey (id, full_name)
    `,
    )
    .eq('organization_id', organizationId)
    .order('spent_on', { ascending: false })
    .limit(limit)

  if (filter === 'Reimbursable') {
    query = query.eq('reimbursable', true)
  } else if (STATUS_BY_LABEL[filter]) {
    query = query.eq('status', STATUS_BY_LABEL[filter])
  }

  const term = escapeFilterValue(search)
  if (term) query = query.ilike('vendor', `%${term}%`)

  const rows = unwrap(await query, 'expense list') ?? []

  return rows.map((row) => ({
    id: row.id,
    vendor: row.vendor,
    category: row.expense_categories?.name ?? 'Uncategorised',
    date: formatDate(row.spent_on),
    method: row.method_detail || formatPaymentMethod(row.method),
    amount: formatCurrency(row.amount, { decimals: true }),
    status: formatStatus(row.status),
    // The raw enum too — the row actions decide what is offered from the value,
    // not from the display label.
    statusValue: row.status,
    owner: row.profiles?.full_name ?? 'Unknown',
    submittedBy: row.submitted_by,
    reimbursable: row.reimbursable,
    receiptUrl: row.receipt_url,
  }))
}

/** One claim, unformatted, for the edit form to fill itself from. */
export async function getExpense(expenseId) {
  return unwrap(
    await supabase
      .from('expenses')
      .select(
        `
        id, organization_id, category_id, account_id, vendor, spent_on, amount,
        currency, method, method_detail, status, reimbursable, receipt_url, notes,
        submitted_by
      `,
      )
      .eq('id', expenseId)
      .single(),
    'expense lookup',
  )
}

export async function listExpenseCategories(organizationId) {
  return (
    unwrap(
      await supabase
        .from('expense_categories')
        .select('id, name')
        .eq('organization_id', organizationId)
        .is('archived_at', null)
        .order('name'),
      'category list',
    ) ?? []
  )
}

/**
 * Add a category from inside the expense form, so filing a claim never has to
 * be abandoned to go and create one. The table has a
 * `unique (organization_id, name)` constraint, so a duplicate is rejected by
 * the database rather than being silently merged.
 */
export async function createExpenseCategory(organizationId, name) {
  return unwrap(
    await supabase
      .from('expense_categories')
      .insert({ organization_id: organizationId, name: name.trim() })
      .select('id, name')
      .single(),
    'category creation',
  )
}

/**
 * File a claim. `submitted_by` must be the caller — the RLS insert policy
 * checks it, so passing anyone else's id fails at the database.
 */
export async function createExpense(organizationId, userId, expense) {
  return unwrap(
    await supabase
      .from('expenses')
      .insert({
        organization_id: organizationId,
        submitted_by: userId,
        category_id: expense.categoryId ?? null,
        account_id: expense.accountId ?? null,
        vendor: expense.vendor,
        spent_on: expense.spentOn,
        amount: expense.amount,
        currency: expense.currency ?? 'GHS',
        method: expense.method ?? 'card',
        method_detail: expense.methodDetail ?? null,
        reimbursable: expense.reimbursable ?? false,
        receipt_url: expense.receiptUrl ?? null,
        notes: expense.notes ?? null,
        status: 'pending',
      })
      .select()
      .single(),
    'expense creation',
  )
}

/** The `expense_status` enum, in the order a claim usually moves through it. */
export const EXPENSE_STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'reimbursed', label: 'Reimbursed' },
]

/**
 * Move a claim to any status, in either direction.
 *
 * A decision is not a one-way door — an expense approved by mistake has to be
 * able to go back — so this is one function rather than a separate verb per
 * transition. Sending a claim back to pending clears the decision stamped on
 * it, otherwise the row would still name an approver for a claim nobody has
 * approved.
 *
 * Requires a write role; RLS rejects it otherwise, so there is no UI check.
 */
export async function setExpenseStatus(expenseId, status, approverId = null) {
  const patch = { status }

  if (status === 'approved' || status === 'rejected') {
    patch.approved_by = approverId
    patch.approved_at = new Date().toISOString()
  } else if (status === 'pending') {
    patch.approved_by = null
    patch.approved_at = null
  }

  return unwrap(
    await supabase.from('expenses').update(patch).eq('id', expenseId).select().single(),
    'expense status change',
  )
}

export function approveExpense(expenseId, approverId) {
  return setExpenseStatus(expenseId, 'approved', approverId)
}

export function rejectExpense(expenseId, approverId) {
  return setExpenseStatus(expenseId, 'rejected', approverId)
}

export function markExpenseReimbursed(expenseId) {
  return setExpenseStatus(expenseId, 'reimbursed')
}

/**
 * File a claim *and* record the money leaving the account, linked.
 *
 * An expense is a cost; a transaction is a cash movement. They are separate
 * tables because they genuinely come apart — a card settles days later, a
 * reimbursable claim has no bank line at all until it is paid back, and one
 * payment can settle several claims. But when they *are* the same event,
 * `transactions.expense_id` says so, and nothing downstream has to guess.
 *
 * `accountId` is required here: `transactions.account_id` is not nullable, and
 * money cannot leave an account nobody named.
 *
 * If the transaction fails the claim is removed again. A claim left behind
 * without its bank line would silently overstate the account balance, and the
 * caller was asking for both or neither.
 */
export async function createExpenseWithPayment(organizationId, userId, expense) {
  const created = await createExpense(organizationId, userId, expense)

  try {
    await createTransaction(organizationId, {
      accountId: expense.accountId,
      categoryId: expense.categoryId ?? null,
      expenseId: created.id,
      occurredOn: expense.spentOn,
      description: expense.vendor,
      // Money out is negative — the sign is what makes `sum(amount)` mean
      // anything.
      amount: -Math.abs(Number(expense.amount)),
      currency: expense.currency ?? 'GHS',
      status: 'cleared',
    })
  } catch (caught) {
    const { error } = await supabase.from('expenses').delete().eq('id', created.id)
    if (error) {
      throw new Error(
        `The expense was saved, but the matching bank transaction could not be recorded (${caught.message}). Add it from the transactions page so the account balance stays right.`,
      )
    }
    throw caught
  }

  return created
}

/**
 * Claims that no transaction points at yet — the match candidates in the
 * reconciliation dialog.
 *
 * Reimbursable claims are excluded: the bank line for one of those is the
 * repayment to the person, not the original purchase, and matching them here
 * would attach the wrong cash movement to the cost.
 */
export async function listUnlinkedExpenses(organizationId, { since = null } = {}) {
  const linked = await listLinkedExpenseIds(organizationId)

  const cutoff =
    since ??
    (() => {
      const date = new Date()
      date.setDate(date.getDate() - 90)
      return date.toISOString().slice(0, 10)
    })()

  const rows =
    unwrap(
      await supabase
        .from('expenses')
        .select('id, vendor, spent_on, amount, category_id, status')
        .eq('organization_id', organizationId)
        .eq('reimbursable', false)
        .gte('spent_on', cutoff)
        .order('spent_on', { ascending: false }),
      'expense list',
    ) ?? []

  return rows
    .filter((row) => !linked.has(row.id))
    .map((row) => ({
      id: row.id,
      vendor: row.vendor,
      date: formatDate(row.spent_on),
      amount: Number(row.amount),
      amountLabel: formatCurrency(row.amount, { decimals: true }),
      categoryId: row.category_id ?? '',
      status: formatStatus(row.status),
    }))
}

export async function updateExpense(expenseId, expense) {
  return unwrap(
    await supabase
      .from('expenses')
      .update({
        category_id: expense.categoryId ?? null,
        account_id: expense.accountId ?? null,
        vendor: expense.vendor,
        spent_on: expense.spentOn,
        amount: expense.amount,
        method: expense.method,
        method_detail: expense.methodDetail ?? null,
        reimbursable: expense.reimbursable ?? false,
        notes: expense.notes ?? null,
      })
      .eq('id', expenseId)
      .select()
      .single(),
    'expense update',
  )
}

export async function deleteExpense(expenseId) {
  return unwrap(
    await supabase.from('expenses').delete().eq('id', expenseId),
    'expense delete',
  )
}

/**
 * Claims with no receipt attached yet — the picker in the upload dialog. Newest
 * first, since a receipt is almost always for something just filed.
 */
export async function listExpensesMissingReceipts(organizationId, limit = 40) {
  const rows =
    unwrap(
      await supabase
        .from('expenses')
        .select('id, vendor, spent_on, amount, status')
        .eq('organization_id', organizationId)
        .is('receipt_url', null)
        .order('spent_on', { ascending: false })
        .limit(limit),
      'expense list',
    ) ?? []

  return rows.map((row) => ({
    id: row.id,
    vendor: row.vendor,
    date: formatDate(row.spent_on),
    amount: formatCurrency(row.amount, { decimals: true }),
    status: formatStatus(row.status),
  }))
}

/**
 * Upload a receipt. The path must start with the organisation id — the storage
 * policy reads that first segment to decide access.
 */
export async function uploadReceipt(organizationId, expenseId, file) {
  const path = `${organizationId}/${expenseId}/${Date.now()}-${file.name}`

  const { error } = await supabase.storage
    .from('receipts')
    .upload(path, file, { upsert: false })
  if (error) throw error

  const { data } = await supabase.storage.from('receipts').createSignedUrl(path, 3600)

  unwrap(
    await supabase.from('expenses').update({ receipt_url: path }).eq('id', expenseId),
    'receipt link',
  )

  return { path, signedUrl: data?.signedUrl }
}

/** Everything the expense page needs, fetched in parallel. */
export async function getExpensePageData(organizationId, options = {}) {
  const [stats, breakdown, rows] = await Promise.all([
    getExpenseStats(organizationId),
    getExpenseBreakdown(organizationId),
    listExpenses(organizationId, options),
  ])
  return { stats, breakdown, rows }
}
