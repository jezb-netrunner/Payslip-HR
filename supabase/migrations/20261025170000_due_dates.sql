-- Spec T9 (payroll tax rules spec, 2026-10-25): the due-date calendar.
--
-- Each client records how it files with the BIR (manual or eBIRForms, or
-- eFPS with its filing group A to E), which sets its 1601-C dates. SSS,
-- PhilHealth and Pag-IBIG schedules are pending (P6): a day of the next
-- month per agency, with no default. Dates never move for weekends or
-- holidays (P8). The user overrides a date, with a note, in
-- due_date_overrides (an obligation of a month, or of a tax year on its
-- January 1). Existing clients start with no filing mode, so no 1601-C date
-- is shown until one is chosen.

alter table public.entities
  add column filing_mode text
    constraint entities_filing_mode_check check (filing_mode in ('manual_or_ebirforms', 'efps')),
  add column efps_group text
    constraint entities_efps_group_check check (efps_group in ('A', 'B', 'C', 'D', 'E')),
  add column sss_due_day smallint
    constraint entities_sss_due_day_check check (sss_due_day between 1 and 31),
  add column philhealth_due_day smallint
    constraint entities_philhealth_due_day_check check (philhealth_due_day between 1 and 31),
  add column pagibig_due_day smallint
    constraint entities_pagibig_due_day_check check (pagibig_due_day between 1 and 31),
  add constraint entities_efps_group_required check (filing_mode is distinct from 'efps' or efps_group is not null);

create table public.due_date_overrides (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id) on delete cascade,
  obligation text not null
    constraint due_date_overrides_obligation_check
      check (obligation in ('1601c', 'sss', 'philhealth', 'pagibig', 'yea_refund', '2316_employees', '1604c', '2316_duplicates')),
  -- the month covered, or January 1 of the tax year for the annual dates
  period date not null constraint due_date_overrides_period_check check (extract(day from period) = 1),
  due_date date not null,
  note text not null constraint due_date_overrides_note_check check (length(trim(note)) between 1 and 500),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint due_date_overrides_once unique (entity_id, obligation, period),
  constraint due_date_overrides_annual check (
    obligation in ('1601c', 'sss', 'philhealth', 'pagibig') or extract(month from period) = 1)
);
create trigger due_date_overrides_updated_at before update on public.due_date_overrides
  for each row execute function public.set_updated_at();
create trigger audit_due_date_overrides after insert or update or delete on public.due_date_overrides
  for each row execute function public.audit_trigger();
alter table public.due_date_overrides enable row level security;
create policy "due date overrides: client admins" on public.due_date_overrides for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
revoke all on public.due_date_overrides from anon;
