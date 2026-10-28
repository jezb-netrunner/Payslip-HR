-- Tests for the pay-rate history: a new employee's rate starts it, the
-- employee row follows it, a rate changes only through it, admins only.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set na    '''00000000-0000-0000-0000-000000000181'''
\set ne    '''00000000-0000-0000-0000-000000000182'''

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

-- fixture: client NU, its admin, an employee and the employee's login
insert into auth.users (id, email, raw_app_meta_data) values (:na, 'na@nu.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000018f0', 'NU', 'Nu Traders', 700);
insert into entity_admins (profile_id, entity_id) values (:na, '10000000-0000-0000-0000-0000000018f0');
commit;

\echo '--- 18.1 a new employee''s rate starts the history at the hire date'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :na, true);
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate)
values ('20000000-0000-0000-0000-0000000018f1', '10000000-0000-0000-0000-0000000018f0', 'N-001', 'Nina', 'Uno', '2026-01-05', 'daily', 700);
select pg_temp.check((select count(*) = 1 and bool_and(effective_from = '2026-01-05' and pay_type = 'daily' and rate = 700 and reason = 'hired')
  from employee_pay_rates where employee_id = '20000000-0000-0000-0000-0000000018f1'), 'hired at 700 a day from the hire date');
commit;

insert into auth.users (id, email, raw_app_meta_data)
values (:ne, 'ne@nu.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000018f1"}');

\echo '--- 18.2 the employee row follows the history; a rate changes only through it'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :na, true);
insert into employee_pay_rates (employee_id, effective_from, pay_type, rate, reason, approved_by)
values ('20000000-0000-0000-0000-0000000018f1', '2026-07-05', 'monthly', 20000, 'regularized', 'Operations head');
select pg_temp.check((select pay_type = 'monthly' and monthly_rate = 20000 and daily_rate = 0 from employees where id = '20000000-0000-0000-0000-0000000018f1'),
  'regularized at 20,000 a month: the employee row follows');
select pg_temp.check((select entity_id = '10000000-0000-0000-0000-0000000018f0' from employee_pay_rates where effective_from = '2026-07-05'), 'client taken from the employee');
-- a change dated ahead waits for its date
insert into employee_pay_rates (employee_id, effective_from, pay_type, rate, reason)
values ('20000000-0000-0000-0000-0000000018f1', current_date + 30, 'monthly', 22000, 'merit_increase');
select pg_temp.check((select monthly_rate = 20000 from employees where id = '20000000-0000-0000-0000-0000000018f1'), 'a raise dated ahead waits');
select pg_temp.expect_error($$update employees set monthly_rate = 25000 where id = '20000000-0000-0000-0000-0000000018f1'$$, '%pay history%');
update employees set position = 'Cashier' where id = '20000000-0000-0000-0000-0000000018f1';
-- removing the current rate goes back to the one before it
delete from employee_pay_rates where employee_id = '20000000-0000-0000-0000-0000000018f1' and effective_from = '2026-07-05';
select pg_temp.check((select pay_type = 'daily' and daily_rate = 700 and monthly_rate = 0 from employees where id = '20000000-0000-0000-0000-0000000018f1'),
  'back to 700 a day');
delete from employee_pay_rates where employee_id = '20000000-0000-0000-0000-0000000018f1' and reason = 'merit_increase';
select pg_temp.expect_error($$delete from employee_pay_rates where employee_id = '20000000-0000-0000-0000-0000000018f1'$$, '%at least one pay rate%');
commit;

\echo '--- 18.3 admins only: not the employee, not another client''s admin'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ne, true);
select pg_temp.check((select count(*) from employee_pay_rates) = 0, 'the employee sees no pay history');
select pg_temp.expect_error($$insert into employee_pay_rates (employee_id, effective_from, pay_type, rate, reason) values ('20000000-0000-0000-0000-0000000018f1', '2026-08-01', 'daily', 900, 'adjustment')$$, '%Employee not found%');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000089', true);
select pg_temp.check((select count(*) from employee_pay_rates where employee_id = '20000000-0000-0000-0000-0000000018f1') = 0, 'another client''s admin sees none');
select pg_temp.expect_error($$insert into employee_pay_rates (employee_id, effective_from, pay_type, rate, reason) values ('20000000-0000-0000-0000-0000000018f1', '2026-08-01', 'daily', 900, 'adjustment')$$, '%Employee not found%');
commit;

\echo '--- 18.4 a rate change sends the employee''s drafts back for recompute; removing the employee removes the history'
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month, totals)
values ('30000000-0000-0000-0000-0000000018f1', '10000000-0000-0000-0000-0000000018f0', 'regular', 'semi_monthly', '2026-11-01', '2026-11-15', '2026-11-20', '2026-11-01', 1, 2, '{"gross": 1}');
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, total_deductions)
values ('30000000-0000-0000-0000-0000000018f1', '20000000-0000-0000-0000-0000000018f1', 7700, 7700, 0);
update payroll_runs set totals = '{"gross": 7700}' where id = '30000000-0000-0000-0000-0000000018f1';
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :na, true);
insert into employee_pay_rates (employee_id, effective_from, pay_type, rate, reason)
values ('20000000-0000-0000-0000-0000000018f1', '2026-11-09', 'daily', 750, 'wage_order');
commit;
select pg_temp.check((select totals = '{}'::jsonb from payroll_runs where id = '30000000-0000-0000-0000-0000000018f1'), 'the draft computes again');
delete from payroll_runs where id = '30000000-0000-0000-0000-0000000018f1';
delete from employees where id = '20000000-0000-0000-0000-0000000018f1';
select pg_temp.check((select count(*) from employee_pay_rates where employee_id = '20000000-0000-0000-0000-0000000018f1') = 0, 'history removed with the employee');

\echo 'PASSED 18'
