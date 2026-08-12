<script setup>
import { computed } from 'vue'

const props = defineProps({
  status: { type: String, required: true },
})

// One lookup for every status string used across the portal, so a "Paid" pill
// looks identical on the invoices, transactions and payroll pages.
const TONES = {
  Paid: 'bg-emerald-50 text-emerald-700',
  Approved: 'bg-emerald-50 text-emerald-700',
  Cleared: 'bg-emerald-50 text-emerald-700',
  Active: 'bg-emerald-50 text-emerald-700',
  Reimbursed: 'bg-emerald-50 text-emerald-700',
  Sent: 'bg-brand-50 text-brand-700',
  Pending: 'bg-amber-50 text-amber-700',
  Onboarding: 'bg-amber-50 text-amber-700',
  Invited: 'bg-amber-50 text-amber-700',
  'Needs review': 'bg-amber-50 text-amber-700',
  Overdue: 'bg-red-50 text-red-600',
  Failed: 'bg-red-50 text-red-600',
  Rejected: 'bg-red-50 text-red-600',
  Draft: 'bg-slate-100 text-slate-600',
  Cancelled: 'bg-slate-100 text-slate-500 line-through',
}

const tone = computed(() => TONES[props.status] ?? 'bg-slate-100 text-slate-600')
</script>

<template>
  <span
    class="inline-flex rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap"
    :class="tone"
  >
    {{ status }}
  </span>
</template>
