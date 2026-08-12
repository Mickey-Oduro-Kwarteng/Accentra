<script setup>
import { computed, ref, watch } from 'vue'
import { Check, Pencil, RotateCcw, Trash2, Undo2, Wallet, X } from 'lucide-vue-next'
import BaseModal from './BaseModal.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import RecordExpenseModal from './RecordExpenseModal.vue'
import StatusPill from '../portal/StatusPill.vue'
import { useAuth } from '../../composables/useAuth'
import { useFormSubmit } from '../../composables/useFormSubmit'
import { useOrganization } from '../../composables/useOrganization'
import { deleteExpense, setExpenseStatus } from '../../services/expenseService'
import { canWrite } from '../../services/organizationService'

/**
 * What you can do to one claim from its row: correct it, decide on it, or
 * remove it.
 *
 * `expense` is the display row the table already holds, so opening this costs
 * no extra query — only the edit form needs the raw record, and it fetches that
 * itself.
 */
const props = defineProps({
  expense: { type: Object, default: null },
})

const open = defineModel('open', { type: Boolean, default: false })
const emit = defineEmits(['changed'])

const { user } = useAuth()
const { role } = useOrganization()
const { submitting, error, submit, reset } = useFormSubmit()

const showEdit = ref(false)
const showDelete = ref(false)

const status = computed(() => props.expense?.statusValue ?? '')

/**
 * Who may do what, mirroring the policies in §5.8 so the dialog does not offer
 * an action the database will refuse.
 *
 * Approvers manage everything in the org. Everyone else may correct their own
 * claim, but only while it is still pending — once a decision is on it, the
 * numbers behind that decision stop being theirs to change.
 */
const isApprover = computed(() => canWrite(role.value))
const isOwnClaim = computed(() => props.expense?.submittedBy === user.value?.id)
const canEdit = computed(
  () => isApprover.value || (isOwnClaim.value && status.value === 'pending'),
)
const canDelete = computed(() => canEdit.value)

const editHint = computed(() => {
  if (canEdit.value) return ''
  if (isOwnClaim.value) return 'A claim can only be corrected while it is still pending.'
  return 'Only an approver can change someone else’s claim.'
})

watch(open, (isOpen) => {
  if (isOpen) reset()
})

async function setStatus(next) {
  const updated = await submit(() =>
    setExpenseStatus(props.expense.id, next, user.value?.id ?? null),
  )
  if (updated) {
    open.value = false
    emit('changed', updated)
  }
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
    :title="expense ? expense.vendor : 'Expense'"
    :subtitle="expense ? `${expense.category} · ${expense.date}` : ''"
    size="sm"
    :busy="submitting"
  >
    <template v-if="expense">
      <dl class="grid grid-cols-2 gap-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
        <div>
          <dt class="text-xs text-slate-500">Amount</dt>
          <dd class="mt-1 text-sm font-semibold text-ink tabular-nums">{{ expense.amount }}</dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500">Status</dt>
          <dd class="mt-1"><StatusPill :status="expense.status" /></dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500">Paid with</dt>
          <dd class="mt-1 text-sm text-slate-600">{{ expense.method }}</dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500">Submitted by</dt>
          <dd class="mt-1 text-sm text-slate-600">{{ expense.owner }}</dd>
        </div>
      </dl>

      <ul class="mt-5 space-y-1.5">
        <li>
          <button
            type="button"
            :disabled="submitting || !canEdit"
            class="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium text-ink transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            @click="showEdit = true"
          >
            <Pencil class="size-4 text-slate-400" />
            Edit details
          </button>
        </li>

        <!--
          Every status is reachable from every other one. A claim approved by
          mistake has to be able to go back, and a rejection is not a tombstone.
          Only the status it is already in is left off the list.
        -->
        <template v-if="isApprover">
          <li v-if="status !== 'approved'">
            <button
              type="button"
              :disabled="submitting"
              class="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium text-ink transition hover:bg-slate-100 disabled:opacity-50"
              @click="setStatus('approved')"
            >
              <Check class="size-4 text-emerald-500" />
              Approve
            </button>
          </li>
          <li v-if="status !== 'rejected'">
            <button
              type="button"
              :disabled="submitting"
              class="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium text-ink transition hover:bg-slate-100 disabled:opacity-50"
              @click="setStatus('rejected')"
            >
              <X class="size-4 text-slate-400" />
              Reject
            </button>
          </li>
          <li v-if="status !== 'reimbursed'">
            <button
              type="button"
              :disabled="submitting"
              class="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium text-ink transition hover:bg-slate-100 disabled:opacity-50"
              @click="setStatus('reimbursed')"
            >
              <Wallet class="size-4 text-slate-400" />
              Mark reimbursed
            </button>
          </li>
          <li v-if="status !== 'pending'">
            <button
              type="button"
              :disabled="submitting"
              class="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium text-ink transition hover:bg-slate-100 disabled:opacity-50"
              @click="setStatus('pending')"
            >
              <Undo2 class="size-4 text-slate-400" />
              Move back to pending
            </button>
          </li>
        </template>

        <li>
          <button
            type="button"
            :disabled="submitting || !canDelete"
            class="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            @click="showDelete = true"
          >
            <Trash2 class="size-4" />
            Delete permanently
          </button>
        </li>
      </ul>

      <p v-if="!isApprover" class="mt-4 flex items-start gap-2 text-xs text-slate-500">
        <RotateCcw class="mt-px size-3.5 shrink-0 text-slate-400" />
        Only an approver can change a claim’s status.
      </p>
      <p v-if="editHint" class="mt-2 text-xs text-slate-500">{{ editHint }}</p>

      <p v-if="error" class="mt-4 text-sm text-red-600" role="alert">{{ error.message }}</p>

      <RecordExpenseModal
        v-model:open="showEdit"
        :expense-id="expense.id"
        @updated="onEdited"
      />

      <ConfirmDialog
        v-model:open="showDelete"
        title="Delete this expense?"
        :message="`The ${expense.amount} claim for ${expense.vendor} will be removed. Any bank transaction matched to it stays, but stops pointing at this claim.`"
        confirm-label="Delete expense"
        tone="danger"
        :action="() => deleteExpense(expense.id)"
        @confirmed="onDeleted"
      />
    </template>
  </BaseModal>
</template>
