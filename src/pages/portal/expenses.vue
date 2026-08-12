<script setup>
import { computed, ref } from 'vue'
import {
  CalendarClock,
  ChartColumn,
  Ellipsis,
  Plus,
  Receipt,
  Upload,
  Users,
} from 'lucide-vue-next'
import StatCard from '../../components/dashboard/StatCard.vue'
import ExpenseActionsModal from '../../components/modals/ExpenseActionsModal.vue'
import RecordExpenseModal from '../../components/modals/RecordExpenseModal.vue'
import UploadReceiptModal from '../../components/modals/UploadReceiptModal.vue'
import AsyncState from '../../components/portal/AsyncState.vue'
import FilterTabs from '../../components/portal/FilterTabs.vue'
import PageHeader from '../../components/portal/PageHeader.vue'
import SearchInput from '../../components/portal/SearchInput.vue'
import StatusPill from '../../components/portal/StatusPill.vue'
import MeterListSkeleton from '../../components/skeletons/MeterListSkeleton.vue'
import TableSkeleton from '../../components/skeletons/TableSkeleton.vue'
import { usePortalData } from '../../composables/usePortalData'
import {
  getExpenseBreakdown,
  getExpenseStats,
  listExpenses,
} from '../../services/expenseService'
import { expenseFilters } from '../../utils/samplesData'

const activeFilter = ref('All')
const query = ref('')

const {
  data: stats,
  loading: statsLoading,
  error: statsError,
  refresh: refreshStats,
} = usePortalData((orgId) => getExpenseStats(orgId))

const {
  data: breakdown,
  loading: breakdownLoading,
  error: breakdownError,
  refresh: refreshBreakdown,
} = usePortalData((orgId) => getExpenseBreakdown(orgId), { initial: [] })

const {
  data: rows,
  loading: rowsLoading,
  error: rowsError,
  refresh: refreshRows,
} = usePortalData(
  (orgId) => listExpenses(orgId, { filter: activeFilter.value, search: query.value }),
  { initial: [], watchSources: [activeFilter, query] },
)

const statCards = computed(() => {
  if (!stats.value) return []
  return [
    {
      label: 'Spent this month',
      value: stats.value.spentThisMonth,
      icon: Receipt,
      caption: `Across ${stats.value.expenseCount} transactions`,
    },
    {
      label: 'Pending approval',
      value: stats.value.pendingAmount,
      icon: CalendarClock,
      good: false,
      up: true,
      delta: stats.value.pendingCount ? `${stats.value.pendingCount} items` : '',
      caption: 'Waiting on a decision',
    },
    {
      label: 'Reimbursable',
      value: stats.value.reimbursable,
      icon: Users,
      caption: `Owed to ${stats.value.reimbursablePeople} people`,
    },
    {
      label: 'Largest category',
      value: stats.value.topCategory,
      icon: ChartColumn,
      delta: stats.value.topCategoryShare,
      up: true,
      caption: 'Share of total spend',
    },
  ]
})

const showRecordExpense = ref(false)
const showUploadReceipt = ref(false)
const actionsFor = ref(null)
const showActions = ref(false)

function openActions(expense) {
  actionsFor.value = expense
  showActions.value = true
}

/**
 * A new claim moves the pending figure and the transaction count, and — once
 * approved — the category meters, so all three refetch rather than only the
 * table the row landed in. An edit, a decision or a deletion can move the same
 * three, so they all land here.
 */
function refreshAll() {
  refreshStats()
  refreshBreakdown()
  refreshRows()
}
</script>

