import { supabase } from '../lib/supabaseClient'
import { formatCurrency, formatDate, formatStatus } from '../utils/format'
import { escapeFilterValue, pageRange, unwrap, unwrapWithCount } from './helpers'
import { formatPaymentMethod } from './paymentMethods'
import { createTransaction, deleteTransaction } from './transactionService'

/** Queries behind /portal/invoices. */

/** UI filter label → database enum value. 'All' means no status filter. */
const STATUS_BY_LABEL = {
  Draft: 'draft',
  Sent: 'sent',
  Paid: 'paid',
  Overdue: 'overdue',
  Cancelled: 'void',
}

/**
 * Display label per status. Only `void` needs one: the enum says "void" because
 * that is the accounting word, but every button in the UI offers to *cancel* an
 * invoice, and a table that then labels the result "Void" reads as a different
 * outcome from the one that was chosen.
 */
const STATUS_LABELS = { void: 'Cancelled' }

function invoiceStatusLabel(status) {
  return STATUS_LABELS[status] ?? formatStatus(status)
}

export async function getInvoiceStats(organizationId) {
  const row = unwrap(
    await supabase.rpc('invoice_stats', { org: organizationId }).single(),
    'invoice stats',
  )

  return {
    outstanding: formatCurrency(row.outstanding),
    unpaidCount: row.unpaid_count,
    overdue: formatCurrency(row.overdue),
    overdueCount: row.overdue_count,
    paidThisMonth: formatCurrency(row.paid_this_month),
    paidCount: row.paid_count,
    avgDaysToPay: row.avg_days_to_pay == null ? '—' : `${row.avg_days_to_pay} days`,
  }
}

/**
 * Paginated invoice table.
 *
 * Search covers the invoice number and the client name. The client name lives
 * on a joined table, so it needs its own filter rather than an `or()` — the
 * embedded-resource syntax cannot be mixed into a top-level `or`.
 */
export async function listInvoices(organizationId, {
  filter = 'All',
  search = '',
  page = 0,
  pageSize = 20,
} = {}) {
  const [from, to] = pageRange(page, pageSize)

  let query = supabase
    .from('invoices')
    .select(
      'id, number, status, issue_date, due_date, total, amount_paid, balance_due, payment_method, clients!inner(id, name, email)',
      { count: 'exact' },
    )
    .eq('organization_id', organizationId)
    .order('issue_date', { ascending: false })
    .range(from, to)

  const status = STATUS_BY_LABEL[filter]
  if (status) query = query.eq('status', status)

  const term = escapeFilterValue(search)
  if (term) {
    // Two passes would be needed to OR across the join, so match the number
    // first and fall back to the client name when it finds nothing.
    query = query.or(`number.ilike.%${term}%`)
  }

  const { data, count } = unwrapWithCount(await query, 'invoice list')

  let rows = data

  // Second pass: if a number search found nothing, try the client name.
  if (term && !rows.length) {
    const byClient = unwrapWithCount(
      await supabase
        .from('invoices')
        .select(
          'id, number, status, issue_date, due_date, total, amount_paid, balance_due, payment_method, clients!inner(id, name, email)',
          { count: 'exact' },
        )
        .eq('organization_id', organizationId)
        .ilike('clients.name', `%${term}%`)
        .order('issue_date', { ascending: false })
        .range(from, to),
      'invoice list',
    )
    rows = byClient.data
    return { rows: rows.map(toInvoiceRow), total: byClient.count || rows.length }
  }

  return { rows: rows.map(toInvoiceRow), total: count || rows.length }
}

