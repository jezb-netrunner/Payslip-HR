-- Tests for 20261023080941_leave_service_requirement.sql: leave types that
-- need months of service (SIL: 12) can't be filed or approved for days
-- before the employee is eligible, unless HR set that year's credits.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set da    '''00000000-0000-0000-0000-0000000000d9'''
\set ud1   '''00000000-0000-0000-0000-0000000000d1'''

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

\echo '--- 12.1 SIL needs 12 months of service; templates carry it to new clients'
select pg_temp.check((select min_service_months from leave_types where entity_id is null and code = 'SIL') = 12, 'SIL template: 12 months');
select pg_temp.check((select bool_and(min_service_months = 12) from leave_types where code = 'SIL'), 'every client''s SIL: 12 months');
-- Solo Parent Leave and Special Leave for Women: six months (RA 11861 Sec. 8; RA 9710 Sec. 18)
select pg_temp.check((select bool_and(min_service_months = 6) from leave_types where code in ('SPL', 'MCW')), 'SPL and MCW: 6 months');
select pg_temp.check((select bool_and(min_service_months = 0) from leave_types where code not in ('SIL', 'SPL', 'MCW')), 'other leaves: no requirement');

insert into auth.users (id, email, raw_app_meta_data) values (:da, 'da@delta.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-00000000000d', 'DELTA', 'Delta Services', 755);
insert into entity_admins (profile_id, entity_id) values (:da, '10000000-0000-0000-0000-00000000000d');
commit;
select pg_temp.check((select min_service_months from leave_types where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL') = 12, 'new client seeded with SIL 12 months');

-- hired Jan 31: eligible from Jan 31 next year; Feb 29 hires clamp like Postgres month arithmetic
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate, pay_frequency)
values ('20000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-00000000000d', 'D-001', 'Dina', 'Uno', '2026-01-31', 'daily', 755, 'semi_monthly'),
       ('20000000-0000-0000-0000-0000000000d2', '10000000-0000-0000-0000-00000000000d', 'D-002', 'Dan', 'Dos', '2024-02-29', 'daily', 755, 'semi_monthly');
insert into auth.users (id, email, raw_app_meta_data) values
  (:ud1, 'emp-d1@x.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000000d1"}');

\echo '--- 12.2 the employee cannot file SIL before eligibility, can after; other leaves any time'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ud1, true);
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days) select '20000000-0000-0000-0000-0000000000d1', id, '2026-11-03', '2026-11-03', 1 from leave_types where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL'$$,
  'Service Incentive Leave can be used after 12 months of service: from Jan 31, 2027 for this employee.%');
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days) select '20000000-0000-0000-0000-0000000000d1', id, '2027-01-30', '2027-02-01', 2 from leave_types where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL'$$, '%from Jan 31, 2027%');
insert into leave_requests (id, employee_id, leave_type_id, start_date, end_date, days)
select '5000000d-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000d1', id, '2027-01-31', '2027-01-31', 1
from leave_types where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL';
insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days)
select '20000000-0000-0000-0000-0000000000d1', id, '2026-11-03', '2026-11-03', 1
from leave_types where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'LWOP';
select pg_temp.check((select count(*) from leave_requests where employee_id = '20000000-0000-0000-0000-0000000000d1') = 2, 'eligible SIL and LWOP filed');
commit;

\echo '--- 12.3 the admin is held to the same rule; moving a pending SIL earlier is refused'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :da, true);
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days, status) select '20000000-0000-0000-0000-0000000000d1', id, '2026-12-01', '2026-12-01', 1, 'approved' from leave_types where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL'$$,
  '%To grant it sooner, set the employee''s 2026 leave credits.');
select pg_temp.expect_error($$update leave_requests set start_date = '2026-12-01', end_date = '2026-12-01' where id = '5000000d-0000-0000-0000-000000000001'$$, '%from Jan 31, 2027%');
-- Feb 29, 2024 + 12 months = Feb 28, 2025
insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days, status)
select '20000000-0000-0000-0000-0000000000d2', id, '2025-02-28', '2025-02-28', 1, 'approved'
from leave_types where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL';
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days) select '20000000-0000-0000-0000-0000000000d2', id, '2025-02-27', '2025-02-27', 1 from leave_types where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL'$$, '%from Feb 28, 2025%');
commit;

\echo '--- 12.4 credits set for the year grant it sooner; zero credits do not; approval re-checks'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :da, true);
insert into employee_leave_entitlements (employee_id, leave_type_id, year, days)
select '20000000-0000-0000-0000-0000000000d1', id, 2026, 0 from leave_types where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL';
select pg_temp.expect_error($$insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days) select '20000000-0000-0000-0000-0000000000d1', id, '2026-12-01', '2026-12-01', 1 from leave_types where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL'$$, '%from Jan 31, 2027%');
update employee_leave_entitlements set days = 2 where employee_id = '20000000-0000-0000-0000-0000000000d1';
insert into leave_requests (id, employee_id, leave_type_id, start_date, end_date, days)
select '5000000d-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000d1', id, '2026-12-01', '2026-12-01', 1
from leave_types where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL';
-- the credit is withdrawn before review: approving is refused, rejecting and cancelling are not
delete from employee_leave_entitlements where employee_id = '20000000-0000-0000-0000-0000000000d1';
select pg_temp.expect_error($$update leave_requests set status = 'approved' where id = '5000000d-0000-0000-0000-000000000002'$$, '%from Jan 31, 2027%');
update leave_requests set status = 'rejected' where id = '5000000d-0000-0000-0000-000000000002';
select pg_temp.check((select status from leave_requests where id = '5000000d-0000-0000-0000-000000000002') = 'rejected', 'rejecting an ineligible request still works');
commit;

\echo '--- 12.5 a client can lower or drop the requirement'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :da, true);
update leave_types set min_service_months = 0 where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL';
insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days)
select '20000000-0000-0000-0000-0000000000d1', id, '2026-12-02', '2026-12-02', 1
from leave_types where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL';
select pg_temp.expect_error($$update leave_types set min_service_months = -1 where entity_id = '10000000-0000-0000-0000-00000000000d' and code = 'SIL'$$, '%leave_types_min_service_months_check%');
commit;

\echo 'ALL LEAVE-SERVICE TESTS PASSED'
