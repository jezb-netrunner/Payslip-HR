-- ============================================================
-- Payslip-HR: core tables for single-entity PH HR & Payroll
-- ============================================================

-- ---------- updated_at helper ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

-- ---------- employees (HR master data) ----------
create table public.employees (
  id uuid primary key default gen_random_uuid(),
  employee_no text not null unique,
  first_name text not null,
  middle_name text,
  last_name text not null,
  suffix text,
  email text not null unique,
  phone text,
  address text,
  birth_date date,
  gender text,
  civil_status text,
  photo_url text,
  tin text,
  sss_no text,
  philhealth_no text,
  pagibig_no text,
  hire_date date not null,
  regularization_date date,
  separation_date date,
  employment_status text not null default 'probationary'
    check (employment_status in ('probationary','regular','contractual','project_based','part_time','resigned','terminated','retired')),
  position text not null default '',
  department text not null default '',
  pay_type text not null default 'monthly' check (pay_type in ('monthly','daily')),
  monthly_rate numeric(14,2) not null default 0,
  daily_rate numeric(14,2) not null default 0,
  is_minimum_wage_earner boolean not null default false,
  work_schedule jsonb not null default '{"days":[1,2,3,4,5],"start":"09:00","end":"18:00","break_minutes":60}'::jsonb,
  bank_name text,
  bank_account_no text,
  emergency_contact_name text,
  emergency_contact_phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger employees_updated_at before update on public.employees
  for each row execute function public.set_updated_at();

-- ---------- profiles (auth link + role) ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  employee_id uuid unique references public.employees(id) on delete set null,
  role text not null default 'employee' check (role in ('admin','employee')),
  email text,
  full_name text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------- career history ----------
create table public.career_events (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  event_type text not null check (event_type in
    ('hired','regularized','promoted','transferred','salary_adjustment','disciplinary','recognition','separated','other')),
  effective_date date not null,
  position text,
  department text,
  monthly_rate numeric(14,2),
  daily_rate numeric(14,2),
  details text not null default '',
  created_by uuid,
  created_at timestamptz not null default now()
);
create index career_events_employee_idx on public.career_events (employee_id, effective_date desc);

-- ---------- allowances & recurring deductions ----------
create table public.employee_allowances (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  label text not null,
  monthly_amount numeric(12,2) not null,
  taxable boolean not null default true,
  de_minimis boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index employee_allowances_employee_idx on public.employee_allowances (employee_id);

create table public.recurring_deductions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  label text not null,
  category text not null default 'other'
    check (category in ('sss_loan','pagibig_loan','company_loan','cash_advance','hmo','other')),
  amount_per_period numeric(12,2) not null,
  total_amount numeric(12,2),
  balance numeric(12,2),
  start_date date,
  end_date date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger recurring_deductions_updated_at before update on public.recurring_deductions
  for each row execute function public.set_updated_at();
create index recurring_deductions_employee_idx on public.recurring_deductions (employee_id);

-- ---------- time & attendance ----------
create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  work_date date not null,
  clock_in timestamptz not null,
  clock_out timestamptz,
  clock_in_selfie_path text,
  clock_out_selfie_path text,
  clock_in_ip text,
  clock_out_ip text,
  clock_in_device jsonb,
  clock_out_device jsonb,
  clock_in_location jsonb,
  clock_out_location jsonb,
  source text not null default 'web' check (source in ('web','kiosk','admin','import')),
  status text not null default 'open' check (status in ('open','closed')),
  flags text[] not null default '{}',
  admin_notes text,
  manually_edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger time_entries_updated_at before update on public.time_entries
  for each row execute function public.set_updated_at();
create index time_entries_employee_date_idx on public.time_entries (employee_id, work_date desc);
create index time_entries_date_idx on public.time_entries (work_date desc);
create unique index time_entries_one_open_per_employee on public.time_entries (employee_id)
  where clock_out is null;

create table public.time_correction_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  time_entry_id uuid references public.time_entries(id) on delete set null,
  work_date date not null,
  requested_clock_in timestamptz,
  requested_clock_out timestamptz,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger time_correction_requests_updated_at before update on public.time_correction_requests
  for each row execute function public.set_updated_at();
create index tcr_employee_idx on public.time_correction_requests (employee_id, status);

-- ---------- leaves ----------
create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  default_annual_days numeric(5,2) not null default 0,
  paid boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.employee_leave_entitlements (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on delete cascade,
  year int not null,
  days numeric(5,2) not null,
  created_at timestamptz not null default now(),
  unique (employee_id, leave_type_id, year)
);

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on delete restrict,
  start_date date not null,
  end_date date not null,
  days numeric(5,2) not null,
  reason text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create trigger leave_requests_updated_at before update on public.leave_requests
  for each row execute function public.set_updated_at();
create index leave_requests_employee_idx on public.leave_requests (employee_id, status);

-- ---------- company settings (singleton) ----------
create table public.company_settings (
  id smallint primary key default 1 check (id = 1),
  company_name text not null default 'My Company',
  address text not null default '',
  tin text not null default '',
  rdo_code text not null default '',
  sss_employer_no text not null default '',
  philhealth_employer_no text not null default '',
  pagibig_employer_no text not null default '',
  logo_url text,
  timezone text not null default 'Asia/Manila',
  currency text not null default 'PHP',
  pay_frequency text not null default 'semi_monthly' check (pay_frequency in ('semi_monthly','monthly')),
  minimum_wage_daily numeric(10,2) not null default 695.00,
  minimum_wage_region text not null default 'NCR (non-agriculture)',
  standard_hours_per_day numeric(4,2) not null default 8,
  working_days_divisor numeric(6,2) not null default 261,
  grace_period_minutes int not null default 0,
  night_diff_rate numeric(5,4) not null default 0.10,
  contribution_deduction_timing text not null default 'split'
    check (contribution_deduction_timing in ('split','first_half','second_half')),
  require_selfie_on_punch boolean not null default true,
  require_location_on_punch boolean not null default false,
  payslip_footer_note text not null default 'This is a system-generated payslip and does not require a signature.',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger company_settings_updated_at before update on public.company_settings
  for each row execute function public.set_updated_at();
insert into public.company_settings (id) values (1);

-- ---------- statutory tables (versioned by effective date) ----------
create table public.statutory_versions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('sss','philhealth','pagibig','bir_wht','bir_annual')),
  effective_from date not null,
  effective_to date,
  description text not null default '',
  source_url text,
  data jsonb not null,
  created_at timestamptz not null default now(),
  unique (kind, effective_from)
);

-- ---------- holidays ----------
create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null,
  name text not null,
  kind text not null check (kind in ('regular','special_non_working','special_working')),
  created_at timestamptz not null default now(),
  unique (holiday_date, name)
);
create index holidays_date_idx on public.holidays (holiday_date);

