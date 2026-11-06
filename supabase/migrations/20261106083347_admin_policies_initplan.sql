-- Admin pages, faster. Every admin policy called can_manage_entity(entity_id)
-- or can_manage_employee(employee_id) once per row, each a profiles + entity
-- admins + admin session lookup (about 75 microseconds): 56,002 time entries
-- took about 4 s to count on the replica. The answer depends on the row only
-- through its client, so the caller part now runs once per statement:
--
--   managed_entity_ids()   the active clients an entity admin manages (the
--                          entity_admin branch of can_manage_entity, with the
--                          same profile, revocation and admin session checks)
--                          and an empty array for anyone else
--   managed_employee_ids() the employees of those clients, or every employee
--                          for a company admin (can_manage_employee as a set)
--
-- and can_manage_entity is rebuilt on them, so the RPCs and the policies share
-- one definition. In every public policy, mechanically:
--
--   can_manage_entity(x)   ->  ((x IS NOT NULL) AND ((select is_company_admin())
--                                OR (x = ANY ((select managed_entity_ids())::uuid[]))))
--   can_manage_employee(x) ->  (x IN (select managed_employee_ids()))   (hashed)
--   is_company_admin()     ->  (select is_company_admin())
--
-- Each is the same answer: can_manage_employee(x) is can_manage_entity of the
-- client of employee x (false for null or an unknown x), and no policy uses a
-- boolean NOT, so a null where the old call gave false denies the same.
-- Everything else in each USING and WITH CHECK is the current expression (as
-- live and the replica hold it). ALTER POLICY, no DROP.

create or replace function public.managed_entity_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(ea.entity_id), '{}'::uuid[])
  from profiles p
  join entity_admins ea on ea.profile_id = p.id
  join entities en on en.id = ea.entity_id and en.is_active
  where p.id = auth.uid() and p.is_active and p.role = 'entity_admin'
    and (p.sessions_revoked_at is null
         or coalesce((auth.jwt()->>'iat')::bigint, 0) >= floor(extract(epoch from p.sessions_revoked_at)))
    and public.admin_session_ok(p.id, p.admin_session_id)
$$;

create or replace function public.managed_employee_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select e.id from employees e
  where e.entity_id is not null
    and ((select public.is_company_admin()) or e.entity_id = any ((select public.managed_entity_ids())::uuid[]))
$$;

create or replace function public.can_manage_entity(p_entity uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_entity is not null
    and (public.is_company_admin() or p_entity = any (public.managed_entity_ids()))
$$;

revoke execute on function public.managed_entity_ids() from public, anon;
revoke execute on function public.managed_employee_ids() from public, anon;
grant execute on function public.managed_entity_ids() to authenticated;
grant execute on function public.managed_employee_ids() to authenticated;

alter policy "advance_repayments: admins manage" on public.advance_repayments
  using (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))
  with check (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))));

alter policy "advance_requests: admins manage" on public.advance_requests
  using (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))
  with check (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))));

alter policy "announcements: admins manage" on public.announcements
  using (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))
  with check (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))));

alter policy "audit_logs: read" on public.audit_logs
  using (((select public.is_company_admin()) OR ((entity_id IS NOT NULL) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))));

alter policy "career_events: admins manage" on public.career_events
  using (((select public.caller_is_admin()) AND (employee_id IN (select public.managed_employee_ids()))))
  with check (((select public.caller_is_admin()) AND (employee_id IN (select public.managed_employee_ids()))));

alter policy "consultant_billings: admins manage" on public.consultant_billings
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "consultant_declarations: admins manage" on public.consultant_declarations
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "consultants: admins manage" on public.consultants
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "allowances: admins manage" on public.employee_allowances
  using (((select public.caller_is_admin()) AND (employee_id IN (select public.managed_employee_ids()))))
  with check (((select public.caller_is_admin()) AND (employee_id IN (select public.managed_employee_ids()))));

alter policy "leave_entitlements: admins manage" on public.employee_leave_entitlements
  using (((select public.caller_is_admin()) AND (employee_id IN (select public.managed_employee_ids()))))
  with check (((select public.caller_is_admin()) AND (employee_id IN (select public.managed_employee_ids()))));

alter policy "employee_opening_balances: admins manage" on public.employee_opening_balances
  using ((employee_id IN (select public.managed_employee_ids())))
  with check ((employee_id IN (select public.managed_employee_ids())));

alter policy "employee_outputs: admins manage" on public.employee_outputs
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "employee_pay_rates: admins manage" on public.employee_pay_rates
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "employee_schedules: admins manage" on public.employee_schedules
  using (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))
  with check (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))));