function toInvoiceRow(row) {
  return {
    id: row.id,
    number: row.number,
    client: row.clients?.name ?? 'Unknown client',
    email: row.clients?.email ?? '',
    issued: formatDate(row.issue_date),
    due: formatDate(row.due_date),
    amount: formatCurrency(row.total, { decimals: true }),
    balanceDue: formatCurrency(row.balance_due, { decimals: true }),
    status: invoiceStatusLabel(row.status),
    // The raw enum as well. Deciding what a row may do from the *label* would
    // break the moment a label changed — as "Void" → "Cancelled" just did.
    statusValue: row.status,
    // Both forms: the label for the table, the raw enum for the payment dialog
    // to preselect from.
    paymentMethod: formatPaymentMethod(row.payment_method),
    paymentMethodValue: row.payment_method ?? '',
    // Raw, because what the row actions need to know is whether any money has
    // landed at all — a formatted "₵0.00" cannot answer that.
    amountPaid: Number(row.amount_paid ?? 0),
  }
}

/** Full invoice with its line items, for a detail view or PDF export. */
export async function getInvoice(invoiceId) {
  return unwrap(
    await supabase
      .from('invoices')
      .select(
        `
        *,
        clients (id, name, email, address, payment_terms),
        invoice_items (id, description, quantity, unit_price, tax_rate, line_total, position)
      `,
      )
      .eq('id', invoiceId)
      .order('position', { referencedTable: 'invoice_items', ascending: true })
      .single(),
    'invoice lookup',
  )
}

/**
 * Create an invoice and its lines. Totals are not passed — the
 * `invoice_items_recalc` trigger computes subtotal, tax and total from the
 * lines, so there is exactly one place that arithmetic can be wrong.
 */
export async function createInvoice(organizationId, {
  clientId,
  number,
  issueDate,
  dueDate,
  notes,
  currency = 'GHS',
  status = 'draft',
  paymentMethod = null,
  createdBy = null,
  lines = [],
}) {
  const invoice = unwrap(
    await supabase
      .from('invoices')
      .insert({
        organization_id: organizationId,
        client_id: clientId,
        number,
        issue_date: issueDate,
        due_date: dueDate,
        notes: notes || null,
        currency,
        status,
        // How the client is asked to pay. Empty means the invoice does not say,
        // which is a real answer and not the same as any particular method.
        payment_method: paymentMethod || null,
        // Raising an invoice straight to "sent" still has to stamp the date the
        // overdue job (§6.5) and the stats RPC read from.
        sent_at: status === 'sent' ? new Date().toISOString() : null,
        created_by: createdBy,
      })
      .select()
      .single(),
    'invoice creation',
  )

  if (lines.length) {
    unwrap(
      await supabase.from('invoice_items').insert(
        lines.map((line, index) => ({
          invoice_id: invoice.id,
          description: line.description,
          quantity: line.quantity ?? 1,
          unit_price: line.unitPrice ?? 0,
          tax_rate: line.taxRate ?? 15, // Ghana standard VAT
          stream: line.stream || null,
          position: index,
        })),
      ),
      'invoice line creation',
    )
  }

  return invoice
}

/**
 * Edit an invoice that has not been settled or part-paid.
 *
 * The caller is responsible for not offering this on a paid invoice — see
 * `isInvoiceEditable`. It matters beyond tidiness: the lines are replaced
 * wholesale, and `invoices_paid_within_total` would reject the moment the
 * recalculated total dropped below what had already been received.
 *
 * The new lines go in *before* the old ones come out. Both orders have a
 * failure mode, and this is the survivable one: a failure part-way leaves the
 * original lines intact with duplicates beside them, which is visible and
 * fixable. Deleting first and failing on the insert would leave an invoice with
 * no lines and a total of zero.
 *
 * Totals are never sent. The `invoice_items_recalc` trigger (§6.2) fires on
 * insert *and* delete and recomputes from whatever rows remain, so it settles
 * on the right figure once the swap is done.
 */
