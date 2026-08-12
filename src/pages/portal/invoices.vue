<script setup>
import { computed, ref } from 'vue'
import {
  Banknote,
  CalendarClock,
  Download,
  Ellipsis,
  FileText,
  Plus,
  Scale,
} from 'lucide-vue-next'
import StatCard from '../../components/dashboard/StatCard.vue'
import ExportModal from '../../components/modals/ExportModal.vue'
import InvoiceActionsModal from '../../components/modals/InvoiceActionsModal.vue'
import NewInvoiceModal from '../../components/modals/NewInvoiceModal.vue'
import AsyncState from '../../components/portal/AsyncState.vue'
import FilterTabs from '../../components/portal/FilterTabs.vue'
import PageHeader from '../../components/portal/PageHeader.vue'
import SearchInput from '../../components/portal/SearchInput.vue'
import StatusPill from '../../components/portal/StatusPill.vue'
import TableSkeleton from '../../components/skeletons/TableSkeleton.vue'
import { useOrganization } from '../../composables/useOrganization'
import { usePortalData } from '../../composables/usePortalData'
import { getInvoiceStats, listInvoices } from '../../services/invoiceService'
import { initials } from '../../utils/format'
import { invoiceFilters } from '../../utils/samplesData'

const { ensureOrganization } = useOrganization()

const activeFilter = ref('All')
const query = ref('')
const page = ref(0)
const PAGE_SIZE = 20

const {
  data: stats,
  loading: statsLoading,
  error: statsError,
  refresh: refreshStats,
} = usePortalData((orgId) => getInvoiceStats(orgId))

// Refetches whenever a filter, the search term, or the page changes. Stale
// responses are discarded by usePortalData, so fast typing cannot race.
const {
  data: table,
  loading: tableLoading,
  error: tableError,
  refresh: refreshTable,
} = usePortalData(
  (orgId) =>
    listInvoices(orgId, {
      filter: activeFilter.value,
      search: query.value,
      page: page.value,
      pageSize: PAGE_SIZE,
    }),
  {
    initial: { rows: [], total: 0 },
    watchSources: [activeFilter, query, page],
  },
)

const rows = computed(() => table.value?.rows ?? [])
const total = computed(() => table.value?.total ?? 0)
const hasNextPage = computed(() => (page.value + 1) * PAGE_SIZE < total.value)

const statCards = computed(() => {
  if (!stats.value) return []
  return [
    {
      label: 'Outstanding',
      value: stats.value.outstanding,
      icon: FileText,
      caption: `${stats.value.unpaidCount} invoices unpaid`,
    },
    {
      label: 'Overdue',
      value: stats.value.overdue,
      icon: CalendarClock,
      good: false,
      up: true,
      delta: stats.value.overdueCount ? `${stats.value.overdueCount} late` : '',
      caption: 'Past their due date',
    },
    {
      label: 'Paid this month',
      value: stats.value.paidThisMonth,
      icon: Banknote,
      caption: `${stats.value.paidCount} invoices settled`,
    },
    {
      label: 'Avg days to pay',
      value: stats.value.avgDaysToPay,
      icon: Scale,
      caption: 'Across settled invoices',
    },
  ]
})

function resetPage() {
  page.value = 0
}

const showNewInvoice = ref(false)
const showExport = ref(false)
const actionsFor = ref(null)
const showActions = ref(false)

const EXPORT_COLUMNS = [
  { key: 'number', label: 'Invoice' },
  { key: 'client', label: 'Client' },
  { key: 'email', label: 'Email' },
  { key: 'issued', label: 'Issued' },
  { key: 'due', label: 'Due' },
  { key: 'status', label: 'Status' },
  { key: 'paymentMethod', label: 'Payment method' },
  { key: 'amount', label: 'Amount' },
  { key: 'balanceDue', label: 'Balance due' },
]

/**
 * Export the whole filtered set, not just the page on screen — someone
 * exporting on page three means the invoices matching their filter, not
 * invoices 41 to 60.
 */
async function fetchExportRows() {
  const orgId = await ensureOrganization()
  const { rows: all } = await listInvoices(orgId, {
    filter: activeFilter.value,
    search: query.value,
    page: 0,
    pageSize: 1000,
  })
  return all
}

function openActions(invoice) {
  actionsFor.value = invoice
  showActions.value = true
}

function onInvoiceChanged() {
  refreshTable()
  refreshStats()
}
</script>

