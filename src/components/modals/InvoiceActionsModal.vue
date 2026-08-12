<script setup>
import { computed, ref, watch } from 'vue'
import { Ban, Banknote, Lock, Pencil, Send, Trash2 } from 'lucide-vue-next'
import BaseModal from './BaseModal.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import NewInvoiceModal from './NewInvoiceModal.vue'
import RecordPaymentModal from './RecordPaymentModal.vue'
import StatusPill from '../portal/StatusPill.vue'
import { useFormSubmit } from '../../composables/useFormSubmit'
import {
  deleteInvoice,
  isInvoiceEditable,
  updateInvoiceStatus,
} from '../../services/invoiceService'

/**
 * What you can do to one invoice from its row.
 *
 * `invoice` is the display row the table already holds, so opening this costs
 * no extra query — only the payment and edit dialogs need the full record, and
 * they fetch it themselves.
 */
const props = defineProps({
  invoice: { type: Object, default: null },
})

const open = defineModel('open', { type: Boolean, default: false })
const emit = defineEmits(['changed'])

const { submitting, error, submit, reset } = useFormSubmit()

const showPayment = ref(false)
const showEdit = ref(false)
const showDelete = ref(false)

// The raw enum, not the label — "Cancelled" on screen is `void` in the column.
const status = computed(() => props.invoice?.statusValue ?? '')
const isSettled = computed(() => status.value === 'paid' || status.value === 'void')

/**
 * A settled invoice is closed to changes of every kind — not editable, not
 * voidable, and not deletable either. Deleting is stronger than voiding, so
 * offering it on a paid invoice while refusing to void one would be the wrong
 * way round.
 *
 * A part-paid invoice is still open, so it can be voided or deleted, but its
 * figures are locked: money has already been received against them.
 */
const canChange = computed(() => !isSettled.value)
const canEdit = computed(() => isInvoiceEditable(props.invoice))
const partPaid = computed(
  () => !isSettled.value && Number(props.invoice?.amountPaid ?? 0) > 0,
)

/** Why the destructive actions are missing, in the words of this invoice. */
const lockReason = computed(() => {
  if (status.value === 'paid') {
    return 'This invoice has been paid, so it can no longer be edited, cancelled or deleted.'
  }
  if (status.value === 'void') {
    return 'This invoice has been cancelled. It stays in the ledger as a record.'
  }
  if (partPaid.value) {
    return `${props.invoice?.balanceDue} is still outstanding, but a payment has already been recorded — the amounts can no longer be edited.`
  }
  return ''
})

watch(open, (isOpen) => {
  if (isOpen) reset()
})

async function setStatus(next) {
  const updated = await submit(() => updateInvoiceStatus(props.invoice.id, next))
  if (updated) {
    open.value = false
    emit('changed', updated)
  }
}

function onPaymentRecorded(updated) {
  open.value = false
  emit('changed', updated)
}

function onEdited(updated) {
  open.value = false
  emit('changed', updated)
}

function onDeleted() {
  open.value = false
  emit('changed', null)
}
</script>

<template>
  <BaseModal
    v-model:open="open"
    :title="invoice ? `Invoice ${invoice.number}` : 'Invoice'"
    :subtitle="invoice ? `${invoice.client} · issued ${invoice.issued}` : ''"
    size="sm"
    :busy="submitting"
  >
    <template v-if="invoice">
      <dl class="grid grid-cols-2 gap-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
        <div>
          <dt class="text-xs text-slate-500">Amount</dt>
          <dd class="mt-1 text-sm font-semibold text-ink tabular-nums">{{ invoice.amount }}</dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500">Balance due</dt>
          <dd class="mt-1 text-sm font-semibold text-ink tabular-nums">{{ invoice.balanceDue }}</dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500">Due date</dt>
          <dd class="mt-1 text-sm text-slate-600">{{ invoice.due }}</dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500">Status</dt>
          <dd class="mt-1"><StatusPill :status="invoice.status" /></dd>
        </div>
        <div class="col-span-2">
          <dt class="text-xs text-slate-500">
            {{ isSettled ? 'Paid by' : 'Payment method' }}
          </dt>
          <dd class="mt-1 text-sm text-slate-600">{{ invoice.paymentMethod }}</dd>
        </div>
      </dl>

      <ul class="mt-5 space-y-1.5">
        <li v-if="canEdit">
          <button
            type="button"
            :disabled="submitting"
            class="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium text-ink transition hover:bg-slate-100 disabled:opacity-50"
            @click="showEdit = true"
          >
            <Pencil class="size-4 text-slate-400" />
            Edit invoice
          </button>
        </li>
        <li v-if="status === 'draft'">
          <button
            type="button"
            :disabled="submitting"
            class="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium text-ink transition hover:bg-slate-100 disabled:opacity-50"
            @click="setStatus('sent')"
          >
            <Send class="size-4 text-slate-400" />
            Mark as sent
          </button>
        </li>
        <li v-if="canChange">
          <button
            type="button"
            :disabled="submitting"
            class="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium text-ink transition hover:bg-slate-100 disabled:opacity-50"
            @click="showPayment = true"
          >
            <Banknote class="size-4 text-slate-400" />
            Record a payment
          </button>
        </li>
        <li v-if="canChange">
          <button
            type="button"
            :disabled="submitting"
            class="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium text-ink transition hover:bg-slate-100 disabled:opacity-50"
            @click="setStatus('void')"
          >
            <Ban class="size-4 text-slate-400" />
            Cancel this invoice
          </button>
        </li>
        <li v-if="canChange">
          <button
            type="button"
            :disabled="submitting"
            class="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
            @click="showDelete = true"
          >
            <Trash2 class="size-4" />
            Delete permanently
          </button>
        </li>
      </ul>

      <p
        v-if="lockReason"
        class="mt-4 flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 text-xs leading-relaxed text-slate-500"
      >
        <Lock class="mt-px size-3.5 shrink-0 text-slate-400" />
        {{ lockReason }}
      </p>

      <p v-if="error" class="mt-4 text-sm text-red-600" role="alert">{{ error.message }}</p>

      <NewInvoiceModal
        v-model:open="showEdit"
        :invoice-id="invoice.id"
        @updated="onEdited"
      />

      <RecordPaymentModal
        v-model:open="showPayment"
        :invoice-id="invoice.id"
        @recorded="onPaymentRecorded"
      />

      <ConfirmDialog
        v-model:open="showDelete"
        title="Delete this invoice?"
        :message="`${invoice.number} and its line items will be removed. Cancelling it instead keeps the record in your ledger.`"
        confirm-label="Delete invoice"
        tone="danger"
        :action="() => deleteInvoice(invoice.id)"
        @confirmed="onDeleted"
      />
    </template>
  </BaseModal>
</template>