export async function updateInvoice(invoiceId, {
  clientId,
  number,
  issueDate,
  dueDate,
  notes,
  paymentMethod = null,
  status = null,
  stampSent = false,
  lines = null,
}) {
  const patch = {
    client_id: clientId,
    number,
    issue_date: issueDate,
    due_date: dueDate,
    notes: notes || null,
    payment_method: paymentMethod || null,
  }

  if (status) patch.status = status
  // Only a genuine draft → sent transition stamps the date. Pushing an overdue
  // invoice back to sent is a correction, not a re-send, and re-stamping it
  // would quietly shorten every "days to pay" figure that reads from it.
  if (stampSent) patch.sent_at = new Date().toISOString()

  const invoice = unwrap(
    await supabase.from('invoices').update(patch).eq('id', invoiceId).select().single(),
    'invoice update',
  )

  // `null` means "leave the lines alone"; an empty array would mean "remove
  // them all", which is a different instruction.
  if (lines) {
    const existing =
      unwrap(
        await supabase.from('invoice_items').select('id').eq('invoice_id', invoiceId),
        'invoice line lookup',
      ) ?? []

    await addInvoiceItems(invoiceId, lines)

    if (existing.length) {
      unwrap(
        await supabase
          .from('invoice_items')
          .delete()
          .in(
            'id',
            existing.map((row) => row.id),
          ),
        'invoice line replacement',
      )
    }
  }

  return invoice
}

/**
 * Whether an invoice may still be edited, voided or deleted.
 *
 * Two separate reasons to say no. A paid or voided invoice is a record of
 * something that happened, and records do not get rewritten. A part-paid one is
 * still open, but money has already been received against these figures —
 * changing them would leave the payment describing an invoice that no longer
 * exists.
 */
export function isInvoiceEditable(invoice) {
  if (!invoice) return false
  const status = invoice.statusValue ?? String(invoice.status ?? '').toLowerCase()
  if (status === 'paid' || status === 'void') return false
  return Number(invoice.amountPaid ?? 0) <= 0
}

/**
 * Append lines to an existing invoice. Totals are left alone here too — the
 * `invoice_items_recalc` trigger fires on the insert and updates them.
 */
export async function addInvoiceItems(invoiceId, lines, startPosition = 0) {
  if (!lines.length) return []

  return unwrap(
    await supabase
      .from('invoice_items')
      .insert(
        lines.map((line, index) => ({
          invoice_id: invoiceId,
          description: line.description,
          quantity: line.quantity ?? 1,
          unit_price: line.unitPrice ?? 0,
          tax_rate: line.taxRate ?? 15,
          stream: line.stream || null,
          position: startPosition + index,
        })),
      )
      .select(),
    'invoice line creation',
  )
}

export async function updateInvoiceStatus(invoiceId, status) {
  const patch = { status }
  if (status === 'sent') patch.sent_at = new Date().toISOString()
  if (status === 'paid') patch.paid_at = new Date().toISOString()

  return unwrap(
    await supabase.from('invoices').update(patch).eq('id', invoiceId).select().single(),
    'invoice update',
  )
}

/**
 * A `date` input gives a day, `paid_at` wants an instant.
 *
 * Today keeps the real clock time. Any other day lands at midday, so no
 * timezone offset can shift a payment onto the day before the one that was
 * picked — which is exactly the kind of error that only shows up in a month-end
 * report.
 */
function dayToTimestamp(day) {
  if (!day) return new Date().toISOString()
  const today = new Date().toISOString().slice(0, 10)
  if (day === today) return new Date().toISOString()
  return new Date(`${day}T12:00:00`).toISOString()
}

/**
 * Record a payment. `amount_paid` drives the generated `balance_due` column.
 *
 * `paidOn` is the day the money actually arrived, which is not always today —
 * payments get entered late, and the date on the record should be the one that
 * happened.
 *
 * `method` overwrites the one chosen when the invoice was raised. That field
 * starts out as how the client was *asked* to pay and ends up as how they
 * actually did, because once the money is in, the second is the only one worth
 * keeping.
 */
