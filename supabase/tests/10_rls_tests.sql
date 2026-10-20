-- Behavioural tests for the multi-client security layer.
-- Run after replaying all migrations on a scratch database.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set ca2   '''00000000-0000-0000-0000-0000000000c2'''
\set ea    '''00000000-0000-0000-0000-0000000000a1'''
\set eb    '''00000000-0000-0000-0000-0000000000b1'''
\set ue1   '''00000000-0000-0000-0000-0000000000e1'''
\set ue2   '''00000000-0000-0000-0000-0000000000e2'''

-- helper: assert that a statement fails (runs it dynamically)
create or replace function pg_temp.expect_error(p_sql text, p_like text default '%') returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like p_like then
      raise exception 'expected error like % but got: %', p_like, sqlerrm;
    end if;
    return;
  end;
  raise exception 'expected an error but statement succeeded: %', p_sql;
end $$;
grant execute on function pg_temp.expect_error(text, text) to authenticated, anon;

create or replace function pg_temp.check(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'CHECK FAILED: %', p_msg; end if;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;

\echo '--- 0. owner was promoted to company_admin'
select pg_temp.check((select role from profiles where id = :owner) = 'company_admin', 'owner is company_admin');

-- accounts made by the edge function carry role in app_metadata
insert into auth.users (id, email, raw_app_meta_data) values
  (:ca2, 'ca2@ops.test', '{"role":"company_admin"}'),
  (:ea, 'ea@acme.test', '{"role":"entity_admin"}'),
  (:eb, 'eb@beta.test', '{"role":"entity_admin"}');
select pg_temp.check((select count(*) from profiles where role = 'entity_admin') = 2, 'two entity admins');

-- a random self-signup gets an unlinked employee profile (no access)
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000ff', 'stranger@x.test');
select pg_temp.check((select role from profiles where email = 'stranger@x.test') = 'employee', 'stranger is plain employee');

\echo '--- 1. company admin creates clients; entity admin cannot'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values
  ('10000000-0000-0000-0000-00000000000a', 'ACME', 'Acme Trading Corp', 755),
  ('10000000-0000-0000-0000-00000000000b', 'BETA', 'Beta Foods Inc', 695);
insert into entity_admins (profile_id, entity_id) values
  (:ea, '10000000-0000-0000-0000-00000000000a'),
  (:eb, '10000000-0000-0000-0000-00000000000b');
commit;
select pg_temp.check((select count(*) from leave_types where entity_id = '10000000-0000-0000-0000-00000000000a') = 9, 'ACME seeded 9 leave types');

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
select pg_temp.expect_error($$insert into entities (code, name) values ('EVIL','Evil Co')$$, '%row-level security%');
select pg_temp.check((select count(*) from entities) = 1, 'entity admin sees only own client');
select pg_temp.expect_error($$update entities set code = 'ACME2' where code = 'ACME'$$, '%cannot be changed%');
select pg_temp.expect_error($$update entities set is_active = false where code = 'ACME'$$, '%Only company admins%');
update entities set trade_name = 'Acme' where code = 'ACME';
select pg_temp.check((select trade_name from entities where code = 'ACME') = 'Acme', 'entity admin edits own client settings');
-- cannot assign themselves to another client
select pg_temp.expect_error($$insert into entity_admins (profile_id, entity_id) values ('00000000-0000-0000-0000-0000000000a1','10000000-0000-0000-0000-00000000000b')$$, '%row-level security%');
commit;

\echo '--- 2. employees are client-scoped'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate, pay_frequency, is_minimum_wage_earner)
values ('20000000-0000-0000-0000-0000000000e1', '10000000-0000-0000-0000-00000000000a', 'A-001', 'Ana', 'Reyes', '2026-01-05', 'daily', 755, 'weekly', true);
select pg_temp.expect_error($$insert into employees (entity_id, employee_no, first_name, last_name, hire_date) values ('10000000-0000-0000-0000-00000000000b','X-1','Xa','Xb','2026-01-01')$$, '%row-level security%');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :eb, true);
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate)
values ('20000000-0000-0000-0000-0000000000e2', '10000000-0000-0000-0000-00000000000b', 'A-001', 'Ben', 'Cruz', '2026-02-01', 'monthly', 25000);
select pg_temp.check((select count(*) from employees) = 1, 'BETA admin sees one employee');
select pg_temp.expect_error($$update employees set entity_id = '10000000-0000-0000-0000-00000000000a' where employee_no = 'A-001'$$, '%');
commit;
-- allowances have no client column: their audit rows take the employee's client
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
insert into employee_allowances (employee_id, label, amount) values ('20000000-0000-0000-0000-0000000000e1', 'Rice', 2000);
select pg_temp.check((select count(*) from audit_logs where table_name = 'employee_allowances') = 1, 'ACME admin sees the allowance audit row');
commit;
select pg_temp.check((select entity_id from audit_logs where table_name = 'employee_allowances') = '10000000-0000-0000-0000-00000000000a', 'allowance audit row scoped to ACME');
-- employee number unique per client only (both clients use A-001)
select pg_temp.check((select count(*) from employees where employee_no = 'A-001') = 2, 'employee_no unique per client');
-- an employee can never move clients (even by the owner/service)
select pg_temp.expect_error($$update employees set entity_id = '10000000-0000-0000-0000-00000000000a' where id = '20000000-0000-0000-0000-0000000000e2'$$, '%cannot move to another client%');
-- separation needs both date and reason
select pg_temp.expect_error($$update employees set separation_date = '2026-09-30' where id = '20000000-0000-0000-0000-0000000000e2'$$, '%employees_separation_check%');

