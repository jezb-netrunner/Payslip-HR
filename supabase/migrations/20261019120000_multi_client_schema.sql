-- ============================================================
-- Multi-client restructure, part 1: schema.
--
-- One deployment now serves many CLIENTS (employer entities), with three
-- access tiers on profiles.role:
--   company_admin — operator staff: every client, statutory tables,
--                   global holidays, user management
--   entity_admin  — a client's payroll/HR staff: assigned client(s) only
--   employee      — signs in with an admin-issued login code
-- Every HR/payroll row belongs to exactly one entity. Time in/out is now
-- entered by admins: the employee self-punch flow (selfies, device
-- fingerprints, geolocation, IP capture) is removed. Adds per-employee pay
-- policy, cash net-pay rounding, separation details, BIR 1604-C/alphalist
-- data, announcements, 1601-C remittance records and per-run adjustments.
-- Applied on a database holding only reference data and the owner's
-- account (no HR/payroll rows existed to migrate).
-- ============================================================

-- ---------- retire the single-entity security layer ----------
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

drop policy if exists "punch selfies: employee upload own folder" on storage.objects;
drop policy if exists "punch selfies: read own or admin" on storage.objects;
drop policy if exists "punch selfies: admin delete" on storage.objects;
drop policy if exists "employee photos: read" on storage.objects;
drop policy if exists "employee photos: admin insert" on storage.objects;
drop policy if exists "employee photos: admin update" on storage.objects;
drop policy if exists "employee photos: admin delete" on storage.objects;

drop function if exists public.clock_in(text, jsonb, jsonb);
drop function if exists public.clock_out(text, jsonb, jsonb);
drop function if exists public.validate_punch_selfie(text, uuid);
drop function if exists public.request_ip();
drop function if exists public.is_admin();

drop trigger if exists profiles_protect_admins on public.profiles;
drop table if exists public.company_settings;