<template>
  <div>
    <PageHeader
      title="Expenses"
      subtitle="What things cost, whenever the money actually moves. Transactions shows the bank side."
    >
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-ink shadow-sm transition hover:bg-slate-50"
        @click="showUploadReceipt = true"
      >
        <Upload class="size-4 text-slate-400" />
        Upload receipts
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 transition hover:bg-brand-700 active:scale-[0.98]"
        @click="showRecordExpense = true"
      >
        <Plus class="size-4" />
        Record expense
      </button>
    </PageHeader>

    <RecordExpenseModal v-model:open="showRecordExpense" @created="refreshAll" />
    <UploadReceiptModal v-model:open="showUploadReceipt" @uploaded="refreshRows" />

    <ExpenseActionsModal
      v-model:open="showActions"
      :expense="actionsFor"
      @changed="refreshAll"
    />

    <AsyncState
      class="mt-7 block"
      :loading="statsLoading"
      :error="statsError"
      skeleton="cards"
      @retry="refreshStats"
    >
      <div class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard v-for="stat in statCards" :key="stat.label" v-bind="stat" />
      </div>
    </AsyncState>

    <div class="mt-6 grid gap-6 xl:grid-cols-[1fr_2fr]">
      <!-- Category breakdown -->
      <AsyncState
        :loading="breakdownLoading"
        :error="breakdownError"
        @retry="refreshBreakdown"
      >
        <template #skeleton><MeterListSkeleton /></template>

        <section class="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <header>
            <h2 class="text-base font-semibold text-ink">Spend by category</h2>
            <p class="mt-1 text-sm text-slate-500">This month</p>
          </header>

          <ul v-if="breakdown?.length" class="mt-6 space-y-5">
            <li v-for="category in breakdown" :key="category.label">
              <div class="flex items-baseline justify-between gap-3">
                <span class="text-sm font-medium text-ink">{{ category.label }}</span>
                <span class="text-sm text-slate-500 tabular-nums">{{ category.amount }}</span>
              </div>
              <div class="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  class="h-full rounded-full bg-brand-500 transition-all duration-500"
                  :style="{ width: `${category.share}%` }"
                ></div>
              </div>
              <p class="mt-1.5 text-xs text-slate-400">{{ category.share }}% of total spend</p>
            </li>
          </ul>

          <p v-else class="mt-6 text-sm text-slate-400">
            No approved expenses this month yet.
          </p>
        </section>
      </AsyncState>

      <!-- Expense table -->
      <section class="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <header class="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <FilterTabs v-model="activeFilter" :options="expenseFilters" />
          <SearchInput v-model="query" placeholder="Search vendor…" />
        </header>

        <AsyncState :loading="rowsLoading" :error="rowsError" @retry="refreshRows">
          <template #skeleton>
            <TableSkeleton :rows="8" :columns="5" :avatar="false" actions />
          </template>

          <div class="overflow-x-auto">
            <table class="w-full min-w-2xl text-left">
              <thead>
                <tr class="border-b border-slate-100 text-xs text-slate-400">
                  <th scope="col" class="px-6 py-3 font-medium">Vendor</th>
                  <th scope="col" class="px-6 py-3 font-medium">Paid with</th>
                  <th scope="col" class="px-6 py-3 font-medium">Date</th>
                  <th scope="col" class="px-6 py-3 font-medium">Status</th>
                  <th scope="col" class="px-6 py-3 text-right font-medium">Amount</th>
                  <th scope="col" class="px-6 py-3"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="expense in rows"
                  :key="expense.id"
                  class="border-b border-slate-50 transition last:border-0 hover:bg-slate-50/70"
                >
                  <td class="px-6 py-4">
                    <span class="block text-sm font-medium text-ink">{{ expense.vendor }}</span>
                    <span class="mt-1 inline-flex rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {{ expense.category }}
                    </span>
                  </td>
                  <td class="px-6 py-4">
                    <span class="block text-sm whitespace-nowrap text-slate-600">{{ expense.method }}</span>
                    <span class="block text-xs text-slate-400">{{ expense.owner }}</span>
                  </td>
                  <td class="px-6 py-4 text-sm whitespace-nowrap text-slate-500">{{ expense.date }}</td>
                  <td class="px-6 py-4"><StatusPill :status="expense.status" /></td>
                  <td class="px-6 py-4 text-right text-sm font-semibold whitespace-nowrap text-ink tabular-nums">
                    {{ expense.amount }}
                  </td>
                  <td class="px-6 py-4 text-right">
                    <button
                      type="button"
                      class="grid size-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-ink"
                      :aria-label="`Actions for ${expense.vendor}`"
                      @click="openActions(expense)"
                    >
                      <Ellipsis class="size-4" />
                    </button>
                  </td>
                </tr>

                <tr v-if="!rows?.length">
                  <td colspan="6" class="px-6 py-14 text-center">
                    <p class="text-sm font-medium text-ink">No expenses to show</p>
                    <p class="mt-1 text-sm text-slate-500">
                      Try a different status, or record your first expense.
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AsyncState>
      </section>
    </div>
  </div>
</template>
