-- Tests for request limits and table privileges (migration
-- request_limits_and_privileges): a leave charges more than 0 and at most
-- its dates; reasons and review notes have a length limit; an employee's
-- pending requests have a limit; signed-in users hold no TRUNCATE,
-- REFERENCES or TRIGGER on public tables, now or for later tables.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set ra    '''00000000-0000-0000-0000-000000000281'''
\set ur1   '''00000000-0000-0000-0000-000000000282'''

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

-- fixture: client RL with one admin and one employee who has a login
insert into auth.users (id, email, raw_app_meta_data) values (:ra, 'ra@rl.test', '{"role":"entity_admin"}');
update profiles set admin_session_id = null where id = :ra;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000028a0', 'RL', 'Request Limits Co', 695);
insert into entity_admins (profile_id, entity_id) values (:ra, '10000000-0000-0000-0000-0000000028a0');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ra, true);
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate)
values ('20000000-0000-0000-0000-0000000028e1', '10000000-0000-0000-0000-0000000028a0', 'R-001', 'Rosa', 'Lim', '2024-01-08', 'monthly', 30000);
commit;
insert into auth.users (id, email, raw_app_meta_data) values
  (:ur1, 'emp-r1@x.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000028e1"}');

\echo '--- 28.1 a leave charges more than 0 and at most its dates'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ur1, true);
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days)
  select '20000000-0000-0000-0000-0000000028e1', id, '2026-11-23', '2026-11-27', -30 from leave_types where entity_id = '10000000-0000-0000-0000-0000000028a0' and code = 'SL'$$,
  '%charges more than 0 and at most 5 day/s%');
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days)
  select '20000000-0000-0000-0000-0000000028e1', id, '2026-12-01', '2026-12-12', 0 from leave_types where entity_id = '10000000-0000-0000-0000-0000000028a0' and code = 'SL'$$,
  '%charges more than 0%');
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days)
  select '20000000-0000-0000-0000-0000000028e1', id, '2026-12-01', '2026-12-02', 3 from leave_types where entity_id = '10000000-0000-0000-0000-0000000028a0' and code = 'SL'$$,
  '%at most 2 day/s%');
-- within the bounds is accepted (the app counts the workdays again at approval)
insert into leave_requests (id, employee_id, leave_type_id, start_date, end_date, days)
select '50000028-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000028e1', id, '2026-11-23', '2026-11-27', 5
from leave_types where entity_id = '10000000-0000-0000-0000-0000000028a0' and code = 'SL';
commit;
-- the admin cannot approve it with days beyond its dates either
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ra, true);
select pg_temp.expect_error($$update leave_requests set status = 'approved', days = 9 where id = '50000028-0000-0000-0000-000000000001'$$, '%at most 5 day/s%');
update leave_requests set status = 'approved', days = 4 where id = '50000028-0000-0000-0000-000000000001';
select pg_temp.check((select days = 4 and status = 'approved' from leave_requests where id = '50000028-0000-0000-0000-000000000001'), 'approved with the recounted days');
commit;

\echo '--- 28.2 reasons and review notes have a length limit'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ur1, true);
select pg_temp.expect_error(format($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason)
  select '20000000-0000-0000-0000-0000000028e1', id, '2026-12-07', '2026-12-07', 1, %L from leave_types where entity_id = '10000000-0000-0000-0000-0000000028a0' and code = 'SL'$$, repeat('x', 501)),
  '%leave_requests_reason_check%');
select pg_temp.expect_error(format($$insert into time_correction_requests (employee_id, work_date, reason) values ('20000000-0000-0000-0000-0000000028e1', '2026-11-20', %L)$$, repeat('x', 501)),
  '%time_correction_requests_reason_check%');
insert into time_correction_requests (employee_id, work_date, reason) values ('20000000-0000-0000-0000-0000000028e1', '2026-11-20', repeat('x', 500));
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ra, true);
select pg_temp.expect_error(format($$update time_correction_requests set review_notes = %L where employee_id = '20000000-0000-0000-0000-0000000028e1'$$, repeat('y', 1001)),
  '%time_correction_requests_review_notes_check%');
rollback;

\echo '--- 28.3 an employee has at most 20 pending leave requests, 31 pending corrections, 5 pending advance requests'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ur1, true);
insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days)
select '20000000-0000-0000-0000-0000000028e1', t.id, d::date, d::date, 1
from leave_types t, generate_series('2027-01-04'::date, '2027-01-23'::date, interval '1 day') d
where t.entity_id = '10000000-0000-0000-0000-0000000028a0' and t.code = 'SL';
select pg_temp.check((select count(*) = 20 from leave_requests where employee_id = '20000000-0000-0000-0000-0000000028e1' and status = 'pending'), 'twenty pending');
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days)
  select '20000000-0000-0000-0000-0000000028e1', id, '2027-02-01', '2027-02-01', 1 from leave_types where entity_id = '10000000-0000-0000-0000-0000000028a0' and code = 'SL'$$,
  '%already 20 pending leave requests%');
-- a cancelled one frees a place
update leave_requests set status = 'cancelled' where id = (select id from leave_requests where employee_id = '20000000-0000-0000-0000-0000000028e1' and status = 'pending' order by start_date limit 1);
insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days)
select '20000000-0000-0000-0000-0000000028e1', id, '2027-02-01', '2027-02-01', 1 from leave_types where entity_id = '10000000-0000-0000-0000-0000000028a0' and code = 'SL';

-- corrections: one already pending from 28.2, thirty more fill the queue
insert into time_correction_requests (employee_id, work_date, reason)
select '20000000-0000-0000-0000-0000000028e1', d::date, 'forgot to clock out'
from generate_series('2026-10-01'::date, '2026-10-30'::date, interval '1 day') d;
select pg_temp.expect_error($$insert into time_correction_requests (employee_id, work_date, reason) values ('20000000-0000-0000-0000-0000000028e1', '2026-10-31', 'x')$$,
  '%already 31 pending time corrections%');

insert into advance_requests (employee_id, amount, per_payroll, reason)
select '20000000-0000-0000-0000-0000000028e1', 1000, 500, 'school fees' from generate_series(1, 5);
select pg_temp.expect_error($$insert into advance_requests (employee_id, amount, per_payroll, reason) values ('20000000-0000-0000-0000-0000000028e1', 1000, 500, 'x')$$,
  '%already 5 pending cash-advance requests%');
rollback;

\echo '--- 28.4 no TRUNCATE, REFERENCES or TRIGGER on public tables, now or later'
select pg_temp.check(not exists (
  select 1 from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and (has_table_privilege('authenticated', c.oid, 'truncate') or has_table_privilege('authenticated', c.oid, 'references')
         or has_table_privilege('authenticated', c.oid, 'trigger') or has_table_privilege('anon', c.oid, 'truncate'))
), 'no truncate / references / trigger for API roles');
begin;
create table public.zz_later_table (id int);
select pg_temp.check(has_table_privilege('authenticated', 'public.zz_later_table', 'select')
  and not has_table_privilege('authenticated', 'public.zz_later_table', 'truncate')
  and not has_table_privilege('authenticated', 'public.zz_later_table', 'references')
  and not has_table_privilege('authenticated', 'public.zz_later_table', 'trigger'), 'a later table gets none either');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ra, true);
select pg_temp.expect_error($$truncate public.payslips$$, '%permission denied%');
rollback;

\echo 'PASSED 28'