-- ---------- clients (employer entities / BIR withholding agents) ----------
create table public.entities (
  id uuid primary key default gen_random_uuid(),
  -- prefix of every employee login code of this client; immutable
  code text not null unique check (code ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name text not null check (length(trim(name)) > 0),   -- registered name
  trade_name text not null default '',
  tin text not null default ''
    check (tin = '' or tin ~ '^[0-9]{3}-?[0-9]{3}-?[0-9]{3}$'),
  tin_branch_code text not null default '00000' check (tin_branch_code ~ '^[0-9]{3,5}$'),
  rdo_code text not null default '',
  registered_address text not null default '',
  zip_code text not null default '',
  contact_number text not null default '',
  contact_email text not null default '',
  withholding_agent_category text not null default 'private'
    check (withholding_agent_category in ('private','government')),
  is_top_withholding_agent boolean not null default false,
  sss_employer_no text not null default '',
  philhealth_employer_no text not null default '',
  pagibig_employer_no text not null default '',
  -- payroll policy (defaults; several are overridable per employee)
  default_pay_frequency text not null default 'semi_monthly'
    check (default_pay_frequency in ('weekly','semi_monthly','monthly')),
  minimum_wage_region text not null default '',
  minimum_wage_daily numeric(10,2) not null default 0 check (minimum_wage_daily >= 0),
  minimum_wage_reference text not null default '',
  standard_hours_per_day numeric(4,2) not null default 8
    check (standard_hours_per_day > 0 and standard_hours_per_day <= 24),
  working_days_divisor numeric(6,2) not null default 261
    check (working_days_divisor > 0 and working_days_divisor <= 366),
  grace_period_minutes int not null default 0 check (grace_period_minutes between 0 and 240),
  -- Labor Code Art. 86: at least 10% for 10pm-6am work
  night_diff_rate numeric(5,4) not null default 0.10 check (night_diff_rate >= 0.10 and night_diff_rate <= 1),
  contribution_deduction_timing text not null default 'split'
    check (contribution_deduction_timing in ('split','first_period','last_period')),
  net_pay_rounding text not null default 'none'
    check (net_pay_rounding in ('none','round_up','carry_forward')),
  rounding_scope text not null default 'cash_only' check (rounding_scope in ('cash_only','all')),
  pay_date_lag_days int not null default 5 check (pay_date_lag_days between 0 and 31),
  payslip_footer_note text not null
    default 'This is a system-generated payslip and does not require a signature.',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger entities_updated_at before update on public.entities
  for each row execute function public.set_updated_at();

create table public.entity_admins (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, entity_id)
);
create index entity_admins_entity_idx on public.entity_admins (entity_id);

-- ---------- profiles: three access tiers ----------
alter table public.profiles drop constraint if exists profiles_role_check;
update public.profiles set role = 'company_admin' where role = 'admin';
alter table public.profiles
  add constraint profiles_role_check check (role in ('company_admin','entity_admin','employee')),
  -- only employee logins link to an employee record
  add constraint profiles_employee_link_check check (role = 'employee' or employee_id is null);

-- ---------- employees: per-client, per-employee pay policy, BIR data ----------
alter table public.employees drop constraint if exists employees_employee_no_key;
alter table public.employees drop constraint if exists employees_email_key;
alter table public.employees drop constraint if exists employees_employment_status_check;
alter table public.employees
  add column entity_id uuid not null references public.entities(id) on delete restrict,
  add column pay_frequency text not null default 'semi_monthly'
    check (pay_frequency in ('weekly','semi_monthly','monthly')),
  -- days-per-year factor override (e.g. 313 for a 6-day week); null = client default
  add column days_per_year numeric(6,2) check (days_per_year is null or (days_per_year > 0 and days_per_year <= 366)),
  add column payment_method text not null default 'cash'
    check (payment_method in ('cash','bank_transfer','e_wallet','check')),
  add column separation_reason text
    check (separation_reason in ('resignation','termination','end_of_contract','retirement','death','transfer','other')),
  add column separation_remarks text,
  add column nationality text not null default 'Filipino',
  add column zip_code text,
  -- login code itself is never stored: only its last characters for reference
  add column login_code_hint text,
  add column login_code_set_at timestamptz,
  -- centavos owed to the employee under carry-forward net-pay rounding
  add column rounding_balance numeric(6,2) not null default 0
    check (rounding_balance >= 0 and rounding_balance < 1);
alter table public.employees alter column email drop not null;
alter table public.employees
  add constraint employees_employment_status_check check (employment_status in
    ('regular','probationary','casual','contractual','project_based','seasonal','apprentice')),
  add constraint employees_entity_employee_no_key unique (entity_id, employee_no),
  add constraint employees_separation_check check ((separation_date is null) = (separation_reason is null)),
  add constraint employees_separation_after_hire check (separation_date is null or separation_date >= hire_date),
  add constraint employees_tin_format check
    (tin is null or tin = '' or tin ~ '^[0-9]{3}-?[0-9]{3}-?[0-9]{3}(-?[0-9]{3,5})?$');
create unique index employees_entity_email_uidx on public.employees (entity_id, lower(email))
  where email is not null and email <> '';
create index employees_entity_idx on public.employees (entity_id, last_name);

-- ---------- allowances: BIR category + basis ----------
alter table public.employee_allowances rename column monthly_amount to amount;
alter table public.employee_allowances
  drop column taxable,
  drop column de_minimis,
  add column category text not null default 'other_taxable' check (category in
    ('de_minimis','other_benefits','hazard','representation','transportation','cola','housing',
     'other_taxable','other_non_taxable')),
  -- monthly: split across the pay periods of the month; per_period: every
  -- payroll; per_day: per paid day (days worked + paid leave + paid holidays)
  add column basis text not null default 'monthly' check (basis in ('monthly','per_period','per_day')),
  add constraint employee_allowances_amount_check check (amount >= 0);

alter table public.recurring_deductions drop constraint if exists recurring_deductions_category_check;
alter table public.recurring_deductions add constraint recurring_deductions_category_check
  check (category in ('sss_loan','pagibig_loan','company_loan','cash_advance','hmo','union_dues','other'));

-- ---------- time entries: admin-entered only ----------
alter table public.time_entries
  drop column clock_in_selfie_path,
  drop column clock_out_selfie_path,
  drop column clock_in_ip,
  drop column clock_out_ip,
  drop column clock_in_device,
  drop column clock_out_device,
  drop column clock_in_location,
  drop column clock_out_location,
  add column entity_id uuid not null references public.entities(id) on delete restrict;
alter table public.time_entries drop constraint if exists time_entries_source_check;
alter table public.time_entries alter column source set default 'admin';
alter table public.time_entries
  add constraint time_entries_source_check check (source in ('admin','import','correction')),
  add constraint time_entries_duration_check
    check (clock_out is null or (clock_out > clock_in and clock_out - clock_in <= interval '24 hours'));
create index time_entries_entity_date_idx on public.time_entries (entity_id, work_date desc);

alter table public.time_correction_requests
  add column entity_id uuid not null references public.entities(id) on delete restrict;
create index tcr_entity_idx on public.time_correction_requests (entity_id, status);

-- ---------- leaves: per-client leave types (global rows = templates) ----------
alter table public.leave_types drop constraint if exists leave_types_code_key;
alter table public.leave_types
  add column entity_id uuid references public.entities(id) on delete cascade,
  add constraint leave_types_entity_code_key unique nulls not distinct (entity_id, code);

alter table public.leave_requests
  add column entity_id uuid not null references public.entities(id) on delete restrict;
create index leave_requests_entity_idx on public.leave_requests (entity_id, status);

-- ---------- holidays: national (entity_id null) + client-local ----------
alter table public.holidays drop constraint if exists holidays_holiday_date_name_key;
alter table public.holidays
  add column entity_id uuid references public.entities(id) on delete cascade,
  add constraint holidays_entity_date_name_key unique nulls not distinct (entity_id, holiday_date, name);

-- ---------- payroll runs: per client and pay frequency ----------
alter table public.payroll_runs drop constraint if exists payroll_runs_run_type_check;
alter table public.payroll_runs
  add column entity_id uuid not null references public.entities(id) on delete restrict,
  add column pay_frequency text check (pay_frequency in ('weekly','semi_monthly','monthly')),
  -- payroll month (1st of month) the run belongs to for contributions and
  -- BIR reporting; period_index of periods_in_month allocates monthly
  -- amounts (basic of monthly-rated, allowances, contributions)
  add column period_month date not null,
  add column period_index int not null default 1,
  add column periods_in_month int not null default 1,
  -- optional subset of employees (final pay, special runs)
  add column employee_ids uuid[],
  -- year-end / separation annualization: withholding in this run becomes
  -- annual tax due minus tax already withheld (refund when negative)
  add column annualize boolean not null default false;
alter table public.payroll_runs
  add constraint payroll_runs_run_type_check
    check (run_type in ('regular','thirteenth_month','special','final_pay')),
  add constraint payroll_runs_period_month_check
    check (period_month = date_trunc('month', period_month)::date),
  add constraint payroll_runs_frequency_check check (
    case
      when run_type = 'thirteenth_month' then
        pay_frequency is null and period_index = 1 and periods_in_month = 1 and not annualize
      else
        pay_frequency is not null
        and period_index between 1 and periods_in_month
        and ((pay_frequency = 'monthly' and periods_in_month = 1)
          or (pay_frequency = 'semi_monthly' and periods_in_month = 2)
          or (pay_frequency = 'weekly' and periods_in_month between 4 and 5))
    end);
-- one regular run per client, frequency and slot of the month
create unique index payroll_runs_regular_slot_uidx
  on public.payroll_runs (entity_id, pay_frequency, period_month, period_index)
  where run_type = 'regular';
create index payroll_runs_entity_idx on public.payroll_runs (entity_id, period_start desc);

alter table public.payslips
  add column entity_id uuid not null references public.entities(id) on delete restrict,
  add column period_month date,
  add column pay_frequency text,
  add column payment_method text,
  add column is_minimum_wage_earner boolean not null default false,
  add column union_dues numeric(12,2) not null default 0,
  -- net_pay = gross_pay - total_deductions + rounding_adjustment
  add column rounding_adjustment numeric(8,2) not null default 0,
  add column rounding_carry_in numeric(6,2) not null default 0,
  add column rounding_carry_out numeric(6,2) not null default 0;
create index payslips_entity_month_idx on public.payslips (entity_id, period_month);

-- one-time earnings/deductions for a specific run (corrections, bonuses,
-- final-pay extras); locked with the run
create table public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete restrict,
  kind text not null check (kind in ('earning','deduction')),
  label text not null check (length(trim(label)) between 1 and 120),
  amount numeric(12,2) not null check (amount > 0),
  -- earnings: BIR bucket; deductions: 'union_dues' or 'other'
  category text not null default 'other_taxable' check (category in
    ('basic','holiday','overtime','night_diff','hazard','other_benefits','de_minimis','representation',
     'transportation','cola','housing','other_taxable','other_non_taxable','union_dues','other')),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index payroll_adjustments_run_idx on public.payroll_adjustments (payroll_run_id, employee_id);

-- ---------- audit log: client scope + actor email ----------
alter table public.audit_logs rename column entity to table_name;
alter table public.audit_logs rename column entity_id to record_id;
alter table public.audit_logs
  add column entity_id uuid,
  add column actor_email text;
drop index if exists public.audit_logs_entity_idx;
create index audit_logs_record_idx on public.audit_logs (table_name, record_id);
create index audit_logs_entity_created_idx on public.audit_logs (entity_id, created_at desc);

-- ---------- announcements (entity admins -> employee portal) ----------
create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  body text not null default '',
  pinned boolean not null default false,
  published_at timestamptz not null default now(),
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or expires_at > published_at)
);
create trigger announcements_updated_at before update on public.announcements
  for each row execute function public.set_updated_at();
