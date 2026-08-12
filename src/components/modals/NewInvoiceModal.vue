<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'
import BaseModal from './BaseModal.vue'
import NewClientModal from './NewClientModal.vue'
import FormField from '../ui/FormField.vue'
import SelectField from '../ui/SelectField.vue'
import TextareaField from '../ui/TextareaField.vue'
import { useAuth } from '../../composables/useAuth'
import { useFormSubmit } from '../../composables/useFormSubmit'
import { useOrganization } from '../../composables/useOrganization'
import {
  createInvoice,
  getInvoice,
  getNextInvoiceNumber,
  listClients,
  updateInvoice,
} from '../../services/invoiceService'
import { INVOICE_PAYMENT_METHODS } from '../../services/paymentMethods'
import { formatCurrency } from '../../utils/format'

/**
 * Raises an invoice (§3.6) and its lines (§3.7), or edits one still open.
 *
 * The totals shown here are a preview only — nothing computed in this file is
 * sent. `recalc_invoice_totals` (§6.2) fires on the line insert and writes
 * subtotal, tax and total itself, so there is exactly one place the arithmetic
 * can be wrong, and it is not this one.
 *
 * Pass `invoiceId` to edit. Whether an invoice *may* be edited is decided by
 * `isInvoiceEditable` where the actions are offered — by the time this opens,
 * that question has been answered.
 */
const props = defineProps({
  invoiceId: { type: String, default: '' },
})

const open = defineModel('open', { type: Boolean, default: false })
const emit = defineEmits(['created', 'updated'])

const isEdit = computed(() => Boolean(props.invoiceId))

const { user } = useAuth()
const { ensureOrganization, organization } = useOrganization()
const { submitting, error, submit, reset } = useFormSubmit()

const DEFAULT_VAT = 15 // Ghana standard rate

const today = () => new Date().toISOString().slice(0, 10)
const emptyLine = () => ({
  description: '',
  quantity: 1,
  unitPrice: '',
  taxRate: DEFAULT_VAT,
  stream: '',
})

const form = reactive({
  clientId: '',
  number: '',
  issueDate: today(),
  dueDate: '',
  // Bank transfer is what most invoices ask for; anything else is a deliberate
  // choice, and "not specified" stays available for the ones that do not say.
  paymentMethod: 'bank_transfer',
  notes: '',
})

const lines = ref([emptyLine()])
const clients = ref([])
const clientsLoading = ref(false)
const clientsError = ref(null)
const loading = ref(false)
// Drives the footer: a draft can still be sent from here, an invoice already
// sent has nowhere further to go.
const currentStatus = ref('draft')
const showNewClient = ref(false)
const fieldErrors = reactive({ clientId: '', number: '', dueDate: '', lines: '' })

const currency = computed(() => organization.value?.base_currency ?? 'GHS')

const clientOptions = computed(() =>
  clients.value.map((row) => ({ value: row.id, label: row.name })),
)

/**
 * An empty dropdown means nothing on its own — no clients yet and a failed
 * lookup look identical in a `<select>`. Say which, on the field itself.
 */
const clientPlaceholder = computed(() => {
  if (clientsLoading.value) return 'Loading clients…'
  if (clientsError.value) return 'Could not load clients'
  if (!clientOptions.value.length) return 'No clients yet'
  return 'Choose a client'
})

const clientHint = computed(() => {
  if (fieldErrors.clientId || clientsError.value) return ''
  if (clientsLoading.value) return 'Loading your clients…'
  if (!clientOptions.value.length) return 'Add one with New client above.'
  return ''
})

/**
 * Quantities are whole units. The column is `numeric(12,3)` so fractions would
 * store, but nothing here is sold by the third of a unit, and a stray decimal
 * only ever showed up as a total nobody could reproduce. One place decides, and
 * the preview, the save and the input step all read from it.
 */
function quantityOf(line) {
  const value = Math.trunc(Number(line.quantity))
  return Number.isFinite(value) && value > 0 ? value : 1
}

/* Preview of what the trigger will write, so nobody has to save to see it. */
const totals = computed(() => {
  let subtotal = 0
  let tax = 0

  for (const line of lines.value) {
    const lineTotal = quantityOf(line) * (Number(line.unitPrice) || 0)
    subtotal += lineTotal
    tax += (lineTotal * (Number(line.taxRate) || 0)) / 100
  }

  return { subtotal, tax, total: subtotal + tax }
})

const hasUsableLine = computed(() =>
  lines.value.some((line) => line.description.trim() && Number(line.unitPrice) > 0),
)