alter policy "employee_tax_years: admins manage" on public.employee_tax_years
  using ((employee_id IN (select public.managed_employee_ids())))
  with check ((employee_id IN (select public.managed_employee_ids())));

alter policy "employees: admins manage" on public.employees
  using (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))
  with check (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))));

alter policy "entities: admins update" on public.entities
  using (((id IS NOT NULL) AND ((select public.is_company_admin()) OR (id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((id IS NOT NULL) AND ((select public.is_company_admin()) OR (id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "entities: company admin delete" on public.entities
  using ((select public.is_company_admin()));

alter policy "entities: company admin insert" on public.entities
  with check ((select public.is_company_admin()));

alter policy "entities: read managed or own employer" on public.entities
  using ((((select public.caller_is_admin()) AND ((id IS NOT NULL) AND ((select public.is_company_admin()) OR (id = ANY ((select public.managed_entity_ids())::uuid[]))))) OR (id = (select public.current_employee_entity_id()))));

alter policy "entity_admins: company admin write" on public.entity_admins
  using ((select public.is_company_admin()))
  with check ((select public.is_company_admin()));

alter policy "entity_admins: read own or company admin" on public.entity_admins
  using (((select public.is_company_admin()) OR (profile_id = (select auth.uid()))));

alter policy "ewt_due_dates: admins manage" on public.ewt_due_dates
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "ewt_quarter_filings: admins manage" on public.ewt_quarter_filings
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "filing_due_dates: admins manage" on public.filing_due_dates
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "holidays: manage" on public.holidays
  using (((select public.caller_is_admin()) AND (((entity_id IS NULL) AND (select public.is_company_admin())) OR ((entity_id IS NOT NULL) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))))
  with check (((select public.caller_is_admin()) AND (((entity_id IS NULL) AND (select public.is_company_admin())) OR ((entity_id IS NOT NULL) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))));

alter policy "holidays: read" on public.holidays
  using (((entity_id IS NULL) OR ((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))) OR (entity_id = (select public.current_employee_entity_id()))));

alter policy "leave_requests: admins manage" on public.leave_requests
  using (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))
  with check (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))));

alter policy "leave_types: manage" on public.leave_types
  using (((select public.caller_is_admin()) AND (((entity_id IS NULL) AND (select public.is_company_admin())) OR ((entity_id IS NOT NULL) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))))
  with check (((select public.caller_is_admin()) AND (((entity_id IS NULL) AND (select public.is_company_admin())) OR ((entity_id IS NOT NULL) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))));

alter policy "leave_types: read" on public.leave_types
  using ((((entity_id IS NULL) AND (select public.is_company_admin())) OR ((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))) OR (entity_id = (select public.current_employee_entity_id()))));

alter policy "payroll_adjustments: admins manage" on public.payroll_adjustments
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "payroll_deduction_overrides: admins manage" on public.payroll_deduction_overrides
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "payroll_runs: admins manage" on public.payroll_runs
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "payroll_voids: admins read" on public.payroll_voids
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "payslips: admins manage" on public.payslips
  using (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))
  with check (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))));

alter policy "profiles: company admin delete" on public.profiles
  using ((select public.is_company_admin()));

alter policy "profiles: company admin update" on public.profiles
  using ((select public.is_company_admin()))
  with check ((select public.is_company_admin()));

alter policy "profiles: read" on public.profiles
  using (((id = (select auth.uid())) OR (select public.is_company_admin()) OR ((employee_id IS NOT NULL) AND (employee_id IN (select public.managed_employee_ids())))));

alter policy "recurring_deductions: admins manage" on public.recurring_deductions
  using (((select public.caller_is_admin()) AND (employee_id IN (select public.managed_employee_ids()))))
  with check (((select public.caller_is_admin()) AND (employee_id IN (select public.managed_employee_ids()))));

alter policy "schedule_overrides: admins manage" on public.schedule_overrides
  using (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))
  with check (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))));

alter policy "shift_templates: admins manage" on public.shift_templates
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "tax_remittances: admins manage" on public.tax_remittances
  using (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))))
  with check (((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[])))));

alter policy "tcr: admins manage" on public.time_correction_requests
  using (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))
  with check (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))));

alter policy "time_entries: admins manage" on public.time_entries
  using (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))))
  with check (((select public.caller_is_admin()) AND ((entity_id IS NOT NULL) AND ((select public.is_company_admin()) OR (entity_id = ANY ((select public.managed_entity_ids())::uuid[]))))));