export async function recordInvoicePayment(
  invoiceId,
  amountPaid,
  { markPaid = true, paidOn = null, method = null } = {},
) {
  const patch = { amount_paid: amountPaid }
  if (markPaid) {
    patch.status = 'paid'
    patch.paid_at = dayToTimestamp(paidOn)
  }
  if (method) patch.payment_method = method

  return unwrap(
    await supabase.from('invoices').update(patch).eq('id', invoiceId).select().single(),
    'payment record',
  )
}

/**
 * Record a payment *and* the money arriving in an account, linked.
 *
 * `transactions.invoice_id` is the seam: the invoice says what is owed, the
 * transaction says the cash turned up, and pointing one at the other is what
 * stops the two being independent guesses at the same event. A bank line that
 * does not say how the money came in is half a record, so the method goes on
 * both — the invoice keeps the fact, the transaction keeps it in the ledger.
 *
 * The transaction is written first. If the invoice update then fails it is
 * removed again, because a bank line for a payment the invoice never recorded
 * would overstate the account and understate what is still owed.
 */
export async function recordInvoicePaymentWithTransaction(
  organizationId,
  invoiceId,
  amountPaid,
  {
    markPaid = true,
    paidOn = null,
    method = null,
    payment,
    accountId,
    methodLabel = '',
    invoiceNumber = '',
    currency = 'GHS',
  },
) {
  const created = await createTransaction(organizationId, {
    accountId,
    invoiceId,
    occurredOn: paidOn,
    description: methodLabel
      ? `Payment received — ${invoiceNumber} (${methodLabel})`
      : `Payment received — ${invoiceNumber}`,
    // Money in is positive — the sign is what makes `sum(amount)` mean anything.
    amount: Math.abs(Number(payment)),
    currency,
    status: 'cleared',
  })

  try {
    return await recordInvoicePayment(invoiceId, amountPaid, { markPaid, paidOn, method })
  } catch (caught) {
    try {
      await deleteTransaction(created.id)
    } catch {
      throw new Error(
        `The bank transaction was recorded, but the invoice could not be updated (${caught.message}). Remove that transaction from the transactions page, or the account balance will be wrong.`,
      )
    }
    throw caught
  }
}

export async function deleteInvoice(invoiceId) {
  return unwrap(
    await supabase.from('invoices').delete().eq('id', invoiceId),
    'invoice delete',
  )
}

/** Next number in sequence, e.g. INV-2206. Used to prefill the new-invoice form. */
export async function getNextInvoiceNumber(organizationId, prefix = 'INV-') {
  const rows =
    unwrap(
      await supabase
        .from('invoices')
        .select('number')
        .eq('organization_id', organizationId)
        .like('number', `${prefix}%`)
        .order('number', { ascending: false })
        .limit(1),
      'invoice numbering',
    ) ?? []

  const last = rows[0]?.number
  const sequence = last ? Number(last.replace(prefix, '')) : 2200
  return `${prefix}${Number.isFinite(sequence) ? sequence + 1 : 2201}`
}

/* ------------------------------------------------------------------ clients */

export async function listClients(organizationId) {
  const rows =
    unwrap(
      await supabase
        .from('clients')
        .select('id, name, email, phone, payment_terms')
        .eq('organization_id', organizationId)
        .is('archived_at', null)
        .order('name'),
      'client list',
    ) ?? []
  return rows
}

export async function updateClient(clientId, client) {
  return unwrap(
    await supabase
      .from('clients')
      .update({
        name: client.name,
        email: client.email || null,
        phone: client.phone || null,
        address: client.address || null,
        payment_terms: client.paymentTerms ?? 14,
      })
      .eq('id', clientId)
      .select()
      .single(),
    'client update',
  )
}

export async function createClient(organizationId, client) {
  return unwrap(
    await supabase
      .from('clients')
      .insert({
        organization_id: organizationId,
        name: client.name,
        email: client.email || null,
        phone: client.phone || null,
        address: client.address || null,
        payment_terms: client.paymentTerms ?? 14,
      })
      .select()
      .single(),
    'client creation',
  )
}