-- employee logins
insert into auth.users (id, email, raw_app_meta_data) values
  (:ue1, 'emp-1@x.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000000e1"}'),
  (:ue2, 'emp-2@x.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000000e2"}');
select pg_temp.check((select employee_id from profiles where id = :ue1) = '20000000-0000-0000-0000-0000000000e1', 'employee login linked');
-- admin roles can never link to an employee record
select pg_temp.expect_error($$update profiles set employee_id = '20000000-0000-0000-0000-0000000000e1' where id = '00000000-0000-0000-0000-0000000000a1'$$, '%profiles_employee_link_check%');

\echo '--- 3. time entries: admin-entered, guarded, client-scoped'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
-- Manila 08:00-17:00 on Mon Oct 5 2026 = 00:00Z-09:00Z
insert into time_entries (employee_id, work_date, clock_in, clock_out)
values ('20000000-0000-0000-0000-0000000000e1', '2026-10-05', '2026-10-05T00:00:00Z', '2026-10-05T09:00:00Z');
select pg_temp.check((select entity_id from time_entries limit 1) = '10000000-0000-0000-0000-00000000000a', 'entity assigned from employee');
select pg_temp.check((select status from time_entries limit 1) = 'closed', 'status derived');
select pg_temp.expect_error($$insert into time_entries (employee_id, work_date, clock_in, clock_out) values ('20000000-0000-0000-0000-0000000000e1','2026-10-05','2026-10-05T08:00:00Z','2026-10-05T10:00:00Z')$$, '%overlaps%');
select pg_temp.expect_error($$insert into time_entries (employee_id, work_date, clock_in, clock_out) values ('20000000-0000-0000-0000-0000000000e1','2026-10-07','2026-10-05T10:00:00Z','2026-10-05T11:00:00Z')$$, '%work date%');
select pg_temp.expect_error($$insert into time_entries (employee_id, work_date, clock_in, clock_out) values ('20000000-0000-0000-0000-0000000000e1','2026-10-06','2026-10-06T00:00:00Z','2026-10-07T01:00:00Z')$$, '%time_entries_duration_check%');
-- cross-client write: BETA employee from ACME admin (entity forced to BETA -> RLS rejects)
select pg_temp.expect_error($$insert into time_entries (employee_id, entity_id, work_date, clock_in, clock_out) values ('20000000-0000-0000-0000-0000000000e2','10000000-0000-0000-0000-00000000000a','2026-10-05','2026-10-05T00:00:00Z','2026-10-05T09:00:00Z')$$, '%');
commit;
-- employees cannot write attendance at all
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ue1, true);
select pg_temp.check((select count(*) from time_entries) = 1, 'employee reads own entries');
select pg_temp.expect_error($$insert into time_entries (employee_id, work_date, clock_in, clock_out) values ('20000000-0000-0000-0000-0000000000e1','2026-10-06','2026-10-06T00:00:00Z','2026-10-06T09:00:00Z')$$, '%row-level security%');
select pg_temp.check((select count(*) from employees) = 1, 'employee reads own employee row only');
select pg_temp.check((select count(*) from entities) = 1, 'employee reads own employer');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ue2, true);
select pg_temp.check((select count(*) from time_entries) = 0, 'other client employee sees nothing');
commit;

