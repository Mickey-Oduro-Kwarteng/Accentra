/**
 * Static UI configuration.
 *
 * Row data now comes from Supabase via `src/services/*` — what remains here is
 * chrome that has no database representation: navigation, filter vocabularies,
 * tab definitions, and the copy for the report library and notification list.
 */
import {
  ArrowLeftRight,
  Bell,
  Building2,
  CalendarClock,
  ChartColumn,
  FileText,
  Landmark,
  LayoutDashboard,
  Receipt,
  Scale,
  Settings,
  User,
  Users,
} from 'lucide-vue-next'

/* ------------------------------------------------------------------ shell */

export const navItems = [
  { label: 'Overview', to: '/portal/dashboard', icon: LayoutDashboard, badge: null },
  { label: 'Invoices', to: '/portal/invoices', icon: FileText, badge: null },
  { label: 'Expenses', to: '/portal/expenses', icon: Receipt, badge: null },
  { label: 'Transactions', to: '/portal/transactions', icon: ArrowLeftRight, badge: null },
  { label: 'Reports', to: '/portal/reports', icon: ChartColumn, badge: null },
  { label: 'Payroll', to: '/portal/payroll', icon: Users, badge: null },
  { label: 'Settings', to: '/portal/settings', icon: Settings, badge: null },
]

/* ------------------------------------------------------- filter vocabulary */

// These labels are mapped to database enum values inside each service.
export const cashFlowRanges = ['3M', '6M', '12M']
export const invoiceFilters = ['All', 'Draft', 'Sent', 'Paid', 'Overdue', 'Cancelled']
export const expenseFilters = [
  'All',
  'Pending',
  'Approved',
  'Rejected',
  'Reimbursed',
  'Reimbursable',
]
export const transactionFilters = ['All', 'Money in', 'Money out', 'Uncategorised']
export const reportPeriods = ['This month', 'This quarter', 'Year to date']

/* ---------------------------------------------------------------- reports */

// A catalogue of what can be generated, not data — nothing to query here.
/**
 * The report catalogue. `kind` is what `generateReport` in reportService
 * dispatches on — the ones it cannot build from the current schema say so in
 * the dialog rather than producing a plausible-looking wrong answer.
 */
export const reportLibrary = [
  { kind: 'balance-sheet', title: 'Balance sheet', body: 'Assets, liabilities and equity as at any date.', icon: Scale },
  { kind: 'cash-flow', title: 'Cash flow statement', body: 'Money in and out, month by month.', icon: ArrowLeftRight },
  { kind: 'trial-balance', title: 'Trial balance', body: 'Every account with debit and credit totals.', icon: ChartColumn },
  { kind: 'aged-receivables', title: 'Aged receivables', body: 'Who owes you, bucketed by how late they are.', icon: CalendarClock },
  { kind: 'vat-return', title: 'VAT return', body: 'Filing-ready figures for the current period.', icon: Landmark },
  { kind: 'payroll-summary', title: 'Payroll summary', body: 'Gross, deductions and employer costs per run.', icon: Users },
]

/* --------------------------------------------------------------- settings */

export const settingsTabs = [
  { key: 'profile', label: 'Profile', icon: User },
  { key: 'company', label: 'Company', icon: Building2 },
  { key: 'notifications', label: 'Notifications', icon: Bell },
]

/**
 * Notification copy. The `key` matches `notification_preferences.key`; the
 * email/push booleans come from the database and are merged in on the page.
 */
export const notificationPrefs = [
  { key: 'invoice-paid', label: 'Invoice paid', body: 'When a client settles an invoice.' },
  { key: 'invoice-overdue', label: 'Invoice overdue', body: 'The morning an invoice passes its due date.' },
  { key: 'expense-approval', label: 'Expense awaiting approval', body: 'When a team member submits a claim.' },
  { key: 'bank-sync', label: 'Bank sync failure', body: 'If a connected account stops syncing.' },
  { key: 'monthly-close', label: 'Month-end close reminder', body: 'Three days before the period closes.' },
  { key: 'product-news', label: 'Product news', body: 'New features and occasional tips.' },
]