/**
 * The client list and the next invoice number are independent lookups, and are
 * loaded independently on purpose. Sharing one `Promise.all` meant a failure
 * numbering the invoice — a convenience — rejected before the clients were
 * assigned, and the only symptom was an empty client dropdown.
 */
async function loadReferenceData() {
  const orgId = await ensureOrganization()

  clientsLoading.value = true
  clientsError.value = null

  const loadClients = listClients(orgId)
    .then((rows) => {
      clients.value = rows
    })
    .catch((caught) => {
      clientsError.value = caught
      clients.value = []
    })
    .finally(() => {
      clientsLoading.value = false
    })

  // A number that could not be prefilled is typed by hand, so this failure is
  // not worth stopping the form for. On an edit there is nothing to prefill —
  // the invoice already has its number.
  const loadNumber = isEdit.value
    ? Promise.resolve()
    : getNextInvoiceNumber(orgId)
        .then((next) => {
          form.number = next
        })
        .catch(() => {})

  await Promise.all([loadClients, loadNumber])
}

/** Fill the form from the stored invoice, lines and all. */
async function loadInvoice() {
  const row = await getInvoice(props.invoiceId)

  currentStatus.value = row.status ?? 'draft'

  Object.assign(form, {
    clientId: row.client_id ?? '',
    number: row.number ?? '',
    issueDate: row.issue_date ?? today(),
    dueDate: row.due_date ?? '',
    paymentMethod: row.payment_method ?? '',
    notes: row.notes ?? '',
  })

  // The due date came from the record, so the terms watcher must not treat it
  // as its own to overwrite.
  autoFilled = ''

  const items = [...(row.invoice_items ?? [])].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  )
  lines.value = items.length
    ? items.map((item) => ({
        description: item.description ?? '',
        quantity: Number(item.quantity) || 1,
        unitPrice: String(item.unit_price ?? ''),
        taxRate: Number(item.tax_rate) || 0,
        stream: item.stream ?? '',
      }))
    : [emptyLine()]
}

watch(open, async (isOpen) => {
  if (!isOpen) return

  Object.assign(form, {
    clientId: '',
    number: '',
    issueDate: today(),
    dueDate: '',
    paymentMethod: 'bank_transfer',
    notes: '',
  })
  Object.assign(fieldErrors, { clientId: '', number: '', dueDate: '', lines: '' })
  lines.value = [emptyLine()]
  clients.value = []
  clientsError.value = null
  currentStatus.value = 'draft'
  autoFilled = ''
  reset()

  loading.value = true
  try {
    // The clients have to be in place before the invoice fills the field, or
    // the select would hold an id with no option to match it.
    await loadReferenceData()
    if (isEdit.value) await loadInvoice()
  } catch (caught) {
    error.value = caught
  } finally {
    loading.value = false
  }
})

/**
 * Default the due date from the client's payment terms whenever either half of
 * that sum changes.
 *
 * `autoFilled` remembers what this last wrote, which is how a date the user
 * typed survives: if the field holds anything other than our own last value,
 * it was set by hand and is left alone.
 */
let autoFilled = ''

watch(
  () => [form.clientId, form.issueDate],
  () => {
    if (!form.clientId || !form.issueDate) return
    if (form.dueDate && form.dueDate !== autoFilled) return

    const client = clients.value.find((row) => row.id === form.clientId)
    const due = new Date(form.issueDate)
    due.setDate(due.getDate() + (client?.payment_terms ?? 14))

    autoFilled = due.toISOString().slice(0, 10)
    form.dueDate = autoFilled
  },
)

function onClientCreated(client) {
  clients.value = [...clients.value, client].sort((a, b) => a.name.localeCompare(b.name))
  // The list clearly reads now, whatever went wrong loading it a moment ago.
  clientsError.value = null
  form.clientId = client.id
}

function addLine() {
  lines.value.push(emptyLine())
}

function removeLine(index) {
  lines.value.splice(index, 1)
  if (!lines.value.length) lines.value.push(emptyLine())
}

function lineTotal(line) {
  return quantityOf(line) * (Number(line.unitPrice) || 0)
}

/** Snap what was typed to the whole number that will actually be charged. */
function normaliseQuantity(line) {
  line.quantity = quantityOf(line)
}

function validate() {
  fieldErrors.clientId = form.clientId ? '' : 'Choose who this is for.'
  fieldErrors.number = form.number.trim() ? '' : 'Every invoice needs a number.'

  // Mirrors the `invoices_due_after_issue` check constraint, so the database
  // never has to be the one to say no.
  if (!form.dueDate) {
    fieldErrors.dueDate = 'Pick a due date.'
  } else if (form.dueDate < form.issueDate) {
    fieldErrors.dueDate = 'The due date cannot be before the issue date.'
  } else {
    fieldErrors.dueDate = ''
  }

  fieldErrors.lines = hasUsableLine.value
    ? ''
    : 'Add at least one line with a description and a price.'

  return !Object.values(fieldErrors).some(Boolean)
}