create index announcements_entity_idx on public.announcements (entity_id, published_at desc);

-- ---------- BIR 1601-C monthly remittances (feeds 1604-C Part II) ----------
create table public.tax_remittances (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  date_paid date,
  bank_or_agency text not null default '',   -- drawee bank / bank code / agency
  reference_no text not null default '',     -- TRA / eROR / eAR number
  taxes_withheld numeric(14,2) not null default 0,
  adjustment numeric(14,2) not null default 0,
  penalties numeric(14,2) not null default 0,
  total_remitted numeric(14,2) generated always as (taxes_withheld + adjustment + penalties) stored,
  remarks text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, period_month)
);
create trigger tax_remittances_updated_at before update on public.tax_remittances
  for each row execute function public.set_updated_at();

-- ---------- per-employee, per-year BIR data (previous employer, PERA) ----------
-- Figures come from the previous employer's BIR Form 2316 for employees
-- hired during the year; used for annualization and alphalist schedules.
create table public.employee_tax_years (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete restrict,
  year int not null check (year between 2000 and 2100),
  has_previous_employer boolean not null default false,
  prev_employer_tin text not null default '',
  prev_employer_name text not null default '',
  prev_employer_address text not null default '',
  prev_employer_zip text not null default '',
  prev_employment_from date,
  prev_employment_to date,
  prev_mwe_exempt numeric(14,2) not null default 0,              -- SMW, holiday, OT, ND, hazard pay of an MWE
  prev_13th_other_benefits_exempt numeric(14,2) not null default 0,
  prev_de_minimis numeric(14,2) not null default 0,
  prev_contributions numeric(14,2) not null default 0,           -- SSS/PHIC/HDMF EE + union dues
  prev_other_non_taxable numeric(14,2) not null default 0,
  prev_taxable_basic numeric(14,2) not null default 0,
  prev_taxable_13th_other_benefits numeric(14,2) not null default 0,
  prev_taxable_other numeric(14,2) not null default 0,
  prev_tax_withheld numeric(14,2) not null default 0,
  pera_tax_credit numeric(14,2) not null default 0,
  substituted_filing text not null default 'auto' check (substituted_filing in ('auto','yes','no')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, year)
);
create trigger employee_tax_years_updated_at before update on public.employee_tax_years
  for each row execute function public.set_updated_at();
