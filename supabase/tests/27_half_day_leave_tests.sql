-- Tests for half-day leave: a request for one date can take the morning or
-- the afternoon only. It charges half a day whatever the caller sent,
-- maternity leave has none, the employee cannot change it after filing, and
-- the half of an approved leave inside a finalized payroll cannot change.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set ha    '''00000000-0000-0000-0000-000000000271'''
\set uh1   '''00000000-0000-0000-0000-000000000272'''

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

-- fixture: client HD with one admin and one employee who has a login
insert into auth.users (id, email, raw_app_meta_data) values (:ha, 'ha@hd.test', '{"role":"entity_admin"}');
update profiles set admin_session_id = null where id = :ha;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000027a0', 'HD', 'Half Day Co', 695);
insert into entity_admins (profile_id, entity_id) values (:ha, '10000000-0000-0000-0000-0000000027a0');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ha, true);
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate)
values ('20000000-0000-0000-0000-0000000027e1', '10000000-0000-0000-0000-0000000027a0', 'H-001', 'Hana', 'Diaz', '2024-01-08', 'monthly', 30000);
commit;
insert into auth.users (id, email, raw_app_meta_data) values
  (:uh1, 'emp-h1@x.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000027e1"}');

\echo '--- 27.1 an employee files a half day: it charges half a day whatever was sent'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :uh1, true);
insert into leave_requests (id, employee_id, leave_type_id, start_date, end_date, days, half_day)
select '50000027-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000027e1', id, '2026-10-06', '2026-10-06', 3, 'pm'
from leave_types where entity_id = '10000000-0000-0000-0000-0000000027a0' and code = 'SL';
select pg_temp.check((select days = 0.5 and half_day = 'pm' and status = 'pending' from leave_requests where id = '50000027-0000-0000-0000-000000000001'),
  'half a day charged, not the 3 days sent');
-- a whole-day request keeps the days it was filed with
insert into leave_requests (id, employee_id, leave_type_id, start_date, end_date, days)
select '50000027-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000027e1', id, '2026-10-08', '2026-10-09', 2
from leave_types where entity_id = '10000000-0000-0000-0000-0000000027a0' and code = 'SL';
select pg_temp.check((select days = 2 and half_day is null from leave_requests where id = '50000027-0000-0000-0000-000000000002'), 'whole days unchanged');
commit;

\echo '--- 27.2 a half day is one date, the morning or the afternoon'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :uh1, true);
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days, half_day)
  select '20000000-0000-0000-0000-0000000027e1', id, '2026-10-12', '2026-10-13', 1, 'am'
  from leave_types where entity_id = '10000000-0000-0000-0000-0000000027a0' and code = 'SL'$$, '%leave_requests_half_day_one_date%');
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days, half_day)
  select '20000000-0000-0000-0000-0000000027e1', id, '2026-10-12', '2026-10-12', 0.5, 'noon'
  from leave_types where entity_id = '10000000-0000-0000-0000-0000000027a0' and code = 'SL'$$, '%leave_requests_half_day_check%');
commit;

\echo '--- 27.3 maternity leave (calendar days) has no half day'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ha, true);
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days, half_day)
  select '20000000-0000-0000-0000-0000000027e1', id, '2026-10-12', '2026-10-12', 0.5, 'am'
  from leave_types where entity_id = '10000000-0000-0000-0000-0000000027a0' and code = 'ML'$$, '%Maternity leave runs in calendar days%');
commit;

\echo '--- 27.4 the employee cannot change the half after filing, only cancel'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :uh1, true);
select pg_temp.expect_error($$update leave_requests set half_day = 'am' where id = '50000027-0000-0000-0000-000000000001'$$, '%only cancel a pending request%');
select pg_temp.expect_error($$update leave_requests set half_day = null, days = 0 where id = '50000027-0000-0000-0000-000000000001'$$, '%only cancel a pending request%');
select pg_temp.expect_error($$update leave_requests set half_day = 'am' where id = '50000027-0000-0000-0000-000000000002'$$, '%only cancel a pending request%');
update leave_requests set status = 'cancelled' where id = '50000027-0000-0000-0000-000000000002';
select pg_temp.check((select status = 'cancelled' from leave_requests where id = '50000027-0000-0000-0000-000000000002'), 'cancelling still works');
commit;