-- ---------- payroll ----------
create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null default 'regular'
    check (run_type in ('regular','thirteenth_month','special','final_pay')),
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  status text not null default 'draft' check (status in ('draft','finalized','paid')),
  notes text not null default '',
  totals jsonb not null default '{}'::jsonb,
  created_by uuid,
  finalized_by uuid,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start)
);
create trigger payroll_runs_updated_at before update on public.payroll_runs
  for each row execute function public.set_updated_at();
create index payroll_runs_period_idx on public.payroll_runs (period_start desc);

create table public.payslips (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete restrict,
  employee_snapshot jsonb not null default '{}'::jsonb,
  days_worked numeric(6,2) not null default 0,
  hours_worked numeric(8,2) not null default 0,
  overtime_hours numeric(8,2) not null default 0,
  night_diff_hours numeric(8,2) not null default 0,
  late_minutes numeric(8,0) not null default 0,
  undertime_minutes numeric(8,0) not null default 0,
  absent_days numeric(6,2) not null default 0,
  earnings jsonb not null default '[]'::jsonb,
  deductions jsonb not null default '[]'::jsonb,
  basic_pay numeric(14,2) not null default 0,
  gross_pay numeric(14,2) not null default 0,
  taxable_income numeric(14,2) not null default 0,
  sss_ee numeric(12,2) not null default 0,
  sss_er numeric(12,2) not null default 0,
  sss_ec_er numeric(12,2) not null default 0,
  sss_mpf_ee numeric(12,2) not null default 0,
  sss_mpf_er numeric(12,2) not null default 0,
  philhealth_ee numeric(12,2) not null default 0,
  philhealth_er numeric(12,2) not null default 0,
  pagibig_ee numeric(12,2) not null default 0,
  pagibig_er numeric(12,2) not null default 0,
  withholding_tax numeric(14,2) not null default 0,
  other_deductions_total numeric(14,2) not null default 0,
  total_deductions numeric(14,2) not null default 0,
  net_pay numeric(14,2) not null default 0,
  computation_trace jsonb not null default '{}'::jsonb,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payroll_run_id, employee_id)
);
create trigger payslips_updated_at before update on public.payslips
  for each row execute function public.set_updated_at();
create index payslips_employee_idx on public.payslips (employee_id);

-- ---------- audit log ----------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity, entity_id);
