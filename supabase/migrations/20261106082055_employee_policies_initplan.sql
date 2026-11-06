-- Employee pages, faster. Two per-row costs every employee query paid:
--
-- 1. Every employee policy evaluated current_employee_id() or
--    current_employee_entity_id() once per row, and since the session rule
--    (20261106080630_employee_session_timeout) each call reads profiles,
--    auth.sessions and employee_session_activity. Wrapped as (select ...),
--    Postgres evaluates the helper once per statement (an initPlan): the
--    answer depends only on the caller (token and session), never on the row.
--
-- 2. Permissive policies are combined with OR, so a query by an employee also
--    ran the admin policy can_manage_entity(entity_id) / can_manage_employee(employee_id)
--    on every row (each a profiles + session lookup) only to get false. Those
--    branches are now guarded by (select public.caller_is_admin()) first, once
--    per statement, and AND stops at false. The guard changes no answer:
--    can_manage_entity, can_manage_employee and is_company_admin are all true
--    only for a company_admin or entity_admin profile, which is exactly what
--    caller_is_admin checks (and nothing more, so it can never be false where
--    they are true). is_company_admin() takes no row value: wrapped as well.
--
-- Every other part of each USING and WITH CHECK is the current
-- expression (pg_get_expr, as live and the replica hold it). ALTER POLICY, no
-- DROP. Measured on the replica (56,002 time entries, an employee with 1,400):
-- the employee counting their own entries, about 12 s before and 9 ms after.

create or replace function public.caller_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('company_admin', 'entity_admin'))
$$;
revoke execute on function public.caller_is_admin() from public, anon;
grant execute on function public.caller_is_admin() to authenticated;

-- 1. the employee policies

alter policy "advance_repayments: read own" on public.advance_repayments
  using ((employee_id = (select public.current_employee_id())));

alter policy "advance_requests: cancel own pending" on public.advance_requests
  using (((employee_id = (select public.current_employee_id())) AND (status = 'pending'::text)))
  with check (((employee_id = (select public.current_employee_id())) AND (status = ANY (ARRAY['pending'::text, 'cancelled'::text]))));

alter policy "advance_requests: file own" on public.advance_requests
  with check (((employee_id = (select public.current_employee_id())) AND (status = 'pending'::text)));

alter policy "advance_requests: read own" on public.advance_requests
  using ((employee_id = (select public.current_employee_id())));

alter policy "announcements: employees read published" on public.announcements
  using (((entity_id = (select public.current_employee_entity_id())) AND (published_at <= now()) AND ((expires_at IS NULL) OR (expires_at > now()))));

alter policy "career_events: read own" on public.career_events
  using ((employee_id = (select public.current_employee_id())));

alter policy "allowances: read own" on public.employee_allowances
  using ((employee_id = (select public.current_employee_id())));

alter policy "leave_entitlements: read own" on public.employee_leave_entitlements
  using ((employee_id = (select public.current_employee_id())));

alter policy "employee_schedules: read own" on public.employee_schedules
  using ((employee_id = (select public.current_employee_id())));

alter policy "employees: read own" on public.employees
  using ((id = (select public.current_employee_id())));

alter policy "entities: read managed or own employer" on public.entities
  using ((((select public.caller_is_admin()) AND can_manage_entity(id)) OR (id = (select public.current_employee_entity_id()))));

alter policy "holidays: read" on public.holidays
  using (((entity_id IS NULL) OR ((select public.caller_is_admin()) AND can_manage_entity(entity_id)) OR (entity_id = (select public.current_employee_entity_id()))));

alter policy "leave_requests: cancel own pending" on public.leave_requests
  using (((employee_id = (select public.current_employee_id())) AND (status = 'pending'::text)))
  with check (((employee_id = (select public.current_employee_id())) AND (status = ANY (ARRAY['pending'::text, 'cancelled'::text]))));

alter policy "leave_requests: file own" on public.leave_requests
  with check (((employee_id = (select public.current_employee_id())) AND (status = 'pending'::text)));

alter policy "leave_requests: read own" on public.leave_requests
  using ((employee_id = (select public.current_employee_id())));

alter policy "leave_types: read" on public.leave_types
  using ((((entity_id IS NULL) AND (select public.is_company_admin())) OR ((select public.caller_is_admin()) AND can_manage_entity(entity_id)) OR (entity_id = (select public.current_employee_entity_id()))));

alter policy "payslips: employee reads own finalized" on public.payslips
  using (((employee_id = (select public.current_employee_id())) AND run_is_finalized(payroll_run_id)));

alter policy "recurring_deductions: read own" on public.recurring_deductions
  using ((employee_id = (select public.current_employee_id())));

alter policy "schedule_overrides: read own" on public.schedule_overrides
  using ((employee_id = (select public.current_employee_id())));