\echo '--- 27.5 the admin approves it, and files one: half a day either way'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ha, true);
update leave_requests set status = 'approved', days = 1 where id = '50000027-0000-0000-0000-000000000001';
select pg_temp.check((select status = 'approved' and days = 0.5 and reviewed_by = :ha::uuid from leave_requests where id = '50000027-0000-0000-0000-000000000001'),
  'approved at half a day, by the admin');
insert into leave_requests (id, employee_id, leave_type_id, start_date, end_date, days, half_day, status)
select '50000027-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000027e1', id, '2026-10-20', '2026-10-20', 1, 'am', 'approved'
from leave_types where entity_id = '10000000-0000-0000-0000-0000000027a0' and code = 'LWOP';
select pg_temp.check((select days = 0.5 and half_day = 'am' from leave_requests where id = '50000027-0000-0000-0000-000000000003'), 'filed by the admin: half a day');
-- outside any finalized payroll the admin may still correct the half
update leave_requests set half_day = 'pm' where id = '50000027-0000-0000-0000-000000000003';
select pg_temp.check((select half_day = 'pm' from leave_requests where id = '50000027-0000-0000-0000-000000000003'), 'the half corrected before payroll');
commit;

\echo '--- 27.6 inside a finalized payroll the half of an approved leave cannot change'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ha, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('30000000-0000-0000-0000-0000000027a1', '10000000-0000-0000-0000-0000000027a0', 'regular', 'semi_monthly', '2026-10-01', '2026-10-15', '2026-10-15', '2026-10-01', 1, 2);
insert into payslips (payroll_run_id, employee_id, gross_pay, total_deductions, net_pay, earnings, deductions)
values ('30000000-0000-0000-0000-0000000027a1', '20000000-0000-0000-0000-0000000027e1', 15000, 0, 15000,
        jsonb_build_array(jsonb_build_object('code', 'basic', 'label', 'Basic Pay', 'amount', 15000)), '[]'::jsonb);
update payslips p set employee_payroll_seq = e.payroll_seq
  from employees e where e.id = p.employee_id and p.payroll_run_id = '30000000-0000-0000-0000-0000000027a1';
update payroll_runs set totals = jsonb_build_object('employees', 1, 'gross', 15000, 'net', 15000, 'withholding_tax', 0)
  where id = '30000000-0000-0000-0000-0000000027a1';
select public.finalize_payroll_run('30000000-0000-0000-0000-0000000027a1');
select pg_temp.check((select status = 'finalized' from payroll_runs where id = '30000000-0000-0000-0000-0000000027a1'), 'the payroll of Oct 1 to 15 is finalized');
select pg_temp.expect_error($$update leave_requests set half_day = 'am' where id = '50000027-0000-0000-0000-000000000001'$$, '%finalized payroll run%');
select pg_temp.expect_error($$update leave_requests set half_day = null, days = 1 where id = '50000027-0000-0000-0000-000000000001'$$, '%finalized payroll run%');
-- a whole-day leave of the period cannot be made a half day either
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days, half_day, status)
  select '20000000-0000-0000-0000-0000000027e1', id, '2026-10-07', '2026-10-07', 0.5, 'am', 'approved'
  from leave_types where entity_id = '10000000-0000-0000-0000-0000000027a0' and code = 'SL'$$, '%finalized payroll run%');
-- a note on it is no attendance change
update leave_requests set review_notes = 'Medical certificate on file' where id = '50000027-0000-0000-0000-000000000001';
select pg_temp.check((select review_notes = 'Medical certificate on file' and half_day = 'pm' from leave_requests where id = '50000027-0000-0000-0000-000000000001'),
  'the note saved, the half unchanged');
-- the leave after the period is still free
update leave_requests set half_day = 'am' where id = '50000027-0000-0000-0000-000000000003';
commit;

\echo 'ALL HALF-DAY LEAVE TESTS PASSED'
