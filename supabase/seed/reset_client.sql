-- Deletes ONE client (entity) and everything filed under it: employees and
-- their logins, attendance, leave, loans, payroll runs and payslips (posted
-- ones too), consultants, client-local holidays and leave types, and the
-- client's audit-trail rows. Global data (statutory tables, national
-- holidays, leave templates) and admin accounts are untouched.
--
-- IRREVERSIBLE. For wiping test data only: posted payrolls are protected by
-- triggers in normal use (void and reissue), and this script switches those
-- triggers off for its own transaction (session_replication_role = replica),
-- which also turns off FK cascades, hence every table is listed explicitly.
--
-- Usage: replace the code in the first statement, then run the whole file in
-- one transaction (Supabase SQL editor, or MCP execute_sql).

begin;

create temp table _reset_entity on commit drop as
  select id from public.entities where code = 'CHANGE_ME';
create temp table _reset_emp on commit drop as
  select id from public.employees where entity_id in (select id from _reset_entity);
create temp table _reset_login on commit drop as
  select p.id from public.profiles p
   where p.employee_id in (select id from _reset_emp) and p.role = 'employee';

set local session_replication_role = replica;

-- employee-scoped children
delete from public.advance_repayments where entity_id in (select id from _reset_entity);
delete from public.advance_requests where entity_id in (select id from _reset_entity);
delete from public.payroll_deduction_overrides where entity_id in (select id from _reset_entity);
delete from public.payroll_adjustments where entity_id in (select id from _reset_entity);
delete from public.payslips where entity_id in (select id from _reset_entity);
delete from public.payroll_voids where entity_id in (select id from _reset_entity);
delete from public.payroll_runs where entity_id in (select id from _reset_entity);
delete from public.time_correction_requests where entity_id in (select id from _reset_entity);
delete from public.time_entries where entity_id in (select id from _reset_entity);
delete from public.leave_requests where entity_id in (select id from _reset_entity);
delete from public.employee_leave_entitlements where employee_id in (select id from _reset_emp);
delete from public.employee_allowances where employee_id in (select id from _reset_emp);
delete from public.recurring_deductions where employee_id in (select id from _reset_emp);
delete from public.employee_outputs where entity_id in (select id from _reset_entity);
delete from public.employee_pay_rates where entity_id in (select id from _reset_entity);
delete from public.career_events where employee_id in (select id from _reset_emp);
delete from public.employee_schedules where entity_id in (select id from _reset_entity);
delete from public.schedule_overrides where entity_id in (select id from _reset_entity);
delete from public.employee_tax_years where entity_id in (select id from _reset_entity);
delete from public.profiles where id in (select id from _reset_login);
update public.profiles set employee_id = null where employee_id in (select id from _reset_emp);
delete from public.employees where entity_id in (select id from _reset_entity);

-- client-scoped
delete from public.consultant_billings where entity_id in (select id from _reset_entity);
delete from public.consultant_declarations where entity_id in (select id from _reset_entity);
delete from public.consultants where entity_id in (select id from _reset_entity);
delete from public.tax_remittances where entity_id in (select id from _reset_entity);
delete from public.ewt_quarter_filings where entity_id in (select id from _reset_entity);
delete from public.ewt_due_dates where entity_id in (select id from _reset_entity);
delete from public.filing_due_dates where entity_id in (select id from _reset_entity);
delete from public.announcements where entity_id in (select id from _reset_entity);
delete from public.shift_templates where entity_id in (select id from _reset_entity);
delete from public.holidays where entity_id in (select id from _reset_entity);
delete from public.leave_types where entity_id in (select id from _reset_entity);
delete from public.document_counters where entity_id in (select id from _reset_entity);
delete from public.entity_admins where entity_id in (select id from _reset_entity);
delete from public.audit_logs where entity_id in (select id from _reset_entity);
delete from public.entities where id in (select id from _reset_entity);

-- the employees' Auth users, with normal cascades (identities, sessions),
-- and their sign-in guard rows
set local session_replication_role = origin;
delete from public.auth_guard where email in (select lower(email) from auth.users where id in (select id from _reset_login));
delete from auth.users where id in (select id from _reset_login);

-- what is left of the client: every count must be 0
select
  (select count(*) from public.entities where id in (select id from _reset_entity)) as entities,
  (select count(*) from public.employees where id in (select id from _reset_emp)) as employees,
  (select count(*) from auth.users where id in (select id from _reset_login)) as logins,
  (select count(*) from public.audit_logs where entity_id in (select id from _reset_entity)) as audit_rows;

commit;
