-- Tests for 20261020031639_audit_fixes.sql: draft staleness gaps, reopen
-- and finalize guards, paid-leave guards, audit noise and actor.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set ga    '''00000000-0000-0000-0000-0000000000a9'''

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
grant execute on function pg_temp.expect_error(text, text) to authenticated, anon, service_role;

create or replace function pg_temp.check(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'CHECK FAILED: %', p_msg; end if;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon, service_role;

create or replace function pg_temp.computed(p_run uuid) returns void
language sql as $$
  update payslips p set employee_payroll_seq = e.payroll_seq
    from employees e where e.id = p.employee_id and p.payroll_run_id = p_run;
  update payroll_runs
    set totals = jsonb_build_object('employees', (select count(*) from payslips where payroll_run_id = p_run))
    where id = p_run;
$$;
grant execute on function pg_temp.computed(uuid) to authenticated;

create or replace function pg_temp.totals(p_run uuid) returns jsonb
language sql as $$ select totals from payroll_runs where id = p_run $$;
grant execute on function pg_temp.totals(uuid) to authenticated;

-- fixture: client GAMMA, its entity admin and two weekly employees
insert into auth.users (id, email, raw_app_meta_data) values (:ga, 'ga@gamma.test', '{"role":"entity_admin"}');
insert into entities (id, code, name, minimum_wage_daily, net_pay_rounding)
values ('10000000-0000-0000-0000-00000000000c', 'GAMMA', 'Gamma Corp', 755, 'carry_forward');
insert into entity_admins (profile_id, entity_id) values (:ga, '10000000-0000-0000-0000-00000000000c');
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate, pay_frequency, is_minimum_wage_earner)
values ('20000000-0000-0000-0000-0000000000f1', '10000000-0000-0000-0000-00000000000c', 'G-001', 'Gil', 'One', '2026-01-05', 'daily', 755, 'weekly', true),
       ('20000000-0000-0000-0000-0000000000f2', '10000000-0000-0000-0000-00000000000c', 'G-002', 'Gia', 'Two', '2026-01-05', 'daily', 755, 'weekly', true);

\echo '--- 11.1 statutory, leave-type and tax-year changes make drafts stale'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ga, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('3000000c-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000c', 'regular', 'weekly', '2026-11-02', '2026-11-08', '2026-11-13', '2026-11-01', 1, 4);
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay) values ('3000000c-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000f1', 3775, 3775);
select pg_temp.computed('3000000c-0000-0000-0000-000000000001');
update leave_types set paid = false where entity_id = '10000000-0000-0000-0000-00000000000c' and code = 'SIL';
select pg_temp.check(pg_temp.totals('3000000c-0000-0000-0000-000000000001') = '{}', 'leave type pay flag marks draft stale');
select pg_temp.computed('3000000c-0000-0000-0000-000000000001');
insert into employee_tax_years (employee_id, year, has_previous_employer, prev_taxable_basic, prev_tax_withheld)
values ('20000000-0000-0000-0000-0000000000f1', 2026, true, 300000, 12000);
select pg_temp.check(pg_temp.totals('3000000c-0000-0000-0000-000000000001') = '{}', 'tax-year data marks draft stale');
select pg_temp.computed('3000000c-0000-0000-0000-000000000001');
select set_config('request.jwt.claim.sub', :owner, true);
insert into statutory_versions (kind, effective_from, description, data)
select 'sss', '2026-11-01', 'test schedule', data from statutory_versions where kind = 'sss' order by effective_from desc limit 1;
select pg_temp.check(pg_temp.totals('3000000c-0000-0000-0000-000000000001') = '{}', 'statutory version marks draft stale');
rollback;

\echo '--- 11.2 a computing draft is hit by an employee change in its period'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ga, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month, totals)
values ('3000000c-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000c', 'regular', 'weekly', '2026-11-02', '2026-11-08', '2026-11-13', '2026-11-01', 1, 4, '{"computing":"tok-1"}');
insert into time_entries (employee_id, work_date, clock_in, clock_out)
values ('20000000-0000-0000-0000-0000000000f1', '2026-11-02', '2026-11-02T00:00:00Z', '2026-11-02T09:00:00Z');
select pg_temp.check(pg_temp.totals('3000000c-0000-0000-0000-000000000002') = '{}', 'computing token wiped by a time entry');
rollback;

