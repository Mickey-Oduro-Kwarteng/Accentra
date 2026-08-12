<script setup>
import { computed, ref, watch } from 'vue'
import BaseModal from './BaseModal.vue'
import FormField from '../ui/FormField.vue'
import SelectField from '../ui/SelectField.vue'
import { useFormSubmit } from '../../composables/useFormSubmit'
import { useOrganization } from '../../composables/useOrganization'
import { listAccounts } from '../../services/accountService'
import { INVOICE_PAYMENT_METHODS } from '../../services/paymentMethods'
import {
  getInvoice,
  recordInvoicePayment,
  recordInvoicePaymentWithTransaction,
} from '../../services/invoiceService'
import { canWrite } from '../../services/organizationService'
import { formatCurrency, formatDate } from '../../utils/format'

/**
 * Settles an invoice by writing `amount_paid` (§3.6).
 *
 * `balance_due` is a generated column, so it is never sent — Postgres derives
 * it from `total - amount_paid` the moment this saves.
 *
 * How and when the money came in are collected here too. The method overwrites
 * the one the invoice was raised with — asked-for becomes actually-paid — and
 * the date sets `paid_at`. Recording the bank side puts both on the linked
 * money-in transaction as well, where the ledger can see them.
 */
const props = defineProps({
  invoiceId: { type: String, default: '' },
})

const open = defineModel('open', { type: Boolean, default: false })
const emit = defineEmits(['recorded'])

const { ensureOrganization, organization, role } = useOrganization()
const { submitting, error, submit, reset } = useFormSubmit()

const today = () => new Date().toISOString().slice(0, 10)

const invoice = ref(null)
const loading = ref(false)
const accounts = ref([])

const amount = ref('')
const method = ref('bank_transfer')
const paidOn = ref(today())
const accountId = ref('')
const recordTransaction = ref(false)

const amountError = ref('')
const dateError = ref('')
const accountError = ref('')

const total = computed(() => Number(invoice.value?.total ?? 0))
const alreadyPaid = computed(() => Number(invoice.value?.amount_paid ?? 0))
const outstanding = computed(() => total.value - alreadyPaid.value)

// The new running total, not just this payment — `amount_paid` is cumulative.
const newAmountPaid = computed(() => alreadyPaid.value + (Number(amount.value) || 0))
const settlesInFull = computed(() => newAmountPaid.value >= total.value - 0.005)

const currency = computed(
  () => invoice.value?.currency ?? organization.value?.base_currency ?? 'GHS',
)

/**
 * Writing to `transactions` needs a bookkeeper role, and an account to write
 * against. Offering it to someone RLS will reject, or with nothing to pick,
 * would only fail the save for a reason they cannot act on.
 */
const canRecordTransaction = computed(() => canWrite(role.value) && accounts.value.length > 0)

const methodLabel = computed(
  () => INVOICE_PAYMENT_METHODS.find((entry) => entry.value === method.value)?.label ?? '',
)

const accountOptions = computed(() =>
  accounts.value.map((row) => ({
    value: row.id,
    label: row.institution ? `${row.name} — ${row.institution}` : row.name,
  })),
)

watch(open, async (isOpen) => {
  if (!isOpen || !props.invoiceId) return

  invoice.value = null
  accounts.value = []
  amount.value = ''
  method.value = 'bank_transfer'
  paidOn.value = today()
  accountId.value = ''
  recordTransaction.value = false
  amountError.value = ''
  dateError.value = ''
  accountError.value = ''
  reset()

  loading.value = true
  try {
    const orgId = await ensureOrganization()
    const [loadedInvoice, loadedAccounts] = await Promise.all([
      getInvoice(props.invoiceId),
      listAccounts(orgId),
    ])

    invoice.value = loadedInvoice
    accounts.value = loadedAccounts
    // Paying the balance is the common case, so start there.
    amount.value = String(Number(loadedInvoice.balance_due ?? 0))
    // Start from how the invoice asked to be paid. Usually that is how they
    // paid, and when it is not, changing it here is the correction.
    if (loadedInvoice.payment_method) method.value = loadedInvoice.payment_method
    // Money arriving is a real bank movement, so default to recording it for
    // anyone who may.
    recordTransaction.value = canRecordTransaction.value
    if (loadedAccounts.length === 1) accountId.value = loadedAccounts[0].id
  } catch (caught) {
    error.value = caught
  } finally {
    loading.value = false
  }
})

const willRecordTransaction = computed(
  () => recordTransaction.value && canRecordTransaction.value,
)

/**
 * The method is saved on the invoice either way, replacing whatever it was
 * raised with. Recording the bank side puts it on the transaction as well.
 */
const methodHint = computed(() =>
  willRecordTransaction.value
    ? 'Saved on the invoice and on the matching bank transaction.'
    : 'Replaces the method the invoice was raised with.',
)

