-- C9 (compliance update 2026-10-25): filing and payment due dates per
-- client. The app computes the calendar from the rules and their sources
-- (BIR 1601-C, 1604-C and 2316, SSS, PhilHealth by employer number), and
-- each client can replace a date for a year (agencies issue extensions).
-- Pag-IBIG's due date is entered by the client (open item O4).
alter table public.entities
  add column if not exists bir_filing_method text not null default 'manual'
    constraint entities_bir_filing_method_check check (bir_filing_method in ('manual', 'efps')),
  add column if not exists efps_group text
    constraint entities_efps_group_check check (efps_group in ('A', 'B', 'C', 'D', 'E')),
  add column if not exists pagibig_due_day smallint
    constraint entities_pagibig_due_day_check check (pagibig_due_day between 1 and 31);

create table if not exists public.filing_due_dates (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  filing text not null check (filing in ('1601c', 'sss', 'philhealth', 'pagibig', 'refunds', '2316_employees', '1604c', '2316_bir')),
  -- the month a monthly filing covers, or 1 January of the tax year for a year-end filing
  period date not null check (period = date_trunc('month', period)::date),
  due_date date not null,
  note text not null default '' check (length(note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, filing, period)
);

alter table public.filing_due_dates enable row level security;
create policy "filing_due_dates: admins manage" on public.filing_due_dates
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
revoke all on public.filing_due_dates from anon;

create trigger filing_due_dates_updated_at before update on public.filing_due_dates
  for each row execute function public.set_updated_at();
create trigger audit_filing_due_dates
  after insert or update or delete on public.filing_due_dates
  for each row execute function public.audit_trigger();
