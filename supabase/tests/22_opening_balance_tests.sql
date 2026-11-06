-- Tests for opening balances (this employer's pay before go-live): the
-- client's admins only, sane amounts and dates, drafts recompute, audited.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set oa    '''00000000-0000-0000-0000-000000000221'''
\set ob    '''00000000-0000-0000-0000-000000000222'''
\set oe    '''00000000-0000-0000-0000-000000000223'''

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

-- fixture: clients OA and OB, an admin each, an employee of OA with a login
insert into auth.users (id, email, raw_app_meta_data) values
  (:oa, 'oa@oa.test', '{"role":"entity_admin"}'),
  (:ob, 'ob@ob.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values
  ('10000000-0000-0000-0000-0000000022a0', 'OA', 'Opening A', 700),
  ('10000000-0000-0000-0000-0000000022b0', 'OB', 'Opening B', 700);
insert into entity_admins (profile_id, entity_id) values
  (:oa, '10000000-0000-0000-0000-0000000022a0'),
  (:ob, '10000000-0000-0000-0000-0000000022b0');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :oa, true);
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate)
values ('20000000-0000-0000-0000-0000000022a1', '10000000-0000-0000-0000-0000000022a0', 'OA-001', 'Grace', 'Opening', '2023-09-01', 'monthly', 25000);
commit;
insert into auth.users (id, email, raw_app_meta_data)
values (:oe, 'oe@oa.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000022a1"}');

\echo '--- 22.1 the client''s admin records them; the client comes from the employee'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :oa, true);
insert into employee_opening_balances (employee_id, entity_id, year, paid_through, basic_salary, contributions, tax_withheld, thirteenth_basis)
values ('20000000-0000-0000-0000-0000000022a1', '10000000-0000-0000-0000-0000000022b0', 2026, '2026-09-30', 225000, 15750, 9300, 225000);
select pg_temp.check((select entity_id = '10000000-0000-0000-0000-0000000022a0' from employee_opening_balances
  where employee_id = '20000000-0000-0000-0000-0000000022a1'), 'client taken from the employee, not the caller');
select pg_temp.expect_error($$insert into employee_opening_balances (employee_id, year, paid_through) values ('20000000-0000-0000-0000-0000000022a1', 2026, '2026-06-30')$$,
  '%employee_opening_balances_employee_id_year_key%');
select pg_temp.expect_error($$insert into employee_opening_balances (employee_id, year, paid_through) values ('20000000-0000-0000-0000-0000000022a1', 2025, '2026-01-05')$$,
  '%employee_opening_balances_paid_through_year%');
select pg_temp.expect_error($$insert into employee_opening_balances (employee_id, year) values ('20000000-0000-0000-0000-0000000022a1', 2025)$$,
  '%paid_through%');
select pg_temp.expect_error($$update employee_opening_balances set tax_withheld = -1 where employee_id = '20000000-0000-0000-0000-0000000022a1'$$,
  '%tax_withheld_check%');
select pg_temp.expect_error($$update employee_opening_balances set other_benefits = -0.01 where employee_id = '20000000-0000-0000-0000-0000000022a1'$$,
  '%other_benefits_check%');
update employee_opening_balances set overtime_pay = 4000, thirteenth_month = 12500 where employee_id = '20000000-0000-0000-0000-0000000022a1';
commit;

\echo '--- 22.2 another client''s admin: nothing to see, nothing to write'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ob, true);
select pg_temp.check((select count(*) from employee_opening_balances) = 0, 'OB''s admin sees none of OA''s');
select pg_temp.expect_error($$insert into employee_opening_balances (employee_id, year, paid_through) values ('20000000-0000-0000-0000-0000000022a1', 2025, '2025-12-31')$$,
  '%row-level security%');
update employee_opening_balances set tax_withheld = 0;
delete from employee_opening_balances;
commit;
select pg_temp.check((select count(*) = 1 and bool_and(tax_withheld = 9300) from employee_opening_balances), 'OB''s update and delete touched nothing');

\echo '--- 22.3 the employee: no access (pay shows on payslips)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :oe, true);
select pg_temp.check((select count(*) from employee_opening_balances) = 0, 'the employee sees none, not even their own');
select pg_temp.expect_error($$insert into employee_opening_balances (employee_id, year, paid_through) values ('20000000-0000-0000-0000-0000000022a1', 2025, '2025-12-31')$$,
  '%row-level security%');
update employee_opening_balances set tax_withheld = 0;
delete from employee_opening_balances;
commit;
select pg_temp.check((select tax_withheld = 9300 from employee_opening_balances), 'the employee changed nothing');

\echo '--- 22.4 signed out: no privileges at all; the company admin reads every client'
begin;
set local role anon;
select pg_temp.expect_error($$select count(*) from employee_opening_balances$$, '%permission denied%');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select pg_temp.check((select count(*) from employee_opening_balances) = 1, 'company admin reads it');
rollback;

\echo '--- 22.5 a change sends the employee''s drafts back for recompute and is audited'
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month, totals)
values ('30000000-0000-0000-0000-0000000022a1', '10000000-0000-0000-0000-0000000022a0', 'regular', 'semi_monthly', '2026-10-16', '2026-10-31', '2026-11-05', '2026-10-01', 2, 2, '{"gross": 1}');
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, total_deductions)
values ('30000000-0000-0000-0000-0000000022a1', '20000000-0000-0000-0000-0000000022a1', 12500, 12500, 0);
update payroll_runs set totals = '{"gross": 12500}' where id = '30000000-0000-0000-0000-0000000022a1';
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :oa, true);
update employee_opening_balances set tax_withheld = 9350 where employee_id = '20000000-0000-0000-0000-0000000022a1';
commit;
select pg_temp.check((select totals = '{}'::jsonb from payroll_runs where id = '30000000-0000-0000-0000-0000000022a1'), 'the draft computes again');
select pg_temp.check((select count(*) from audit_logs where table_name = 'employee_opening_balances'
  and entity_id = '10000000-0000-0000-0000-0000000022a0') = 3, 'insert and both updates audited under the client');
select pg_temp.check((select actor_id from audit_logs where table_name = 'employee_opening_balances' order by id desc limit 1) = :oa, 'actor recorded');
-- an update that changes nothing but the timestamp leaves the draft alone
update payroll_runs set totals = '{"gross": 12500}' where id = '30000000-0000-0000-0000-0000000022a1';
update employee_opening_balances set notes = notes where employee_id = '20000000-0000-0000-0000-0000000022a1';
select pg_temp.check((select totals <> '{}'::jsonb from payroll_runs where id = '30000000-0000-0000-0000-0000000022a1'), 'a no-op update is not a change');

\echo '--- 22.6 removing the employee removes them'
delete from payroll_runs where id = '30000000-0000-0000-0000-0000000022a1';
delete from employees where id = '20000000-0000-0000-0000-0000000022a1';
select pg_temp.check((select count(*) from employee_opening_balances where employee_id = '20000000-0000-0000-0000-0000000022a1') = 0, 'removed with the employee');

\echo 'PASSED 22'