\echo '--- 11.3 finalize refuses adjustments for someone the run does not pay; reopen needs a recompute'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ga, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('3000000c-0000-0000-0000-000000000003', '10000000-0000-0000-0000-00000000000c', 'regular', 'weekly', '2026-11-09', '2026-11-15', '2026-11-20', '2026-11-01', 2, 4);
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay) values ('3000000c-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000f1', 3775, 3775);
insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, category)
values ('3000000c-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000f2', 'earning', 'Unpaid OT', 1500, 'overtime');
select pg_temp.computed('3000000c-0000-0000-0000-000000000003');
select pg_temp.expect_error($$select public.finalize_payroll_run('3000000c-0000-0000-0000-000000000003')$$, '%no payslip for them%');
delete from payroll_adjustments where payroll_run_id = '3000000c-0000-0000-0000-000000000003';
select pg_temp.computed('3000000c-0000-0000-0000-000000000003');
select finalize_payroll_run('3000000c-0000-0000-0000-000000000003');
select reopen_payroll_run('3000000c-0000-0000-0000-000000000003');
select pg_temp.check(pg_temp.totals('3000000c-0000-0000-0000-000000000003') = '{}', 'reopened run must be recomputed');
select pg_temp.expect_error($$select public.finalize_payroll_run('3000000c-0000-0000-0000-000000000003')$$, '%Recompute the draft%');
rollback;

\echo '--- 11.4 reopen refuses an out-of-order unwind of the carry chain'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ga, true);
-- week A: exact 4530.40 -> pays 4530, carries 0.40
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('3000000c-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000c', 'regular', 'weekly', '2026-12-07', '2026-12-13', '2026-12-18', '2026-12-01', 2, 4);
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, rounding_adjustment, rounding_carry_in, rounding_carry_out)
values ('3000000c-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000f1', 4530.40, 4530, -0.40, 0, 0.40);
select pg_temp.computed('3000000c-0000-0000-0000-00000000000a');
select finalize_payroll_run('3000000c-0000-0000-0000-00000000000a');
-- week B: whole-peso week passes the 0.40 straight through
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('3000000c-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000c', 'regular', 'weekly', '2026-12-14', '2026-12-20', '2026-12-24', '2026-12-01', 3, 4);
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, rounding_adjustment, rounding_carry_in, rounding_carry_out)
values ('3000000c-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-0000000000f1', 3775, 3775, 0, 0.40, 0.40);
select pg_temp.computed('3000000c-0000-0000-0000-00000000000b');
select finalize_payroll_run('3000000c-0000-0000-0000-00000000000b');
select pg_temp.expect_error($$select public.reopen_payroll_run('3000000c-0000-0000-0000-00000000000a')$$, '%Reopen that later run first%');
select reopen_payroll_run('3000000c-0000-0000-0000-00000000000b');
select reopen_payroll_run('3000000c-0000-0000-0000-00000000000a');
select pg_temp.check((select rounding_balance from employees where id = '20000000-0000-0000-0000-0000000000f1') = 0, 'chain unwound in order');
rollback;

\echo '--- 11.5 approved leave on paid days cannot be deleted or re-pointed'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ga, true);
insert into leave_requests (id, employee_id, leave_type_id, start_date, end_date, days, status)
select '5000000c-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000f1', id, '2026-12-02', '2026-12-02', 1, 'approved'
from leave_types where entity_id = '10000000-0000-0000-0000-00000000000c' and code = 'SIL';
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('3000000c-0000-0000-0000-000000000004', '10000000-0000-0000-0000-00000000000c', 'regular', 'weekly', '2026-11-30', '2026-12-06', '2026-12-11', '2026-12-01', 1, 4);
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay) values ('3000000c-0000-0000-0000-000000000004', '20000000-0000-0000-0000-0000000000f1', 4530, 4530);
select pg_temp.computed('3000000c-0000-0000-0000-000000000004');
select finalize_payroll_run('3000000c-0000-0000-0000-000000000004');
select pg_temp.expect_error($$delete from leave_requests where id = '5000000c-0000-0000-0000-000000000002'$$, '%finalized payroll run%');
select pg_temp.expect_error($$update leave_requests set employee_id = '20000000-0000-0000-0000-0000000000f2' where id = '5000000c-0000-0000-0000-000000000002'$$, '%cannot move to another employee%');
rollback;

