-- Opening balances: what THIS employer paid and withheld in a tax year
-- before the client went live on the app (payroll run elsewhere), per
-- employee. Not a previous employer (employee_tax_years keeps that, with its
-- BIR Form 2316 semantics): these amounts belong in the present employer's
-- 2316 columns, in "taxes withheld as adjusted" and in the year's 13th month
-- and other-benefits exemption.
--
-- Amounts are gross, as the old payroll register shows them, by BIR Form
-- 2316 column. Employee contributions are entered on their own and carved
-- out of basic salary like the app's own payslips. 13th month pay and other
-- benefits are entered before the 90,000 exemption: the year's computation
-- applies the cap. Pay released on or before paid_through belongs to the
-- old payroll. Additive only: a new table, its triggers and policies.

create table public.employee_opening_balances (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete restrict,
  year int not null check (year between 2000 and 2100),
  -- the last pay date the old payroll covers (the tax year follows the pay date)
  paid_through date not null,
  -- paid as a minimum wage earner before go-live (SMW, holiday, OT, ND, hazard exempt)
  minimum_wage_earner boolean not null default false,
  -- regular compensation (2316 items 39-44, an MWE's SMW)
  basic_salary numeric(14,2) not null default 0 check (basic_salary >= 0),
  cola numeric(14,2) not null default 0 check (cola >= 0),
  representation numeric(14,2) not null default 0 check (representation >= 0),
  transportation numeric(14,2) not null default 0 check (transportation >= 0),
  housing numeric(14,2) not null default 0 check (housing >= 0),
  other_taxable_regular numeric(14,2) not null default 0 check (other_taxable_regular >= 0),
  -- supplementary compensation (2316 items 45-51)
  holiday_pay numeric(14,2) not null default 0 check (holiday_pay >= 0),
  premium_pay numeric(14,2) not null default 0 check (premium_pay >= 0),
  overtime_pay numeric(14,2) not null default 0 check (overtime_pay >= 0),
  night_diff numeric(14,2) not null default 0 check (night_diff >= 0),
  hazard_pay numeric(14,2) not null default 0 check (hazard_pay >= 0),
  commission numeric(14,2) not null default 0 check (commission >= 0),
  profit_sharing numeric(14,2) not null default 0 check (profit_sharing >= 0),
  fees numeric(14,2) not null default 0 check (fees >= 0),
  other_supplementary numeric(14,2) not null default 0 check (other_supplementary >= 0),
  -- benefits and non-taxable pay
  thirteenth_month numeric(14,2) not null default 0 check (thirteenth_month >= 0),
  other_benefits numeric(14,2) not null default 0 check (other_benefits >= 0),
  de_minimis numeric(14,2) not null default 0 check (de_minimis >= 0),
  other_non_taxable numeric(14,2) not null default 0 check (other_non_taxable >= 0),
  -- employee SSS, PhilHealth and Pag-IBIG shares and union dues
  contributions numeric(14,2) not null default 0 check (contributions >= 0),
  -- tax withheld as adjusted by the old payroll (net of any refund)
  tax_withheld numeric(14,2) not null default 0 check (tax_withheld >= 0),
  -- basic salary earned in the calendar year, for the 13th month (PD 851)
  thirteenth_basis numeric(14,2) not null default 0 check (thirteenth_basis >= 0),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, year),
  constraint employee_opening_balances_paid_through_year check (extract(year from paid_through)::int = year)
);
create index employee_opening_balances_entity_year on public.employee_opening_balances (entity_id, year);

create trigger employee_opening_balances_updated_at before update on public.employee_opening_balances
  for each row execute function public.set_updated_at();
-- the client comes from the employee, never from the caller
create trigger employee_opening_balances_entity before insert or update on public.employee_opening_balances
  for each row execute function public.assign_entity_from_employee();
-- drafts of the employee read them (year to date): recompute after a change
create trigger employee_opening_balances_stale after insert or update or delete on public.employee_opening_balances
  for each row execute function public.stale_drafts_on_change();
create trigger audit_employee_opening_balances after insert or update or delete on public.employee_opening_balances
  for each row execute function public.audit_trigger();

-- the client's admins only: employees see their pay through payslips
alter table public.employee_opening_balances enable row level security;
create policy "employee_opening_balances: admins manage" on public.employee_opening_balances
  for all to authenticated
  using (public.can_manage_employee(employee_id)) with check (public.can_manage_employee(employee_id));
revoke all on public.employee_opening_balances from anon;