function payloadLines() {
  return lines.value
    .filter((line) => line.description.trim())
    .map((line) => ({
      description: line.description.trim(),
      quantity: quantityOf(line),
      unitPrice: Number(line.unitPrice) || 0,
      taxRate: Number(line.taxRate) || 0,
      stream: line.stream.trim(),
    }))
}

/**
 * `status` is what to move the invoice to, or null to leave it where it is.
 * Editing an invoice does not change its status by itself — that is what the
 * "Save and mark sent" button is for, and only a draft has anywhere to go.
 */
async function save(status) {
  if (!validate()) return

  const saved = await submit(async () => {
    const common = {
      clientId: form.clientId,
      number: form.number.trim(),
      issueDate: form.issueDate,
      dueDate: form.dueDate,
      notes: form.notes.trim(),
      paymentMethod: form.paymentMethod,
      lines: payloadLines(),
    }

    if (isEdit.value) {
      // A due date pushed into the future un-overdues an invoice. Leaving it
      // late would have the overdue job (§6.5) flip it straight back anyway,
      // and the invoice would keep claiming to be late after the date it was
      // late against had been corrected.
      const unOverdue =
        currentStatus.value === 'overdue' && form.dueDate >= today() ? 'sent' : null

      return updateInvoice(props.invoiceId, {
        ...common,
        status: status ?? unOverdue,
        // Only the button says "send". The un-overdue correction reuses the
        // same status without pretending the invoice went out again today.
        stampSent: status === 'sent',
      })
    }

    return createInvoice(await ensureOrganization(), {
      ...common,
      currency: currency.value,
      status: status ?? 'draft',
      createdBy: user.value?.id ?? null,
    })
  })

  if (saved) {
    open.value = false
    emit(isEdit.value ? 'updated' : 'created', saved)
  }
}
</script>