\echo '--- 11.6 audit: bookkeeping updates skipped, service-role writes name the admin'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ga, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('3000000c-0000-0000-0000-000000000005', '10000000-0000-0000-0000-00000000000c', 'regular', 'weekly', '2026-11-16', '2026-11-22', '2026-11-27', '2026-11-01', 3, 4);
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay) values ('3000000c-0000-0000-0000-000000000005', '20000000-0000-0000-0000-0000000000f1', 3775, 3775);
create temp table audit_mark on commit drop as select count(*) as n from audit_logs;
grant select on audit_mark to authenticated;
select pg_temp.computed('3000000c-0000-0000-0000-000000000005');
select pg_temp.check((select count(*) from audit_logs) = (select n from audit_mark), 'draft totals and payroll_seq writes are not audited');
select finalize_payroll_run('3000000c-0000-0000-0000-000000000005');
select pg_temp.check((select count(*) from audit_logs where table_name = 'payroll_runs' and record_id = '3000000c-0000-0000-0000-000000000005' and action = 'update') = 1, 'finalize is audited');
select pg_temp.check((select count(*) from audit_logs where table_name = 'employees' and record_id = '20000000-0000-0000-0000-0000000000f1' and created_at = now()) = 0, 'payroll_seq / carry bump not audited');
-- a signed-in admin cannot pose as someone else through the header
select set_config('request.headers', json_build_object('x-actor-id', :owner)::text, true);
update employees set position = 'Cashier' where id = '20000000-0000-0000-0000-0000000000f2';
select pg_temp.check((select actor_id from audit_logs where table_name = 'employees' and record_id = '20000000-0000-0000-0000-0000000000f2' order by id desc limit 1) = :ga, 'header ignored for signed-in users');
rollback;
begin;
-- the edge function (service role) acting for the entity admin
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.headers', json_build_object('x-actor-id', :ga)::text, true);
update employees set login_code_hint = 'XYZ', login_code_set_at = now() where id = '20000000-0000-0000-0000-0000000000f2';
select pg_temp.check((select actor_id from audit_logs where table_name = 'employees' and record_id = '20000000-0000-0000-0000-0000000000f2' order by id desc limit 1) = :ga, 'service-role write names the admin');
-- a malformed header is ignored, not an error
select set_config('request.headers', '{"x-actor-id":"not-a-uuid"}', true);
update employees set login_code_hint = 'ABC' where id = '20000000-0000-0000-0000-0000000000f2';
select pg_temp.check((select actor_id from audit_logs where table_name = 'employees' and record_id = '20000000-0000-0000-0000-0000000000f2' order by id desc limit 1) is null, 'bad header -> no actor');
rollback;

\echo '--- 11.7 the SQL editor (no user) can still clear a reviewed request''s entry link'
begin;
insert into time_entries (id, employee_id, work_date, clock_in, clock_out)
values ('6000000c-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000f2', '2026-11-03', '2026-11-03T00:00:00Z', '2026-11-03T09:00:00Z');
insert into time_correction_requests (employee_id, time_entry_id, work_date, reason, status)
values ('20000000-0000-0000-0000-0000000000f2', '6000000c-0000-0000-0000-000000000001', '2026-11-03', 'x', 'rejected');
delete from time_entries where id = '6000000c-0000-0000-0000-000000000001';
select pg_temp.check((select time_entry_id from time_correction_requests where employee_id = '20000000-0000-0000-0000-0000000000f2') is null, 'FK set null passes');
rollback;

\echo '--- 11.8 previous-employer status/reason; leave and tax-year changes are audited'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ga, true);
insert into employee_tax_years (employee_id, year, has_previous_employer, prev_employment_status, prev_separation_reason)
values ('20000000-0000-0000-0000-0000000000f2', 2026, true, 'contractual', 'end_of_contract');
select pg_temp.expect_error($$update employee_tax_years set prev_employment_status = 'boss' where employee_id = '20000000-0000-0000-0000-0000000000f2'$$, '%prev_employment_status_check%');
insert into leave_requests (id, employee_id, leave_type_id, start_date, end_date, days, status)
select '5000000c-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000f2', id, '2026-12-14', '2026-12-14', 1, 'pending'
from leave_types where entity_id = '10000000-0000-0000-0000-00000000000c' and code = 'SIL';
update leave_requests set status = 'approved' where id = '5000000c-0000-0000-0000-000000000009';
select pg_temp.check((select count(*) from audit_logs where table_name = 'leave_requests' and record_id = '5000000c-0000-0000-0000-000000000009') = 2, 'leave filing and approval audited');
select pg_temp.check((select count(*) from audit_logs where table_name = 'employee_tax_years' and entity_id = '10000000-0000-0000-0000-00000000000c') = 1, 'tax-year data audited under its client');
select pg_temp.check((select actor_id from audit_logs where table_name = 'leave_requests' order by id desc limit 1) = :ga, 'actor recorded');
rollback;

\echo 'ALL AUDIT-FIX TESTS PASSED'