alter policy "tcr: cancel own pending" on public.time_correction_requests
  using (((employee_id = (select public.current_employee_id())) AND (status = 'pending'::text)))
  with check (((employee_id = (select public.current_employee_id())) AND (status = ANY (ARRAY['pending'::text, 'cancelled'::text]))));

alter policy "tcr: file own" on public.time_correction_requests
  with check (((employee_id = (select public.current_employee_id())) AND (status = 'pending'::text)));

alter policy "tcr: read own" on public.time_correction_requests
  using ((employee_id = (select public.current_employee_id())));

alter policy "time_entries: read own" on public.time_entries
  using ((employee_id = (select public.current_employee_id())));

-- 2. the admin policies on the tables employees read (cmd ALL: they apply to
-- the reads and requests of employees too)

alter policy "advance_repayments: admins manage" on public.advance_repayments
  using (((select public.caller_is_admin()) AND can_manage_entity(entity_id)))
  with check (((select public.caller_is_admin()) AND can_manage_entity(entity_id)));

alter policy "advance_requests: admins manage" on public.advance_requests
  using (((select public.caller_is_admin()) AND can_manage_entity(entity_id)))
  with check (((select public.caller_is_admin()) AND can_manage_entity(entity_id)));

alter policy "announcements: admins manage" on public.announcements
  using (((select public.caller_is_admin()) AND can_manage_entity(entity_id)))
  with check (((select public.caller_is_admin()) AND can_manage_entity(entity_id)));

alter policy "career_events: admins manage" on public.career_events
  using (((select public.caller_is_admin()) AND can_manage_employee(employee_id)))
  with check (((select public.caller_is_admin()) AND can_manage_employee(employee_id)));

alter policy "allowances: admins manage" on public.employee_allowances
  using (((select public.caller_is_admin()) AND can_manage_employee(employee_id)))
  with check (((select public.caller_is_admin()) AND can_manage_employee(employee_id)));

alter policy "leave_entitlements: admins manage" on public.employee_leave_entitlements
  using (((select public.caller_is_admin()) AND can_manage_employee(employee_id)))
  with check (((select public.caller_is_admin()) AND can_manage_employee(employee_id)));

alter policy "employee_schedules: admins manage" on public.employee_schedules
  using (((select public.caller_is_admin()) AND can_manage_entity(entity_id)))
  with check (((select public.caller_is_admin()) AND can_manage_entity(entity_id)));

alter policy "employees: admins manage" on public.employees
  using (((select public.caller_is_admin()) AND can_manage_entity(entity_id)))
  with check (((select public.caller_is_admin()) AND can_manage_entity(entity_id)));

alter policy "holidays: manage" on public.holidays
  using (((select public.caller_is_admin()) AND (((entity_id IS NULL) AND (select public.is_company_admin())) OR ((entity_id IS NOT NULL) AND can_manage_entity(entity_id)))))
  with check (((select public.caller_is_admin()) AND (((entity_id IS NULL) AND (select public.is_company_admin())) OR ((entity_id IS NOT NULL) AND can_manage_entity(entity_id)))));

alter policy "leave_requests: admins manage" on public.leave_requests
  using (((select public.caller_is_admin()) AND can_manage_entity(entity_id)))
  with check (((select public.caller_is_admin()) AND can_manage_entity(entity_id)));

alter policy "leave_types: manage" on public.leave_types
  using (((select public.caller_is_admin()) AND (((entity_id IS NULL) AND (select public.is_company_admin())) OR ((entity_id IS NOT NULL) AND can_manage_entity(entity_id)))))
  with check (((select public.caller_is_admin()) AND (((entity_id IS NULL) AND (select public.is_company_admin())) OR ((entity_id IS NOT NULL) AND can_manage_entity(entity_id)))));

alter policy "payslips: admins manage" on public.payslips
  using (((select public.caller_is_admin()) AND can_manage_entity(entity_id)))
  with check (((select public.caller_is_admin()) AND can_manage_entity(entity_id)));

alter policy "recurring_deductions: admins manage" on public.recurring_deductions
  using (((select public.caller_is_admin()) AND can_manage_employee(employee_id)))
  with check (((select public.caller_is_admin()) AND can_manage_employee(employee_id)));

alter policy "schedule_overrides: admins manage" on public.schedule_overrides
  using (((select public.caller_is_admin()) AND can_manage_entity(entity_id)))
  with check (((select public.caller_is_admin()) AND can_manage_entity(entity_id)));

alter policy "tcr: admins manage" on public.time_correction_requests
  using (((select public.caller_is_admin()) AND can_manage_entity(entity_id)))
  with check (((select public.caller_is_admin()) AND can_manage_entity(entity_id)));

alter policy "time_entries: admins manage" on public.time_entries
  using (((select public.caller_is_admin()) AND can_manage_entity(entity_id)))
  with check (((select public.caller_is_admin()) AND can_manage_entity(entity_id)));
