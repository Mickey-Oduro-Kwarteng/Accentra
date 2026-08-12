# Accentra — Supabase Schema

Complete SQL for the Accentra accounting portal: enums, tables, indexes, row
level security, triggers, aggregate functions and storage.

**The sections are ordered so nothing forward-references anything.** Each phase
only depends on phases above it, so you can run them one at a time and never hit
a "relation does not exist" or "function does not exist" error:

```
2. enums        → depend on nothing
3. tables       → depend on enums only          (no RLS, no triggers, no policies)
4. helpers      → depend on tables
5. policies     → depend on tables + helpers
6. triggers     → depend on tables + helpers
7. views/aggs   → depend on everything above
```

That is the whole point of the layout. The old version interleaved tables with
their own policies and triggers, which meant `transactions` needed `invoices` to
exist, `invoices` needed `is_org_member()`, and `is_org_member()` needed
`organization_members` — a knot with no valid single pass. Splitting by *kind of
object* rather than by *feature area* unties it.

> The client side of this lives in `src/services/` — one module per page, each
> wrapping the tables and functions below. Look there for how a given screen
> queries the database; this document covers only the database itself.

**Contents**

1. [Conventions](#1-conventions)
2. [Extensions and enums](#2-extensions-and-enums)
3. [Tables](#3-tables)
4. [Helper functions](#4-helper-functions)
5. [Row level security](#5-row-level-security)
6. [Triggers and business logic](#6-triggers-and-business-logic)
7. [Views and aggregates](#7-views-and-aggregates)
8. [Realtime and storage](#8-realtime-and-storage)
9. [Seed data](#9-seed-data)
10. [Verification](#10-verification)
11. [Starting over](#11-starting-over)

---

## 1. Conventions

**Money.** `numeric(14,2)`. Postgres `numeric` is exact decimal — no float
rounding drift. `14,2` holds up to 999,999,999,999.99. Never use `float8` for
money.

**Currency.** Ghana Cedi (`GHS`, ₵) is the default. `organizations.base_currency`
is a 3-letter ISO code so multi-currency stays possible; transactional tables
carry their own `currency` + `fx_rate` for foreign invoices, with the
base-currency equivalent stored alongside.

**Tenancy.** Every business row carries `organization_id`. All RLS reduces to
"is the calling user a member of this organisation?". This is the single
security boundary — get it right once and every table inherits it.

**Signed amounts.** Transactions store a signed `amount`: positive is money in,
negative is money out. This keeps `sum(amount)` meaningful and matches the
`positive` flag the UI renders.

**Timestamps.** `timestamptz` everywhere, defaulting to `now()`. Values with no
time component (invoice issue date, pay date) use `date`.

**Naming.** Tables plural and snake_case; enums singular. Every table has
`id uuid primary key default gen_random_uuid()`, `created_at`, `updated_at`.

**Deletes.** Business records soft-delete via `archived_at` so ledger history
survives. Only join rows hard-delete.

---

## 2. Extensions and enums

Nothing here depends on anything. Run it first, once.

```sql
create extension if not exists "pgcrypto";      -- gen_random_uuid()
create extension if not exists "pg_trgm";       -- fast ILIKE search on names

-- Roles inside an organisation. Ordered least → most privileged in intent;
-- the ordering is not enforced by the type, so compare explicitly.
create type org_role as enum ('viewer', 'accountant', 'bookkeeper', 'admin', 'owner');

-- These mirror the StatusPill vocabulary in the UI.
create type invoice_status  as enum ('draft', 'sent', 'paid', 'overdue', 'void');
create type expense_status  as enum ('pending', 'approved', 'rejected', 'reimbursed');
create type txn_status      as enum ('pending', 'cleared', 'needs_review', 'failed');
create type account_type    as enum ('bank', 'card', 'cash', 'savings');
create type employment_type as enum ('salaried', 'contract');
create type employee_status as enum ('active', 'onboarding', 'left');
create type payroll_status  as enum ('draft', 'pending', 'paid', 'failed');
create type payment_method  as enum ('bank_transfer', 'card', 'cash', 'mobile_money', 'reimbursement');
```

`mobile_money` is in there because it is a first-class payment rail in Ghana —
you will want it before you want half the card options.

**Already applied?** Postgres has no `create type if not exists`, so re-running
the block above errors on the first type. Skip this section, or wrap each
statement so a repeat is a no-op:

```sql
do $$ begin
  create type org_role as enum ('viewer', 'accountant', 'bookkeeper', 'admin', 'owner');
exception when duplicate_object then null;
end $$;
```

Adding a value later is a plain `alter`, and is safe to repeat:

```sql
alter type payment_method add value if not exists 'cheque';
```

---

## 3. Tables

Structure only — columns, constraints, indexes. **No `enable row level
security`, no policies, no triggers.** Those come in §5 and §6, once the things
they reference exist.

The tables are listed in foreign-key order, so a single top-to-bottom run works.
Every `references` below points at a table already created above it (or at
`auth.users`, which Supabase provides).

### 3.1 `profiles` — settings → Profile tab

```sql
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  job_title   text,
  phone       text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
```

### 3.2 `organizations` — settings → Company tab

```sql
create table public.organizations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  registration_number text,
  vat_number          text,
  address             text,
  base_currency       char(3) not null default 'GHS',
  fiscal_year_start   smallint not null default 1
                        check (fiscal_year_start between 1 and 12),
  accounting_basis    text not null default 'accrual'
                        check (accounting_basis in ('accrual', 'cash')),
  created_by          uuid not null references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
```

### 3.3 `organization_members`

The Team management UI has been removed, but this table stays — it *is* the RLS
boundary. Every policy in this document resolves through it. Rows are created by
the signup trigger (§6.4); add more via SQL or a future admin screen.

```sql
create table public.organization_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            org_role not null default 'viewer',
  created_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index organization_members_user_idx on public.organization_members(user_id);
create index organization_members_org_idx  on public.organization_members(organization_id);
```

### 3.4 `accounts` — the transaction page's account cards

```sql
create table public.accounts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  institution     text,
  type            account_type not null default 'bank',
  currency        char(3) not null default 'GHS',
  opening_balance numeric(14,2) not null default 0,
  last_synced_at  timestamptz,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index accounts_org_idx on public.accounts(organization_id) where archived_at is null;
```

### 3.5 `clients`

```sql
create table public.clients (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  email           text,
  phone           text,
  address         text,
  payment_terms   smallint not null default 14,   -- days
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index clients_org_idx  on public.clients(organization_id) where archived_at is null;
create index clients_name_idx on public.clients using gin (name gin_trgm_ops);
```

### 3.6 `invoices`

```sql
create table public.invoices (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id       uuid not null references public.clients(id) on delete restrict,

  number          text not null,
  status          invoice_status not null default 'draft',
  issue_date      date not null default current_date,
  due_date        date not null,

  subtotal        numeric(14,2) not null default 0,
  tax_total       numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,
  amount_paid     numeric(14,2) not null default 0,
  balance_due     numeric(14,2) generated always as (total - amount_paid) stored,

  currency        char(3) not null default 'GHS',
  notes           text,
  sent_at         timestamptz,
  paid_at         timestamptz,

  -- How the client is asked to pay, chosen when the invoice is raised, and
  -- overwritten with how they actually paid when the payment is recorded.
  -- Nullable because plenty of invoices simply do not say.
  payment_method  payment_method,

  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint invoices_due_after_issue    check (due_date >= issue_date),
  constraint invoices_paid_within_total  check (amount_paid <= total),
  unique (organization_id, number)
);

create index invoices_org_status_idx on public.invoices(organization_id, status);
create index invoices_due_idx        on public.invoices(organization_id, due_date);
create index invoices_client_idx     on public.invoices(client_id);
```

**Already have a database built from an earlier copy of this file?** The
`payment_method` column is new. Without it the invoice form fails with *"Could
not find the 'payment_method' column of 'invoices' in the schema cache"*. Add
it — the column is nullable, so every existing invoice stays valid and simply
reads as "not specified":

```sql
alter table public.invoices
  add column if not exists payment_method payment_method;

-- PostgREST caches the column list; tell it to look again.
notify pgrst, 'reload schema';
```

### 3.7 `invoice_items`

`stream` is the revenue-stream tag that `revenue_by_stream()` (§7.8) groups on —
declared here rather than bolted on with a later `alter table`.

```sql
create table public.invoice_items (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  description text not null,
  quantity    numeric(12,3) not null default 1 check (quantity > 0),
  unit_price  numeric(14,2) not null default 0,
  tax_rate    numeric(5,2)  not null default 0,   -- Ghana standard VAT is 15.00
  line_total  numeric(14,2) generated always as (quantity * unit_price) stored,
  position    smallint not null default 0,
  stream      text,                               -- 'Retainers', 'Projects', …
  created_at  timestamptz not null default now()
);

create index invoice_items_invoice_idx on public.invoice_items(invoice_id, position);
```

Items carry no `organization_id` — they inherit the parent invoice's access
(§5.7). One source of truth, no chance of the two disagreeing.

### 3.8 `expense_categories`

```sql
create table public.expense_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (organization_id, name)
);
```

### 3.9 `expenses`

```sql
create table public.expenses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  category_id     uuid references public.expense_categories(id) on delete set null,
  account_id      uuid references public.accounts(id) on delete set null,

  vendor          text not null,
  spent_on        date not null default current_date,
  amount          numeric(14,2) not null check (amount > 0),
  currency        char(3) not null default 'GHS',
  method          payment_method not null default 'card',
  method_detail   text,                       -- "Visa ·· 4412", "MTN MoMo"
  status          expense_status not null default 'pending',
  reimbursable    boolean not null default false,
  receipt_url     text,
  notes           text,

  -- Who spent it, and who signed it off.
  --
  -- These point at `profiles`, not `auth.users`, so PostgREST can embed the
  -- name on an expense row (`profiles!expenses_submitted_by_fkey(...)` in
  -- expenseService). Relationships are only discoverable inside the exposed
  -- schema, and `auth` is not exposed — an FK to `auth.users` gives
  -- "Could not find a relationship between 'expenses' and 'profiles'".
  --
  -- Integrity is unchanged: `profiles.id` is itself an FK to `auth.users(id)`
  -- with `on delete cascade`, and the signup trigger (§6.4) writes a profile
  -- row for every user.
  submitted_by    uuid not null
                    constraint expenses_submitted_by_fkey
                    references public.profiles(id) on delete restrict,
  approved_by     uuid
                    constraint expenses_approved_by_fkey
                    references public.profiles(id) on delete set null,
  approved_at     timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index expenses_org_date_idx on public.expenses(organization_id, spent_on desc);
create index expenses_status_idx   on public.expenses(organization_id, status);
create index expenses_category_idx on public.expenses(category_id);
create index expenses_vendor_idx   on public.expenses using gin (vendor gin_trgm_ops);
```

**Already have a database built from an earlier copy of this file?** Those two
columns pointed at `auth.users`, so the expense page fails with *"Could not find
a relationship between 'expenses' and 'profiles' in the schema cache"*. Repoint
them — no data moves, every `submitted_by` already has a matching `profiles`
row:

```sql
alter table public.expenses drop constraint if exists expenses_submitted_by_fkey;
alter table public.expenses drop constraint if exists expenses_approved_by_fkey;

alter table public.expenses
  add constraint expenses_submitted_by_fkey
  foreign key (submitted_by) references public.profiles(id) on delete restrict;

alter table public.expenses
  add constraint expenses_approved_by_fkey
  foreign key (approved_by) references public.profiles(id) on delete set null;

-- PostgREST caches relationships; tell it to look again.
notify pgrst, 'reload schema';
```

### 3.10 `transactions`

This is the table that forced the reordering — it points at `accounts`,
`expense_categories`, `invoices` **and** `expenses`. Placed here, all four
already exist, so no `alter table … add constraint` cleanup is needed.

```sql
create table public.transactions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  account_id      uuid not null references public.accounts(id) on delete restrict,
  category_id     uuid references public.expense_categories(id) on delete set null,
  invoice_id      uuid references public.invoices(id) on delete set null,
  expense_id      uuid references public.expenses(id) on delete set null,

  occurred_on     date not null,
  description     text not null,
  -- Positive = money in, negative = money out.
  amount          numeric(14,2) not null,
  currency        char(3) not null default 'GHS',
  fx_rate         numeric(14,6) not null default 1,
  base_amount     numeric(14,2) generated always as (amount * fx_rate) stored,

  status          txn_status not null default 'cleared',
  reconciled      boolean not null default false,
  reconciled_at   timestamptz,
  external_ref    text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint transactions_amount_nonzero check (amount <> 0)
);

-- The table is read date-descending on every page; this index serves that directly.
create index transactions_org_date_idx
  on public.transactions(organization_id, occurred_on desc);
create index transactions_account_idx on public.transactions(account_id);
create index transactions_unreconciled_idx
  on public.transactions(organization_id) where reconciled = false;
create index transactions_search_idx
  on public.transactions using gin (description gin_trgm_ops);
-- Blocks duplicate imports of the same bank-feed row.
create unique index transactions_external_ref_idx
  on public.transactions(organization_id, external_ref)
  where external_ref is not null;
```

### 3.11 `employees`

```sql
create table public.employees (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid references auth.users(id) on delete set null,  -- null if no login

  full_name       text not null,
  role_title      text,
  email           text,
  employment_type employment_type not null default 'salaried',
  status          employee_status not null default 'active',

  -- Monthly gross for salaried staff, hourly rate for contractors.
  pay_rate        numeric(14,2) not null check (pay_rate >= 0),
  currency        char(3) not null default 'GHS',

  started_on      date not null default current_date,
  ended_on        date,
  bank_account    text,
  ssnit_number    text,          -- Ghana social security number
  tin             text,          -- taxpayer identification number

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint employees_end_after_start check (ended_on is null or ended_on >= started_on)
);

create index employees_org_idx on public.employees(organization_id, status);
```

### 3.12 `payroll_runs`

```sql
create table public.payroll_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,

  period_start     date not null,
  period_end       date not null,
  pay_date         date not null,
  status           payroll_status not null default 'draft',

  gross_total      numeric(14,2) not null default 0,
  deductions_total numeric(14,2) not null default 0,
  net_total        numeric(14,2) generated always as (gross_total - deductions_total) stored,
  employee_count   smallint not null default 0,

  -- Mirrors the run checklist in the UI.
  hours_imported   boolean not null default false,
  gross_calculated boolean not null default false,
  approved_by      uuid references auth.users(id) on delete set null,
  approved_at      timestamptz,
  submitted_at     timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint payroll_period_valid check (period_end >= period_start),
  unique (organization_id, period_start, period_end)
);

create index payroll_runs_org_idx on public.payroll_runs(organization_id, pay_date desc);
```

### 3.13 `payroll_items`

```sql
create table public.payroll_items (
  id               uuid primary key default gen_random_uuid(),
  payroll_run_id   uuid not null references public.payroll_runs(id) on delete cascade,
  employee_id      uuid not null references public.employees(id) on delete restrict,

  gross            numeric(14,2) not null default 0,
  paye_tax         numeric(14,2) not null default 0,   -- income tax
  ssnit_employee   numeric(14,2) not null default 0,   -- 5.5% employee contribution
  ssnit_employer   numeric(14,2) not null default 0,   -- 13% employer contribution
  other_deductions numeric(14,2) not null default 0,
  net              numeric(14,2) generated always as
                     (gross - paye_tax - ssnit_employee - other_deductions) stored,

  created_at       timestamptz not null default now(),
  unique (payroll_run_id, employee_id)
);

create index payroll_items_run_idx on public.payroll_items(payroll_run_id);
```

### 3.14 `notification_preferences`

```sql
create table public.notification_preferences (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key             text not null,      -- 'invoice-paid', 'bank-sync', …
  email           boolean not null default true,
  push            boolean not null default false,
  updated_at      timestamptz not null default now(),
  unique (user_id, organization_id, key)
);
```

Profile and company settings forms write to `profiles` (§3.1) and
`organizations` (§3.2) respectively — no extra table needed.

---

## 4. Helper functions

Every policy in §5 calls one of these, so they must exist before §5 runs. They
only need the tables from §3, which now all exist.

These are `security definer` **on purpose**. An RLS policy on
`organization_members` that itself queries `organization_members` recurses
infinitely. A `security definer` function bypasses RLS internally, breaking the
cycle.

```sql
-- Is the calling user a member of this organisation?
create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org
      and m.user_id = auth.uid()
  );
$$;

-- Does the caller hold at least one of these roles in the organisation?
create or replace function public.has_org_role(org uuid, roles org_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org
      and m.user_id = auth.uid()
      and m.role = any(roles)
  );
$$;

-- Every organisation the caller belongs to. Useful in `in (...)` predicates.
create or replace function public.my_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id
  from public.organization_members
  where user_id = auth.uid();
$$;

revoke execute on function public.is_org_member(uuid) from anon;
revoke execute on function public.has_org_role(uuid, org_role[]) from anon;
revoke execute on function public.my_org_ids() from anon;
```

Shared `updated_at` trigger function. The triggers that use it are attached in
§6.1 — the function has to exist first:

```sql
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
```

---

## 5. Row level security

Everything RLS-related, in one place. Depends on §3 (the tables) and §4 (the
helpers) — nothing else.

### 5.1 Enable RLS everywhere

Do this as one block so no table is ever left unguarded. A `public` table
without RLS is readable by every anon key holder on the internet.

```sql
alter table public.profiles                 enable row level security;
alter table public.organizations            enable row level security;
alter table public.organization_members     enable row level security;
alter table public.accounts                 enable row level security;
alter table public.clients                  enable row level security;
alter table public.invoices                 enable row level security;
alter table public.invoice_items            enable row level security;
alter table public.expense_categories       enable row level security;
alter table public.expenses                 enable row level security;
alter table public.transactions             enable row level security;
alter table public.employees                enable row level security;
alter table public.payroll_runs             enable row level security;
alter table public.payroll_items            enable row level security;
alter table public.notification_preferences enable row level security;
```

### 5.2 `profiles`

```sql
-- You can always read and edit yourself.
create policy "profiles: read own"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles: update own"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "profiles: insert own"
  on public.profiles for insert
  with check (id = auth.uid());

-- Read colleagues so their names can appear on expense and payroll rows.
create policy "profiles: read org colleagues"
  on public.profiles for select
  using (
    exists (
      select 1
      from public.organization_members me
      join public.organization_members them
        on them.organization_id = me.organization_id
      where me.user_id = auth.uid()
        and them.user_id = profiles.id
    )
  );
```

### 5.3 `organizations`

```sql
create policy "orgs: members read"
  on public.organizations for select
  using (public.is_org_member(id));

create policy "orgs: admins update"
  on public.organizations for update
  using (public.has_org_role(id, array['owner','admin']::org_role[]))
  with check (public.has_org_role(id, array['owner','admin']::org_role[]));

-- Anyone signed in may create an organisation; the signup trigger (§6.4) makes
-- the creator its owner.
create policy "orgs: authenticated insert"
  on public.organizations for insert
  to authenticated
  with check (created_by = auth.uid());
```

### 5.4 `organization_members`

```sql
create policy "members: read own org rows"
  on public.organization_members for select
  using (public.is_org_member(organization_id));

create policy "members: owners and admins write"
  on public.organization_members for all
  using (public.has_org_role(organization_id, array['owner','admin']::org_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin']::org_role[]));
```

### 5.5 `accounts`, `clients`, `expense_categories`, `transactions`

Four tables, one shape: members read, bookkeepers and up write.

```sql
create policy "accounts: members read"
  on public.accounts for select
  using (public.is_org_member(organization_id));

create policy "accounts: bookkeepers write"
  on public.accounts for all
  using (public.has_org_role(organization_id, array['owner','admin','bookkeeper']::org_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','bookkeeper']::org_role[]));


create policy "clients: members read"
  on public.clients for select
  using (public.is_org_member(organization_id));

create policy "clients: bookkeepers write"
  on public.clients for all
  using (public.has_org_role(organization_id, array['owner','admin','bookkeeper']::org_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','bookkeeper']::org_role[]));


create policy "expense categories: members read"
  on public.expense_categories for select
  using (public.is_org_member(organization_id));

create policy "expense categories: bookkeepers write"
  on public.expense_categories for all
  using (public.has_org_role(organization_id, array['owner','admin','bookkeeper']::org_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','bookkeeper']::org_role[]));


create policy "transactions: members read"
  on public.transactions for select
  using (public.is_org_member(organization_id));

create policy "transactions: bookkeepers write"
  on public.transactions for all
  using (public.has_org_role(organization_id, array['owner','admin','bookkeeper']::org_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','bookkeeper']::org_role[]));
```

### 5.6 `invoices`

```sql
create policy "invoices: members read"
  on public.invoices for select
  using (public.is_org_member(organization_id));

create policy "invoices: bookkeepers write"
  on public.invoices for all
  using (public.has_org_role(organization_id, array['owner','admin','bookkeeper']::org_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','bookkeeper']::org_role[]));
```

### 5.7 `invoice_items` — inherited from the parent invoice

```sql
create policy "invoice items: via parent invoice"
  on public.invoice_items for all
  using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_items.invoice_id
        and public.is_org_member(i.organization_id)
    )
  )
  with check (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_items.invoice_id
        and public.has_org_role(i.organization_id,
              array['owner','admin','bookkeeper']::org_role[])
    )
  );
```

### 5.8 `expenses` — the one table with a genuinely layered policy set

```sql
create policy "expenses: members read"
  on public.expenses for select
  using (public.is_org_member(organization_id));

-- Anyone in the org can submit a claim, but only in their own name.
create policy "expenses: members submit own"
  on public.expenses for insert
  with check (
    public.is_org_member(organization_id)
    and submitted_by = auth.uid()
  );

-- You may edit your own claim only while it is still pending.
create policy "expenses: edit own while pending"
  on public.expenses for update
  using (submitted_by = auth.uid() and status = 'pending')
  with check (submitted_by = auth.uid());

-- Approvers can edit anything in the org, including status changes.
create policy "expenses: approvers manage"
  on public.expenses for all
  using (public.has_org_role(organization_id, array['owner','admin','bookkeeper']::org_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','bookkeeper']::org_role[]));
```

> Note the deliberate split: a `viewer` can file an expense but never approve
> one, and cannot edit a claim once it has been approved. That rule lives in
> RLS, not in the Vue components — so it holds even when someone calls the REST
> API directly.

### 5.9 `employees`, `payroll_runs`, `payroll_items` — salary data

Tighter than everything else: read is restricted to privileged roles (plus the
employee themselves), and write to owners and admins only.

```sql
create policy "employees: privileged read"
  on public.employees for select
  using (
    public.has_org_role(organization_id,
      array['owner','admin','bookkeeper','accountant']::org_role[])
    or user_id = auth.uid()
  );

create policy "employees: admins write"
  on public.employees for all
  using (public.has_org_role(organization_id, array['owner','admin']::org_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin']::org_role[]));


create policy "payroll runs: privileged read"
  on public.payroll_runs for select
  using (public.has_org_role(organization_id,
         array['owner','admin','bookkeeper','accountant']::org_role[]));

create policy "payroll runs: admins write"
  on public.payroll_runs for all
  using (public.has_org_role(organization_id, array['owner','admin']::org_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin']::org_role[]));


create policy "payroll items: via parent run"
  on public.payroll_items for all
  using (
    exists (
      select 1 from public.payroll_runs r
      where r.id = payroll_items.payroll_run_id
        and public.has_org_role(r.organization_id,
              array['owner','admin','bookkeeper','accountant']::org_role[])
    )
  )
  with check (
    exists (
      select 1 from public.payroll_runs r
      where r.id = payroll_items.payroll_run_id
        and public.has_org_role(r.organization_id, array['owner','admin']::org_role[])
    )
  );
```

### 5.10 `notification_preferences`

```sql
-- Strictly personal. No colleague, not even the owner, reads your toggles.
create policy "notification prefs: own only"
  on public.notification_preferences for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_org_member(organization_id));
```

---

## 6. Triggers and business logic

Trigger functions plus the triggers that fire them. Depends on §3 and §4.

### 6.1 `updated_at` on every mutable table

`set_updated_at()` was defined in §4. `expense_categories`, `invoice_items` and
`payroll_items` are append-only in practice and have no `updated_at` column, so
they are not listed.

```sql
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

create trigger accounts_set_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();

create trigger clients_set_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

create trigger invoices_set_updated_at
  before update on public.invoices
  for each row execute function public.set_updated_at();

create trigger expenses_set_updated_at
  before update on public.expenses
  for each row execute function public.set_updated_at();

create trigger transactions_set_updated_at
  before update on public.transactions
  for each row execute function public.set_updated_at();

create trigger employees_set_updated_at
  before update on public.employees
  for each row execute function public.set_updated_at();

create trigger payroll_runs_set_updated_at
  before update on public.payroll_runs
  for each row execute function public.set_updated_at();

create trigger notification_prefs_set_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();
```

### 6.2 Keep invoice totals in sync

```sql
create or replace function public.recalc_invoice_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  update public.invoices i
  set subtotal  = totals.sub,
      tax_total = totals.tax,
      total     = totals.sub + totals.tax
  from (
    select
      coalesce(sum(line_total), 0)                  as sub,
      coalesce(sum(line_total * tax_rate / 100), 0) as tax
    from public.invoice_items
    where invoice_id = target
  ) as totals
  where i.id = target;

  return null;
end;
$$;

create trigger invoice_items_recalc
  after insert or update or delete on public.invoice_items
  for each row execute function public.recalc_invoice_totals();
```

### 6.3 Roll payroll item totals up to the run

```sql
create or replace function public.recalc_payroll_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid := coalesce(new.payroll_run_id, old.payroll_run_id);
begin
  update public.payroll_runs r
  set gross_total      = totals.gross,
      deductions_total = totals.deductions,
      employee_count   = totals.headcount
  from (
    select
      coalesce(sum(gross), 0) as gross,
      coalesce(sum(paye_tax + ssnit_employee + other_deductions), 0) as deductions,
      count(*) as headcount
    from public.payroll_items
    where payroll_run_id = target
  ) as totals
  where r.id = target;

  return null;
end;
$$;

create trigger payroll_items_recalc
  after insert or update or delete on public.payroll_items
  for each row execute function public.recalc_payroll_totals();
```

### 6.4 Signup trigger

Creates a profile, an organisation, and the owner membership the moment a user
signs up. Without this a new user lands in an empty portal with no org, and
every query correctly returns zero rows.

It writes to `expense_categories` and `notification_preferences`, which is
exactly why it lives here rather than next to `organizations` — by §6 all
fourteen tables exist, so nothing it touches is missing.

```sql
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org_id uuid;
  display_name text;
begin
  display_name := coalesce(
    new.raw_user_meta_data->>'full_name',
    split_part(new.email, '@', 1)
  );

  insert into public.profiles (id, full_name)
  values (new.id, display_name);

  insert into public.organizations (name, created_by, base_currency)
  values (
    coalesce(new.raw_user_meta_data->>'company', display_name || '''s workspace'),
    new.id,
    'GHS'
  )
  returning id into new_org_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (new_org_id, new.id, 'owner');

  -- Give the workspace something to categorise against on day one.
  insert into public.expense_categories (organization_id, name)
  select new_org_id, unnest(array[
    'Payroll', 'Infrastructure', 'Software', 'Marketing', 'Travel', 'Office'
  ]);

  insert into public.notification_preferences (user_id, organization_id, key, email, push)
  select new.id, new_org_id, k, e, p
  from (values
    ('invoice-paid',      true,  true),
    ('invoice-overdue',   true,  false),
    ('expense-approval',  true,  true),
    ('bank-sync',         true,  true),
    ('monthly-close',     false, false),
    ('product-news',      false, false)
  ) as defaults(k, e, p);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

### 6.5 Overdue marking

`overdue` is derived, not a state anyone sets by hand. Run it nightly with
`pg_cron`:

```sql
create or replace function public.mark_overdue_invoices()
returns void
language sql
security definer
set search_path = public
as $$
  update public.invoices
  set status = 'overdue'
  where status = 'sent'
    and due_date < current_date
    and balance_due > 0;
$$;

-- Requires pg_cron (Dashboard → Database → Extensions).
select cron.schedule('mark-overdue-invoices', '5 0 * * *',
                     $$select public.mark_overdue_invoices()$$);
```

---

## 7. Views and aggregates

Last, because these read from everything above. Postgres does the arithmetic;
the client renders. Each function feeds one UI block.

All are `security invoker` (the default for functions), so the caller's RLS on
the underlying tables still applies and none of them can leak across
organisations.

### 7.1 `account_balances` view

Defined before the aggregates because `dashboard_stats()` selects from it.

```sql
create or replace view public.account_balances
with (security_invoker = on) as
select
  a.id            as account_id,
  a.organization_id,
  a.name,
  a.institution,
  a.type,
  a.currency,
  a.opening_balance + coalesce(sum(t.amount), 0) as balance,
  count(t.id)                                    as transaction_count,
  a.last_synced_at
from public.accounts a
left join public.transactions t
  on t.account_id = a.id
 and t.status <> 'failed'
where a.archived_at is null
group by a.id;
```

`security_invoker = on` is essential. Without it the view runs as its owner and
leaks every organisation's balances to everyone. With it, the caller's RLS on
`accounts` and `transactions` still applies.

### 7.2 Dashboard stat row

```sql
create or replace function public.dashboard_stats(org uuid)
returns table (
  net_cash             numeric,
  revenue_this_month   numeric,
  revenue_last_month   numeric,
  expenses_this_month  numeric,
  expenses_last_month  numeric,
  outstanding_invoices numeric,
  unpaid_count         bigint,
  overdue_count        bigint,
  account_count        bigint
)
language sql
stable
as $$
  with bounds as (
    select
      date_trunc('month', current_date)::date as this_start,
      (date_trunc('month', current_date) - interval '1 month')::date as last_start,
      (date_trunc('month', current_date) - interval '1 day')::date   as last_end
  )
  select
    (select coalesce(sum(balance), 0) from public.account_balances
      where organization_id = org),

    (select coalesce(sum(t.amount), 0) from public.transactions t, bounds b
      where t.organization_id = org and t.amount > 0
        and t.occurred_on >= b.this_start),

    (select coalesce(sum(t.amount), 0) from public.transactions t, bounds b
      where t.organization_id = org and t.amount > 0
        and t.occurred_on between b.last_start and b.last_end),

    (select coalesce(abs(sum(t.amount)), 0) from public.transactions t, bounds b
      where t.organization_id = org and t.amount < 0
        and t.occurred_on >= b.this_start),

    (select coalesce(abs(sum(t.amount)), 0) from public.transactions t, bounds b
      where t.organization_id = org and t.amount < 0
        and t.occurred_on between b.last_start and b.last_end),

    (select coalesce(sum(balance_due), 0) from public.invoices
      where organization_id = org and status in ('sent','overdue')),

    (select count(*) from public.invoices
      where organization_id = org and status in ('sent','overdue')),

    (select count(*) from public.invoices
      where organization_id = org and status = 'overdue'),

    (select count(*) from public.accounts
      where organization_id = org and archived_at is null);
$$;
```

The UI's percentage deltas come from comparing the this-month and last-month
columns client-side.

### 7.3 Cash flow chart

```sql
create or replace function public.cash_flow_by_month(org uuid, months int default 8)
returns table (
  month_start date,
  label       text,
  inflow      numeric,
  outflow     numeric
)
language sql
stable
as $$
  select
    date_trunc('month', t.occurred_on)::date            as month_start,
    to_char(date_trunc('month', t.occurred_on), 'Mon')  as label,
    coalesce(sum(t.amount) filter (where t.amount > 0), 0)      as inflow,
    coalesce(abs(sum(t.amount) filter (where t.amount < 0)), 0) as outflow
  from public.transactions t
  where t.organization_id = org
    and t.occurred_on >= (date_trunc('month', current_date)
                          - make_interval(months => months - 1))
    and t.status <> 'failed'
  group by 1, 2
  order by 1;
$$;
```

The chart normalises to 0–100 for bar heights — do that client-side from these
real figures rather than storing normalised values.

### 7.4 Invoice status buckets

```sql
create or replace function public.invoice_buckets(org uuid)
returns table (
  status invoice_status,
  amount numeric,
  count  bigint,
  share  numeric
)
language sql
stable
as $$
  with totals as (
    select status, sum(total) as amount, count(*) as count
    from public.invoices
    where organization_id = org
      and status in ('paid','sent','overdue')
    group by status
  )
  select
    t.status,
    t.amount,
    t.count,
    round(100.0 * t.amount / nullif(sum(t.amount) over (), 0), 1) as share
  from totals t
  order by array_position(array['paid','sent','overdue']::invoice_status[], t.status);
$$;
```

### 7.5 Invoice page stats

```sql
create or replace function public.invoice_stats(org uuid)
returns table (
  outstanding     numeric,
  unpaid_count    bigint,
  overdue         numeric,
  overdue_count   bigint,
  paid_this_month numeric,
  paid_count      bigint,
  avg_days_to_pay numeric
)
language sql
stable
as $$
  select
    (select coalesce(sum(balance_due), 0) from public.invoices
      where organization_id = org and status in ('sent','overdue')),
    (select count(*) from public.invoices
      where organization_id = org and status in ('sent','overdue')),
    (select coalesce(sum(balance_due), 0) from public.invoices
      where organization_id = org and status = 'overdue'),
    (select count(*) from public.invoices
      where organization_id = org and status = 'overdue'),
    (select coalesce(sum(total), 0) from public.invoices
      where organization_id = org and status = 'paid'
        and paid_at >= date_trunc('month', current_date)),
    (select count(*) from public.invoices
      where organization_id = org and status = 'paid'
        and paid_at >= date_trunc('month', current_date)),
    (select round(avg(paid_at::date - issue_date), 1) from public.invoices
      where organization_id = org and status = 'paid' and paid_at is not null);
$$;
```

### 7.6 Expense breakdown by category

`expense_stats()` below calls this one, so it comes first.

```sql
create or replace function public.expense_breakdown(org uuid, since date default null)
returns table (
  category_id uuid,
  label       text,
  amount      numeric,
  share       numeric
)
language sql
stable
as $$
  with scoped as (
    select
      e.category_id,
      coalesce(c.name, 'Uncategorised') as label,
      sum(e.amount) as amount
    from public.expenses e
    left join public.expense_categories c on c.id = e.category_id
    where e.organization_id = org
      and e.status in ('approved','reimbursed')
      and e.spent_on >= coalesce(since, date_trunc('month', current_date)::date)
    group by 1, 2
  )
  select
    s.category_id,
    s.label,
    s.amount,
    round(100.0 * s.amount / nullif(sum(s.amount) over (), 0), 1) as share
  from scoped s
  order by s.amount desc;
$$;
```

### 7.7 Expense page stats

```sql
create or replace function public.expense_stats(org uuid)
returns table (
  spent_this_month    numeric,
  expense_count       bigint,
  pending_amount      numeric,
  pending_count       bigint,
  reimbursable        numeric,
  reimbursable_people bigint,
  top_category        text,
  top_category_share  numeric
)
language sql
stable
as $$
  select
    (select coalesce(sum(amount), 0) from public.expenses
      where organization_id = org and status in ('approved','reimbursed')
        and spent_on >= date_trunc('month', current_date)),
    (select count(*) from public.expenses
      where organization_id = org
        and spent_on >= date_trunc('month', current_date)),
    (select coalesce(sum(amount), 0) from public.expenses
      where organization_id = org and status = 'pending'),
    (select count(*) from public.expenses
      where organization_id = org and status = 'pending'),
    (select coalesce(sum(amount), 0) from public.expenses
      where organization_id = org and reimbursable and status = 'approved'),
    (select count(distinct submitted_by) from public.expenses
      where organization_id = org and reimbursable and status = 'approved'),
    (select label from public.expense_breakdown(org) limit 1),
    (select share from public.expense_breakdown(org) limit 1);
$$;
```

### 7.8 Profit and loss

```sql
create or replace function public.profit_and_loss(org uuid, period_start date, period_end date)
returns table (
  line_item  text,
  amount     numeric,
  sort_order smallint,
  emphasis   boolean
)
language sql
stable
as $$
  with revenue as (
    select coalesce(sum(total), 0) as amount
    from public.invoices
    where organization_id = org
      and status in ('paid','sent','overdue')
      and issue_date between period_start and period_end
  ),
  costs as (
    select
      coalesce(c.name, 'Uncategorised') as category,
      sum(e.amount) as amount
    from public.expenses e
    left join public.expense_categories c on c.id = e.category_id
    where e.organization_id = org
      and e.status in ('approved','reimbursed')
      and e.spent_on between period_start and period_end
    group by 1
  )
  select 'Revenue', (select amount from revenue), 1::smallint, true
  union all
  select c.category, c.amount, 2::smallint, false from costs c
  union all
  select 'Total expenses', (select coalesce(sum(amount), 0) from costs), 3::smallint, true
  union all
  select 'Net profit',
         (select amount from revenue) - (select coalesce(sum(amount), 0) from costs),
         4::smallint, true
  order by sort_order, line_item;
$$;
```

For the prior-year comparison column, call it twice with shifted dates and join
client-side.

### 7.9 Revenue by stream

Groups on `invoice_items.stream`, declared in §3.7 — no `alter table` needed
here any more.

```sql
create or replace function public.revenue_by_stream(org uuid, period_start date, period_end date)
returns table (label text, amount numeric, share numeric)
language sql
stable
as $$
  with scoped as (
    select
      coalesce(ii.stream, 'Other income') as label,
      sum(ii.line_total) as amount
    from public.invoice_items ii
    join public.invoices i on i.id = ii.invoice_id
    where i.organization_id = org
      and i.status in ('paid','sent','overdue')
      and i.issue_date between period_start and period_end
    group by 1
  )
  select
    s.label,
    s.amount,
    round(100.0 * s.amount / nullif(sum(s.amount) over (), 0), 1)
  from scoped s
  order by s.amount desc;
$$;
```

### 7.10 Payroll stats

```sql
create or replace function public.payroll_stats(org uuid)
returns table (
  next_pay_date  date,
  monthly_gross  numeric,
  headcount      bigint,
  salaried_count bigint,
  contract_count bigint,
  taxes_due      numeric
)
language sql
stable
as $$
  select
    (select min(pay_date) from public.payroll_runs
      where organization_id = org and status in ('draft','pending')),
    (select coalesce(gross_total, 0) from public.payroll_runs
      where organization_id = org order by pay_date desc limit 1),
    (select count(*) from public.employees
      where organization_id = org and status = 'active'),
    (select count(*) from public.employees
      where organization_id = org and status = 'active' and employment_type = 'salaried'),
    (select count(*) from public.employees
      where organization_id = org and status = 'active' and employment_type = 'contract'),
    (select coalesce(sum(pi.paye_tax + pi.ssnit_employee + pi.ssnit_employer), 0)
      from public.payroll_items pi
      join public.payroll_runs r on r.id = pi.payroll_run_id
      where r.organization_id = org and r.status in ('draft','pending'));
$$;
```

---

## 8. Realtime and storage

### 8.1 Realtime

The transactions page subscribes to inserts as the bank feed writes them, which
needs the table added to the realtime publication. Realtime still respects RLS,
so a subscriber only ever receives rows they could already read:

```sql
alter publication supabase_realtime add table public.transactions;
```

There is no `if not exists` form, so a repeat run errors with "relation is
already member of publication". Guard it if you re-apply this section:

```sql
do $$ begin
  alter publication supabase_realtime add table public.transactions;
exception when duplicate_object then null;
end $$;
```

### 8.2 Buckets

```sql
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false),
       ('avatars',  'avatars',  true)
on conflict (id) do nothing;
```

### 8.3 Storage policies

These call `is_org_member()` from §4, which is why storage comes after it.

Receipts are private and keyed by organisation — path convention
`{organization_id}/{expense_id}/{filename}`:

```sql
create policy "receipts: org members read"
  on storage.objects for select
  using (
    bucket_id = 'receipts'
    and public.is_org_member(((storage.foldername(name))[1])::uuid)
  );

create policy "receipts: org members upload"
  on storage.objects for insert
  with check (
    bucket_id = 'receipts'
    and public.is_org_member(((storage.foldername(name))[1])::uuid)
  );

create policy "receipts: uploader deletes"
  on storage.objects for delete
  using (bucket_id = 'receipts' and owner = auth.uid());
```

Avatars are public-read, owner-write — path `{user_id}/{filename}`:

```sql
create policy "avatars: public read"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "avatars: own write"
  on storage.objects for all
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
```

---

## 9. Seed data

Enough rows to make every page render something real. Set `org` to your
organisation's id first.

```sql
do $$
declare
  org uuid := '00000000-0000-0000-0000-000000000000';  -- set me
  me  uuid := auth.uid();
  operating uuid;
  card uuid;
  client_northwind uuid;
begin
  insert into public.accounts (organization_id, name, institution, type, opening_balance)
  values (org, 'Operating — GCB', 'GCB Bank', 'bank', 182430.00)
  returning id into operating;

  insert into public.accounts (organization_id, name, institution, type, opening_balance)
  values (org, 'Card — Ecobank', 'Ecobank Ghana', 'card', 12280.00)
  returning id into card;

  insert into public.clients (organization_id, name, email, payment_terms)
  values (org, 'Northwind Ltd', 'ap@northwind.co', 14)
  returning id into client_northwind;

  insert into public.invoices (organization_id, client_id, number, status,
                               issue_date, due_date, subtotal, tax_total, total,
                               amount_paid, paid_at)
  values (org, client_northwind, 'INV-2205', 'paid',
          '2026-07-12', '2026-07-26', 7739.13, 1160.87, 8900.00, 8900.00, '2026-07-20');

  insert into public.transactions (organization_id, account_id, occurred_on,
                                   description, amount, status, reconciled)
  values
    (org, operating, '2026-07-29', 'Paystack payout',      12480.00, 'cleared', true),
    (org, card,      '2026-07-28', 'Amazon Web Services',  -1204.55, 'cleared', true),
    (org, operating, '2026-07-27', 'Northwind Ltd',         8900.00, 'cleared', true),
    (org, operating, '2026-07-26', 'Payroll — July',      -24310.00, 'cleared', true),
    (org, operating, '2026-07-21', 'Unidentified deposit',   640.00, 'needs_review', false);

  insert into public.expenses (organization_id, vendor, spent_on, amount,
                               method, method_detail, status, submitted_by)
  values
    (org, 'Amazon Web Services', '2026-07-28', 1204.55, 'card', 'Visa ·· 4412', 'approved', me),
    (org, 'MTN Ghana',           '2026-07-26',  842.30, 'mobile_money', 'MTN MoMo', 'pending', me);

  insert into public.employees (organization_id, full_name, role_title,
                                employment_type, pay_rate, started_on)
  values
    (org, 'Ada Mensah', 'Finance Lead',     'salaried', 5400.00, '2024-03-01'),
    (org, 'Kojo Baah',  'Product Designer', 'salaried', 4200.00, '2024-08-01'),
    (org, 'Efua Danso', 'Bookkeeper',       'contract',   45.00, '2026-02-01');
end $$;
```

---

## 10. Verification

### 10.1 Did every phase land?

Run this after §7. Any count short of the expected figure is a phase that did
not finish.

```sql
select
  (select count(*) from pg_type t
     join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'e')      as enums,      -- expect 9
  (select count(*) from pg_tables
    where schemaname = 'public')                         as tables,     -- expect 14
  (select count(*) from pg_policies
    where schemaname = 'public')                         as policies,   -- expect 30
  (select count(*) from pg_trigger tg
     join pg_class c on c.oid = tg.tgrelid
    where c.relnamespace = 'public'::regnamespace
      and not tg.tgisinternal)                           as triggers,   -- expect 12
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'is_org_member','has_org_role','my_org_ids','set_updated_at',
        'recalc_invoice_totals','recalc_payroll_totals','handle_new_user',
        'mark_overdue_invoices','dashboard_stats','cash_flow_by_month',
        'invoice_buckets','invoice_stats','expense_breakdown','expense_stats',
        'profit_and_loss','revenue_by_stream','payroll_stats'
      ))                                                 as functions,  -- expect 17
  (select count(*) from pg_views
    where schemaname = 'public'
      and viewname = 'account_balances')                 as views;      -- expect 1
```

The function count filters by name deliberately: `pg_trgm` installs a dozen of
its own functions into `public`, so an unfiltered `count(*)` tells you nothing.
`on_auth_user_created` sits on `auth.users`, not a `public` table, so it is not
in the trigger count — check it separately:

```sql
select tgname from pg_trigger
where tgrelid = 'auth.users'::regclass and not tgisinternal;
```

Tables with RLS enabled but **no** policy return nothing at all — a silent,
easy-to-miss failure. This finds them:

```sql
select c.relname
from pg_class c
left join pg_policies p on p.tablename = c.relname and p.schemaname = 'public'
where c.relnamespace = 'public'::regnamespace
  and c.relkind = 'r'
  and c.relrowsecurity
  and p.policyname is null;
```

### 10.2 Try to break the tenancy boundary

Never trust RLS you have not tried to break. Run this as a **second** user who
does not belong to the organisation:

```sql
set local role authenticated;
set local request.jwt.claims = '{"sub":"<other-user-uuid>","role":"authenticated"}';

-- Every one of these must return zero rows.
select count(*) from public.invoices;
select count(*) from public.transactions;
select count(*) from public.employees;
select count(*) from public.expenses;
select * from public.account_balances;

reset role;
```

### 10.3 Checklist before production

- [ ] Every public table has RLS on. This must return nothing:
      `select relname from pg_class where relrowsecurity = false and relnamespace = 'public'::regnamespace and relkind = 'r';`
- [ ] Every RLS-enabled table has at least one policy (§10.1)
- [ ] Every view touching org data has `security_invoker = on`
- [ ] Every `security definer` function sets `search_path = public`
- [ ] The anon key reads nothing — test signed out
- [ ] No service-role key anywhere in `src/`, and nothing secret carries a
      `VITE_` prefix; `VITE_`-prefixed values ship to every visitor's browser
- [ ] A `viewer` cannot approve an expense or read salary data
- [ ] Cross-organisation reads return **zero rows, not an error** — silence is
      the correct RLS behaviour

---

## 11. Starting over

If a half-applied run left the schema in a broken state, tear it down in reverse
dependency order and re-run §2 → §7. **This destroys all data.**

```sql
-- Triggers on auth.users are not dropped by dropping the public schema.
drop trigger if exists on_auth_user_created on auth.users;
select cron.unschedule('mark-overdue-invoices');   -- errors harmlessly if absent

drop schema public cascade;
create schema public;
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all routines  in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on routines to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
```

`drop schema public cascade` takes the enums *and* the two extensions with it
(both install into `public`), so §2 runs clean afterwards — the
`create extension if not exists` lines will genuinely re-create them.

Two things survive the drop and need handling by hand:

```sql
-- Storage policies live in the `storage` schema.
drop policy if exists "receipts: org members read"   on storage.objects;
drop policy if exists "receipts: org members upload" on storage.objects;
drop policy if exists "receipts: uploader deletes"   on storage.objects;
drop policy if exists "avatars: public read"         on storage.objects;
drop policy if exists "avatars: own write"           on storage.objects;

-- Buckets are rows, not schema objects. Delete the objects inside them first.
delete from storage.objects where bucket_id in ('receipts', 'avatars');
delete from storage.buckets where id      in ('receipts', 'avatars');
```

`auth.users` is **not** in the `public` schema, so existing accounts survive the
teardown — but their profiles, organisations and memberships do not, and
`handle_new_user()` only fires on *new* signups. Either delete the test users
(Dashboard → Authentication → Users) so signup runs again, or backfill by hand:

```sql
insert into public.profiles (id, full_name)
select id, coalesce(raw_user_meta_data->>'full_name', split_part(email, '@', 1))
from auth.users
on conflict (id) do nothing;
```

…then create an organisation and an `owner` membership row for each.

To keep the data and only retry a later phase, drop just that phase instead:

```sql
-- Re-run §5 from scratch
do $$
declare p record;
begin
  for p in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public'
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;
```

---

## Applying this

One migration per phase keeps failures isolated and re-runnable:

```bash
supabase migration new 01_enums        # §2
supabase migration new 02_tables       # §3
supabase migration new 03_helpers      # §4
supabase migration new 04_policies     # §5
supabase migration new 05_triggers     # §6
supabase migration new 06_aggregates   # §7
supabase migration new 07_storage      # §8
supabase db push
```

Or paste each section into **Dashboard → SQL Editor** and run them in order,
one section per execution — if one fails you know exactly which phase to fix
without re-running the ones that already succeeded.

Once applied, the portal reads from these tables through `src/services/`. If a
page reports a missing table or function, it names the section to run.
