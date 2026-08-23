-- ============================================================
-- Row Level Security
-- Admin: full control. Employee: read own data only.
-- Time entries are NEVER writable directly by employees —
-- punches go through security-definer RPCs bound to auth.uid().
-- ============================================================

alter table public.employees enable row level security;
alter table public.profiles enable row level security;
alter table public.career_events enable row level security;
alter table public.employee_allowances enable row level security;
alter table public.recurring_deductions enable row level security;
alter table public.time_entries enable row level security;
alter table public.time_correction_requests enable row level security;
alter table public.leave_types enable row level security;
alter table public.employee_leave_entitlements enable row level security;
alter table public.leave_requests enable row level security;
alter table public.company_settings enable row level security;
alter table public.statutory_versions enable row level security;
alter table public.holidays enable row level security;
alter table public.payroll_runs enable row level security;
alter table public.payslips enable row level security;
alter table public.audit_logs enable row level security;

-- ---------- profiles ----------
create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles: admin read all" on public.profiles
  for select to authenticated using (public.is_admin());
create policy "profiles: admin update" on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "profiles: admin delete" on public.profiles
  for delete to authenticated using (public.is_admin());

-- ---------- employees ----------
create policy "employees: admin all" on public.employees
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "employees: read own record" on public.employees
  for select to authenticated using (id = public.current_employee_id());

-- ---------- career_events ----------
create policy "career_events: admin all" on public.career_events
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "career_events: read own" on public.career_events
  for select to authenticated using (employee_id = public.current_employee_id());

-- ---------- employee_allowances ----------
create policy "allowances: admin all" on public.employee_allowances
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "allowances: read own" on public.employee_allowances
  for select to authenticated using (employee_id = public.current_employee_id());

-- ---------- recurring_deductions ----------
create policy "recurring_deductions: admin all" on public.recurring_deductions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "recurring_deductions: read own" on public.recurring_deductions
  for select to authenticated using (employee_id = public.current_employee_id());

-- ---------- time_entries ----------
-- Employees get NO direct insert/update/delete: punching happens only via
-- clock_in()/clock_out() RPCs which derive the employee from auth.uid().
create policy "time_entries: admin all" on public.time_entries
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "time_entries: read own" on public.time_entries
  for select to authenticated using (employee_id = public.current_employee_id());

-- ---------- time_correction_requests ----------
create policy "tcr: admin all" on public.time_correction_requests
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "tcr: read own" on public.time_correction_requests
  for select to authenticated using (employee_id = public.current_employee_id());
create policy "tcr: file own" on public.time_correction_requests
  for insert to authenticated
  with check (employee_id = public.current_employee_id() and status = 'pending');
create policy "tcr: cancel own pending" on public.time_correction_requests
  for update to authenticated
  using (employee_id = public.current_employee_id() and status = 'pending')
  with check (employee_id = public.current_employee_id() and status in ('pending','cancelled'));

-- ---------- leave_types ----------
create policy "leave_types: read all" on public.leave_types
  for select to authenticated using (true);
create policy "leave_types: admin write" on public.leave_types
  for insert to authenticated with check (public.is_admin());
create policy "leave_types: admin update" on public.leave_types
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "leave_types: admin delete" on public.leave_types
  for delete to authenticated using (public.is_admin());

-- ---------- employee_leave_entitlements ----------
create policy "leave_entitlements: admin all" on public.employee_leave_entitlements
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "leave_entitlements: read own" on public.employee_leave_entitlements
  for select to authenticated using (employee_id = public.current_employee_id());

-- ---------- leave_requests ----------
create policy "leave_requests: admin all" on public.leave_requests
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "leave_requests: read own" on public.leave_requests
  for select to authenticated using (employee_id = public.current_employee_id());
create policy "leave_requests: file own" on public.leave_requests
  for insert to authenticated
  with check (employee_id = public.current_employee_id() and status = 'pending');
create policy "leave_requests: cancel own pending" on public.leave_requests
  for update to authenticated
  using (employee_id = public.current_employee_id() and status = 'pending')
  with check (employee_id = public.current_employee_id() and status in ('pending','cancelled'));

-- ---------- company_settings ----------
create policy "company_settings: read all" on public.company_settings
  for select to authenticated using (true);
create policy "company_settings: admin update" on public.company_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- statutory_versions ----------
create policy "statutory: read all" on public.statutory_versions
  for select to authenticated using (true);
create policy "statutory: admin write" on public.statutory_versions
  for insert to authenticated with check (public.is_admin());
create policy "statutory: admin update" on public.statutory_versions
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "statutory: admin delete" on public.statutory_versions
  for delete to authenticated using (public.is_admin());

-- ---------- holidays ----------
create policy "holidays: read all" on public.holidays
  for select to authenticated using (true);
create policy "holidays: admin write" on public.holidays
  for insert to authenticated with check (public.is_admin());
create policy "holidays: admin update" on public.holidays
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "holidays: admin delete" on public.holidays
  for delete to authenticated using (public.is_admin());

-- ---------- payroll_runs ----------
create policy "payroll_runs: admin all" on public.payroll_runs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "payroll_runs: employee reads finalized runs with own payslip" on public.payroll_runs
  for select to authenticated
  using (status in ('finalized','paid') and public.run_has_own_payslip(id));

-- ---------- payslips ----------
create policy "payslips: admin all" on public.payslips
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "payslips: employee reads own finalized" on public.payslips
  for select to authenticated
  using (employee_id = public.current_employee_id() and public.run_is_finalized(payroll_run_id));

-- ---------- audit_logs ----------
create policy "audit_logs: admin read" on public.audit_logs
  for select to authenticated using (public.is_admin());
-- inserts happen only via security-definer triggers; no direct write policies.