\echo '--- 4. corrections'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ue1, true);
insert into time_correction_requests (employee_id, time_entry_id, work_date, requested_clock_in, requested_clock_out, reason)
select employee_id, id, work_date, clock_in, clock_out + interval '30 minutes', 'forgot to log OT' from time_entries limit 1;
commit;
select id as acme_entry from time_entries limit 1 \gset
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ue2, true);
-- cannot reference someone else's entry even when the id is known
select pg_temp.expect_error(format($$insert into time_correction_requests (employee_id, time_entry_id, work_date, reason) values ('20000000-0000-0000-0000-0000000000e2', %L, '2026-10-05', 'x')$$, :'acme_entry'), '%does not belong%');
-- nor file a request in another employee's name
select pg_temp.expect_error($$insert into time_correction_requests (employee_id, work_date, reason) values ('20000000-0000-0000-0000-0000000000e1', '2026-10-05', 'x')$$, '%row-level security%');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :eb, true);
select pg_temp.expect_error($$select public.review_time_correction((select id from public.time_correction_requests limit 1), true, null)$$, '%');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
select review_time_correction((select id from time_correction_requests limit 1), true, 'ok');
select pg_temp.check((select clock_out from time_entries limit 1) = '2026-10-05T09:30:00Z', 'correction applied');
commit;

\echo '--- 5. leaves and announcements'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ue1, true);
insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days, status)
select '20000000-0000-0000-0000-0000000000e1', id, '2026-10-12', '2026-10-12', 1, 'pending' from leave_types where code = 'SIL';
select pg_temp.check((select count(*) from leave_types) = 9, 'employee sees only own client leave types');
commit;
-- a BETA leave type id cannot be used by an ACME employee
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days) select '20000000-0000-0000-0000-0000000000e1', id, '2026-10-13','2026-10-13',1 from leave_types where entity_id = '10000000-0000-0000-0000-00000000000b' and code = 'SIL'$$, '%does not belong%');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
insert into announcements (entity_id, title, body) values ('10000000-0000-0000-0000-00000000000a', 'Payday moved', 'Payday is on Friday.');
insert into announcements (entity_id, title, published_at) values ('10000000-0000-0000-0000-00000000000a', 'Future', now() + interval '2 days');
select pg_temp.expect_error($$insert into announcements (entity_id, title) values ('10000000-0000-0000-0000-00000000000b','x')$$, '%row-level security%');
insert into holidays (entity_id, holiday_date, name, kind) values ('10000000-0000-0000-0000-00000000000a', '2026-11-20', 'City Charter Day', 'special_non_working');
select pg_temp.expect_error($$insert into holidays (holiday_date, name, kind) values ('2026-11-21','Fake national','regular')$$, '%row-level security%');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ue1, true);
select pg_temp.check((select count(*) from announcements) = 1, 'employee sees published announcement only');
select pg_temp.check((select count(*) from holidays where entity_id is not null) = 1, 'employee sees own local holiday');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ue2, true);
select pg_temp.check((select count(*) from announcements) = 0, 'other client employee sees no announcements');
select pg_temp.check((select count(*) from holidays where entity_id is not null) = 0, 'other client local holiday hidden');
commit;