function validate() {
  const value = Number(amount.value)

  if (!(value > 0)) {
    amountError.value = 'Enter an amount greater than zero.'
  } else if (newAmountPaid.value > total.value + 0.005) {
    // Mirrors the `invoices_paid_within_total` check constraint.
    amountError.value = `That is more than the ${formatCurrency(outstanding.value, {
      decimals: true,
    })} outstanding.`
  } else {
    amountError.value = ''
  }

  dateError.value = paidOn.value ? '' : 'Pick the date the money came in.'

  // `transactions.account_id` is not nullable, so the bank side needs one.
  accountError.value =
    willRecordTransaction.value && !accountId.value
      ? 'Choose the account the money arrived in.'
      : ''

  return !amountError.value && !dateError.value && !accountError.value
}

async function onSubmit() {
  if (!validate()) return

  const updated = await submit(async () => {
    const options = {
      // A part payment leaves the invoice where it is; only a full settlement
      // flips it to paid.
      markPaid: settlesInFull.value,
      paidOn: paidOn.value,
      method: method.value,
    }

    if (!willRecordTransaction.value) {
      return recordInvoicePayment(props.invoiceId, newAmountPaid.value, options)
    }

    return recordInvoicePaymentWithTransaction(
      await ensureOrganization(),
      props.invoiceId,
      newAmountPaid.value,
      {
        ...options,
        payment: Number(amount.value),
        accountId: accountId.value,
        methodLabel: methodLabel.value,
        invoiceNumber: invoice.value?.number ?? '',
        currency: currency.value,
      },
    )
  })

  if (updated) {
    open.value = false
    emit('recorded', updated)
  }
}
</script>

<template>
  <BaseModal
    v-model:open="open"
    title="Record payment"
    :subtitle="invoice ? `${invoice.number} · due ${formatDate(invoice.due_date)}` : ''"
    size="lg"
    :busy="submitting"
  >
    <p v-if="loading" class="text-sm text-slate-500">Loading invoice…</p>

    <form v-else-if="invoice" id="record-payment-form" @submit.prevent="onSubmit">
      <dl class="grid gap-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4 sm:grid-cols-3">
        <div>
          <dt class="text-xs text-slate-500">Invoice total</dt>
          <dd class="mt-1 text-sm font-semibold text-ink tabular-nums">
            {{ formatCurrency(total, { decimals: true }) }}
          </dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500">Already paid</dt>
          <dd class="mt-1 text-sm font-semibold text-ink tabular-nums">
            {{ formatCurrency(alreadyPaid, { decimals: true }) }}
          </dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500">Outstanding</dt>
          <dd class="mt-1 text-sm font-semibold text-brand-600 tabular-nums">
            {{ formatCurrency(outstanding, { decimals: true }) }}
          </dd>
        </div>
      </dl>

      <div class="mt-5 grid gap-5 sm:grid-cols-2">
        <FormField
          v-model="amount"
          label="Payment received"
          type="number"
          min="0"
          step="0.01"
          required
          :error="amountError"
          :hint="
            amountError
              ? ''
              : settlesInFull
                ? 'Settles the invoice in full — it will be marked paid.'
                : `Leaves ${formatCurrency(total - newAmountPaid, { decimals: true })} outstanding.`
          "
        />

        <FormField
          v-model="paidOn"
          label="Date received"
          type="date"
          required
          :error="dateError"
          :hint="dateError ? '' : 'The day the money arrived, not the day you are entering it.'"
        />

        <SelectField
          v-model="method"
          label="Paid by"
          :options="INVOICE_PAYMENT_METHODS"
          required
          :hint="methodHint"
        />

        <SelectField
          v-model="accountId"
          label="Account"
          :placeholder="willRecordTransaction ? 'Choose an account' : 'Not linked to an account'"
          :options="accountOptions"
          :required="willRecordTransaction"
          :disabled="!willRecordTransaction"
          :error="accountError"
          :hint="accountError ? '' : 'Which account the money arrived in.'"
        />
      </div>

      <!--
        The invoice says what was owed; the transaction says the cash turned up.
        `transactions.invoice_id` ties them together, so the account balance and
        the outstanding figure agree instead of drifting apart.
      -->
      <label
        v-if="canRecordTransaction"
        class="mt-5 flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4"
      >
        <input
          v-model="recordTransaction"
          type="checkbox"
          class="mt-0.5 size-4.5 rounded border-slate-300 text-brand-600 focus:ring-4 focus:ring-brand-100"
        />
        <span class="text-sm">
          <span class="block font-medium text-ink">This money has arrived in an account</span>
          <span class="block text-slate-500">
            Records the matching money-in transaction, dated
            {{ formatDate(paidOn) }} and linked to this invoice.
          </span>
        </span>
      </label>

      <p v-else class="mt-5 text-xs text-slate-500">
        {{
          accounts.length
            ? 'Recording the bank side needs a bookkeeper role, so only the invoice is updated here.'
            : 'Add an account on the transactions page to record the bank side of a payment.'
        }}
      </p>

      <p v-if="error" class="mt-4 text-sm text-red-600" role="alert">{{ error.message }}</p>
    </form>

    <template #footer="{ close }">
      <button
        type="button"
        :disabled="submitting"
        class="rounded-xl px-5 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"
        @click="close"
      >
        Cancel
      </button>
      <button
        type="submit"
        form="record-payment-form"
        :disabled="submitting || loading || !invoice"
        class="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {{ submitting ? 'Recording…' : 'Record payment' }}
      </button>
    </template>
  </BaseModal>
</template>