<template>
  <BaseModal
    v-model:open="open"
    :title="isEdit ? 'Edit invoice' : 'New invoice'"
    subtitle="Totals are calculated by the database from the lines below."
    size="xl"
    :busy="submitting"
  >
    <form id="new-invoice-form" class="space-y-6" @submit.prevent="save(null)">
      <div class="grid gap-5 sm:grid-cols-2">
        <SelectField
          v-model="form.clientId"
          label="Client"
          :placeholder="clientPlaceholder"
          :options="clientOptions"
          required
          :error="fieldErrors.clientId || clientsError?.message || ''"
          :hint="clientHint"
        >
          <template #action>
            <button
              type="button"
              class="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 transition hover:text-brand-700"
              @click="showNewClient = true"
            >
              <Plus class="size-3.5" />
              New client
            </button>
          </template>
        </SelectField>

        <FormField
          v-model="form.number"
          label="Invoice number"
          placeholder="INV-2206"
          required
          :error="fieldErrors.number"
          :hint="fieldErrors.number ? '' : 'Prefilled from your last invoice.'"
        />

        <FormField v-model="form.issueDate" label="Issue date" type="date" required />
        <FormField
          v-model="form.dueDate"
          label="Due date"
          type="date"
          required
          :error="fieldErrors.dueDate"
          :hint="fieldErrors.dueDate ? '' : 'Defaults to the client’s payment terms.'"
        />

        <SelectField
          v-model="form.paymentMethod"
          label="Payment method"
          placeholder="Not specified"
          :options="INVOICE_PAYMENT_METHODS"
          hint="How you are asking to be paid. Recording the payment updates it to how they actually paid."
        />
      </div>

      <!-- Line items -->
      <section>
        <header class="flex items-center justify-between gap-3">
          <h3 class="text-sm font-semibold text-ink">Line items</h3>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-slate-50"
            @click="addLine"
          >
            <Plus class="size-3.5" />
            Add line
          </button>
        </header>

        <div class="mt-3 overflow-x-auto rounded-xl border border-slate-200">
          <table class="w-full min-w-3xl text-left">
            <thead>
              <tr class="border-b border-slate-100 bg-slate-50/70 text-xs text-slate-500">
                <th scope="col" class="px-3 py-2.5 font-medium">Description</th>
                <th scope="col" class="w-24 px-3 py-2.5 font-medium">Qty</th>
                <th scope="col" class="w-32 px-3 py-2.5 font-medium">Unit price</th>
                <th scope="col" class="w-24 px-3 py-2.5 font-medium">VAT %</th>
                <th scope="col" class="w-36 px-3 py-2.5 font-medium">Stream</th>
                <th scope="col" class="w-28 px-3 py-2.5 text-right font-medium">Total</th>
                <th scope="col" class="w-10 px-3 py-2.5"><span class="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(line, index) in lines" :key="index" class="border-b border-slate-50 last:border-0">
                <td class="px-3 py-2">
                  <input
                    v-model="line.description"
                    type="text"
                    placeholder="Monthly retainer"
                    :aria-label="`Line ${index + 1} description`"
                    class="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-ink transition placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none"
                  />
                </td>
                <td class="px-3 py-2">
                  <input
                    v-model="line.quantity"
                    type="number"
                    min="1"
                    step="1"
                    inputmode="numeric"
                    :aria-label="`Line ${index + 1} quantity`"
                    class="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-ink tabular-nums transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none"
                    @blur="normaliseQuantity(line)"
                  />
                </td>
                <td class="px-3 py-2">
                  <input
                    v-model="line.unitPrice"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    :aria-label="`Line ${index + 1} unit price`"
                    class="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-ink tabular-nums transition placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none"
                  />
                </td>
                <td class="px-3 py-2">
                  <input
                    v-model="line.taxRate"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    :aria-label="`Line ${index + 1} VAT rate`"
                    class="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-ink tabular-nums transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none"
                  />
                </td>
                <td class="px-3 py-2">
                  <input
                    v-model="line.stream"
                    type="text"
                    placeholder="Retainers"
                    :aria-label="`Line ${index + 1} revenue stream`"
                    class="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-ink transition placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none"
                  />
                </td>
                <td class="px-3 py-2 text-right text-sm font-medium text-ink tabular-nums">
                  {{ formatCurrency(lineTotal(line), { decimals: true }) }}
                </td>
                <td class="px-3 py-2 text-right">
                  <button
                    type="button"
                    class="grid size-8 place-items-center rounded-lg text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                    :aria-label="`Remove line ${index + 1}`"
                    @click="removeLine(index)"
                  >
                    <Trash2 class="size-4" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p v-if="fieldErrors.lines" class="mt-2 text-sm text-red-600" role="alert">
          {{ fieldErrors.lines }}
        </p>

        <dl class="mt-4 ml-auto grid max-w-xs gap-2 text-sm">
          <div class="flex items-baseline justify-between gap-6">
            <dt class="text-slate-500">Subtotal</dt>
            <dd class="font-medium text-ink tabular-nums">
              {{ formatCurrency(totals.subtotal, { decimals: true }) }}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-6">
            <dt class="text-slate-500">VAT</dt>
            <dd class="font-medium text-ink tabular-nums">
              {{ formatCurrency(totals.tax, { decimals: true }) }}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-6 border-t border-slate-100 pt-2">
            <dt class="font-semibold text-ink">Total</dt>
            <dd class="text-base font-semibold text-brand-600 tabular-nums">
              {{ formatCurrency(totals.total, { decimals: true }) }}
            </dd>
          </div>
        </dl>
      </section>

      <TextareaField
        v-model="form.notes"
        label="Notes"
        placeholder="Payment details, terms, thanks — anything that should appear on the invoice."
      />

      <p v-if="error" class="text-sm text-red-600" role="alert">{{ error.message }}</p>
    </form>

    <NewClientModal v-model:open="showNewClient" @created="onClientCreated" />

    <template #footer="{ close }">
      <button
        type="button"
        :disabled="submitting"
        class="mr-auto rounded-xl px-5 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"
        @click="close"
      >
        Cancel
      </button>
      <!--
        An invoice already sent has nowhere further to go from here, so it gets
        one button. A draft — new or being edited — keeps both.
      -->
      <button
        type="submit"
        form="new-invoice-form"
        :disabled="submitting || loading"
        class="rounded-xl px-5 py-2.5 text-sm font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-60"
        :class="
          isEdit && currentStatus !== 'draft'
            ? 'bg-brand-600 text-white shadow-md shadow-brand-600/20 hover:bg-brand-700'
            : 'border border-slate-200 bg-white text-ink hover:bg-slate-50'
        "
      >
        <template v-if="submitting">Saving…</template>
        <template v-else-if="isEdit">Save changes</template>
        <template v-else>Save as draft</template>
      </button>
      <button
        v-if="!isEdit || currentStatus === 'draft'"
        type="button"
        :disabled="submitting || loading"
        class="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        @click="save('sent')"
      >
        Save and mark sent
      </button>
    </template>
  </BaseModal>
</template>