\echo '--- 6. statutory tables: company admins only'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
select pg_temp.check((select count(*) from statutory_versions) = 5, 'entity admin reads statutory');
select pg_temp.expect_error($$insert into statutory_versions (kind, effective_from, data) values ('sss','2027-01-01','{}')$$, '%row-level security%');
update statutory_versions set description = 'hacked';
select pg_temp.check((select count(*) from statutory_versions where description = 'hacked') = 0, 'entity admin update is a no-op');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into statutory_versions (kind, effective_from, description, data)
select kind, '2027-01-01', 'test copy', data from statutory_versions where kind = 'pagibig';
delete from statutory_versions where kind = 'pagibig' and effective_from = '2027-01-01';
select pg_temp.expect_error($$delete from statutory_versions where kind = 'sss'$$, '%only sss%');
commit;

\echo '--- 7. payroll: run, payslips, finalize/reopen, rounding chain, lock'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000a', 'regular', 'weekly', '2026-10-05', '2026-10-11', '2026-10-16', '2026-10-01', 2, 5);
select pg_temp.expect_error($$insert into payroll_runs (entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month) values ('10000000-0000-0000-0000-00000000000a','regular','weekly','2026-10-05','2026-10-11','2026-10-16','2026-10-01',2,5)$$, '%payroll_runs_regular_slot_uidx%');
select pg_temp.expect_error($$insert into payroll_runs (entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month) values ('10000000-0000-0000-0000-00000000000a','regular','semi_monthly','2026-10-01','2026-10-15','2026-10-20','2026-10-01',1,3)$$, '%payroll_runs_frequency_check%');
-- payslip with a carry-forward rounding: exact 4530.40 -> paid 4530, carry 0.40
insert into payslips (payroll_run_id, employee_id, gross_pay, total_deductions, net_pay, rounding_adjustment, rounding_carry_in, rounding_carry_out)
values ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000e1', 4530.40, 0, 4530, -0.40, 0, 0.40);
select pg_temp.check((select period_month from payslips limit 1) = '2026-10-01' and (select pay_frequency from payslips limit 1) = 'weekly', 'payslip copies run facts');
-- BETA employee on an ACME run is impossible
select pg_temp.expect_error($$insert into payslips (payroll_run_id, employee_id) values ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-0000000000e2')$$, '%');
insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, category)
values ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000e1', 'earning', 'Unpaid OT last week', 100, 'overtime');
-- entity admins cannot touch the rounding balance directly
select pg_temp.expect_error($$update employees set rounding_balance = 0.5 where id = '20000000-0000-0000-0000-0000000000e1'$$, '%maintained by payroll finalization%');
select finalize_payroll_run('30000000-0000-0000-0000-000000000001');
select pg_temp.check((select rounding_balance from employees where id = '20000000-0000-0000-0000-0000000000e1') = 0.40, 'carry stored on finalize');
select pg_temp.expect_error($$select public.finalize_payroll_run('30000000-0000-0000-0000-000000000001')$$, '%not a draft%');
-- attendance in the paid period is locked; notes still editable
select pg_temp.expect_error($$update time_entries set clock_out = clock_out + interval '1 hour'$$, '%locked%');
select pg_temp.expect_error($$delete from time_entries$$, '%locked%');
update time_entries set admin_notes = 'verified';
select pg_temp.expect_error($$insert into time_entries (employee_id, work_date, clock_in, clock_out) values ('20000000-0000-0000-0000-0000000000e1','2026-10-06','2026-10-06T00:00:00Z','2026-10-06T09:00:00Z')$$, '%locked%');
select pg_temp.expect_error($$delete from payroll_adjustments$$, '%locked%');
select pg_temp.expect_error($$update payslips set remarks = 'x'$$, '%immutable%');
select pg_temp.expect_error($$delete from payroll_runs$$, '%Cannot delete a finalized%');
commit;
-- next week's run consumes the carry; reopening the earlier one is then refused
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000a', 'regular', 'weekly', '2026-10-12', '2026-10-18', '2026-10-23', '2026-10-01', 3, 5);
-- stale draft: computed as if the balance were still 0
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, rounding_carry_in, rounding_carry_out)
values ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000e1', 100.30, 100, 0, 0.30);
select pg_temp.expect_error($$select public.finalize_payroll_run('30000000-0000-0000-0000-000000000002')$$, '%Recompute the draft%');
update payslips set rounding_carry_in = 0.40, rounding_carry_out = 0.70, net_pay = 100 where payroll_run_id = '30000000-0000-0000-0000-000000000002';
select finalize_payroll_run('30000000-0000-0000-0000-000000000002');
select pg_temp.check((select rounding_balance from employees where id = '20000000-0000-0000-0000-0000000000e1') = 0.70, 'chain advanced');
select pg_temp.expect_error($$select public.reopen_payroll_run('30000000-0000-0000-0000-000000000001')$$, '%Reopen that later run first%');
select reopen_payroll_run('30000000-0000-0000-0000-000000000002');
select pg_temp.check((select rounding_balance from employees where id = '20000000-0000-0000-0000-0000000000e1') = 0.40, 'reopen restores carry-in');
select reopen_payroll_run('30000000-0000-0000-0000-000000000001');
select pg_temp.check((select rounding_balance from employees where id = '20000000-0000-0000-0000-0000000000e1') = 0, 'chain fully unwound');
update time_entries set clock_out = clock_out + interval '15 minutes';
commit;
-- other client's admin can't see or finalize ACME runs
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :eb, true);
select pg_temp.check((select count(*) from payroll_runs) = 0, 'BETA admin sees no ACME runs');
select pg_temp.check((select count(*) from payslips) = 0, 'BETA admin sees no ACME payslips');
select pg_temp.expect_error($$select public.finalize_payroll_run('30000000-0000-0000-0000-000000000001')$$, '%not found%');
select pg_temp.check((select count(*) from audit_logs) = (select count(*) from audit_logs where entity_id = '10000000-0000-0000-0000-00000000000b'), 'BETA admin sees only BETA audit rows');
commit;
-- employees see only finalized own payslips
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
select finalize_payroll_run('30000000-0000-0000-0000-000000000001');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ue1, true);
select pg_temp.check((select count(*) from payslips) = 1, 'employee sees finalized payslip only');
select pg_temp.check((select count(*) from payroll_runs) = 0, 'employee never reads runs');
commit;