<template>
  <div>
    <PageHeader title="Invoices" subtitle="Raise, send and chase every invoice in one place.">
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-ink shadow-sm transition hover:bg-slate-50"
        @click="showExport = true"
      >
        <Download class="size-4 text-slate-400" />
        Export
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 transition hover:bg-brand-700 active:scale-[0.98]"
        @click="showNewInvoice = true"
      >
        <Plus class="size-4" />
        New invoice
      </button>
    </PageHeader>

    <NewInvoiceModal v-model:open="showNewInvoice" @created="onInvoiceChanged" />

    <InvoiceActionsModal
      v-model:open="showActions"
      :invoice="actionsFor"
      @changed="onInvoiceChanged"
    />

    <ExportModal
      v-model:open="showExport"
      title="Export invoices"
      :subtitle="`Every invoice matching the ${activeFilter.toLowerCase()} filter.`"
      filename="invoices"
      :columns="EXPORT_COLUMNS"
      :fetch-rows="fetchExportRows"
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

    <section class="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header class="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-6 py-5">
        <FilterTabs v-model="activeFilter" :options="invoiceFilters" @update:model-value="resetPage" />
        <SearchInput v-model="query" placeholder="Search client or number…" @update:model-value="resetPage" />
      </header>

      <AsyncState :loading="tableLoading" :error="tableError" @retry="refreshTable">
        <template #skeleton>
          <TableSkeleton :rows="8" :columns="6" actions />
        </template>

        <div class="overflow-x-auto">
          <table class="w-full min-w-3xl text-left">
            <thead>
              <tr class="border-b border-slate-100 text-xs text-slate-400">
                <th scope="col" class="px-6 py-3 font-medium">Client</th>
                <th scope="col" class="px-6 py-3 font-medium">Invoice</th>
                <th scope="col" class="px-6 py-3 font-medium">Issued</th>
                <th scope="col" class="px-6 py-3 font-medium">Due</th>
                <th scope="col" class="px-6 py-3 font-medium">Status</th>
                <th scope="col" class="px-6 py-3 text-right font-medium">Amount</th>
                <th scope="col" class="px-6 py-3"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="invoice in rows"
                :key="invoice.id"
                class="border-b border-slate-50 transition last:border-0 hover:bg-slate-50/70"
              >
                <td class="px-6 py-4">
                  <div class="flex items-center gap-3">
                    <span
                      class="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-xs font-semibold text-brand-700"
                    >
                      {{ initials(invoice.client) }}
                    </span>
                    <span class="min-w-0">
                      <span class="block truncate text-sm font-medium text-ink">{{ invoice.client }}</span>
                      <span class="block truncate text-xs text-slate-400">{{ invoice.email }}</span>
                    </span>
                  </div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                  <span class="block text-sm font-medium text-slate-600">{{ invoice.number }}</span>
                  <span class="block text-xs text-slate-400">{{ invoice.paymentMethod }}</span>
                </td>
                <td class="px-6 py-4 text-sm whitespace-nowrap text-slate-500">{{ invoice.issued }}</td>
                <td class="px-6 py-4 text-sm whitespace-nowrap text-slate-500">{{ invoice.due }}</td>
                <td class="px-6 py-4"><StatusPill :status="invoice.status" /></td>
                <td class="px-6 py-4 text-right text-sm font-semibold whitespace-nowrap text-ink tabular-nums">
                  {{ invoice.amount }}
                </td>
                <td class="px-6 py-4 text-right">
                  <button
                    type="button"
                    class="grid size-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-ink"
                    :aria-label="`Actions for ${invoice.number}`"
                    @click="openActions(invoice)"
                  >
                    <Ellipsis class="size-4" />
                  </button>
                </td>
              </tr>

              <tr v-if="!rows.length">
                <td colspan="7" class="px-6 py-14 text-center">
                  <p class="text-sm font-medium text-ink">No invoices to show</p>
                  <p class="mt-1 text-sm text-slate-500">
                    Try a different status, clear the search box, or raise your first invoice.
                  </p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <footer
          v-if="rows.length"
          class="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-6 py-4"
        >
          <p class="text-xs text-slate-500">
            Showing {{ rows.length }} of {{ total }} invoices
          </p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-50 disabled:opacity-50"
              :disabled="page === 0"
              @click="page--"
            >
              Previous
            </button>
            <button
              type="button"
              class="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-slate-50 disabled:opacity-50"
              :disabled="!hasNextPage"
              @click="page++"
            >
              Next
            </button>
          </div>
        </footer>
      </AsyncState>
    </section>
  </div>
</template>