\echo '--- 8. profiles and admin protection'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
select pg_temp.check((select count(*) from profiles) = 2, 'entity admin sees self + own client employee login');
update profiles set role = 'company_admin' where id = :ea;
select pg_temp.check((select role from profiles where id = :ea) = 'entity_admin', 'entity admin cannot self-promote');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select pg_temp.expect_error($$update profiles set is_active = false where id = '00000000-0000-0000-0000-0000000000c2'$$, '%Another company admin%');
update profiles set is_active = false where id = :ea;
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
select pg_temp.check((select count(*) from employees) = 0, 'deactivated entity admin loses access');
commit;
-- last company admin cannot be removed
update profiles set role = 'employee' where id = :ca2 and false;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ca2, true);
update profiles set role = 'entity_admin' where id = :ca2;
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select pg_temp.expect_error($$update profiles set is_active = false where id = '00000000-0000-0000-0000-0000000000c1'$$, '%last active company admin%');
commit;

\echo '--- 9. archived client locks out its entity admins'
update profiles set is_active = true where id = :ea;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
update entities set is_active = false where code = 'ACME';
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ea, true);
select pg_temp.check((select count(*) from employees) = 0, 'archived client hidden from its entity admin');
commit;

\echo '--- 10. anon sees nothing'
begin;
set local role anon;
select pg_temp.check((select count(*) from entities) = 0 and (select count(*) from statutory_versions) = 0, 'anon blocked');
commit;

\echo 'ALL RLS TESTS PASSED'
