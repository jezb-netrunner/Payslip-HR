-- Owner's answer to the T12 question (2026-10-25): MWE status follows the pay
-- rate. The apprentice rule (an apprentice or learner paid 75% of the
-- minimum is a minimum wage earner) is PENDING: a setting, on by default,
-- changed by company admins only. The old MWE checkbox stays as the status
-- admins last reviewed: saving it alone doesn't mark drafts for recomputing
-- (payroll no longer reads it).
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set ra    '''00000000-0000-0000-0000-0000000000e7'''

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

\echo '--- 30.1 the apprentice rule: on by default'
select pg_temp.check((select apprentice_mwe from payroll_rules), 'on by default');

-- fixture: a client with a computed draft, an employee, and a client admin
insert into auth.users (id, email, raw_app_meta_data) values (:ra, 'ra@review.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000000e7', 'REV', 'Review Co', 695);
insert into entity_admins (profile_id, entity_id) values (:ra, '10000000-0000-0000-0000-0000000000e7');
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('300000e7-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000e7', 'regular', 'monthly', '2026-11-01', '2026-11-30', '2026-11-30', '2026-11-01', 1, 1);
commit;
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate, monthly_rate, pay_frequency, is_minimum_wage_earner)
values ('20000000-0000-0000-0000-0000000000e7', '10000000-0000-0000-0000-0000000000e7', 'R-001', 'Rita', 'Review', '2025-01-06', 'daily', 700, 0, 'monthly', true);
update payroll_runs set totals = '{"employees":0}' where id = '300000e7-0000-0000-0000-000000000001';

\echo '--- 30.2 company admins change it, and drafts are marked for recomputing'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select public.set_payroll_rule('apprentice_mwe', 'false');
select pg_temp.check((select not apprentice_mwe from payroll_rules), 'off');
select pg_temp.check((select totals = '{}'::jsonb from payroll_runs where id = '300000e7-0000-0000-0000-000000000001'), 'drafts marked for recomputing');
select pg_temp.expect_error($$select public.set_payroll_rule('apprentice_mwe', 'maybe')$$, '%true or false%');
select public.set_payroll_rule('apprentice_mwe', 'true');
-- the other rules still work
select public.set_payroll_rule('pagibig_base_cola', 'true');
select public.set_payroll_rule('maternity_contributions', 'as_usual');
commit;
select pg_temp.check((select apprentice_mwe from payroll_rules), 'back on');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ra, true);
select pg_temp.expect_error($$select public.set_payroll_rule('apprentice_mwe', 'false')$$, '%company admin%');
commit;

\echo '--- 30.3 the status last reviewed: saving it alone leaves drafts as they are'
update payroll_runs set totals = '{"employees":1}' where id = '300000e7-0000-0000-0000-000000000001';
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ra, true);
update employees set is_minimum_wage_earner = false where id = '20000000-0000-0000-0000-0000000000e7';
commit;
select pg_temp.check((select not is_minimum_wage_earner from employees where id = '20000000-0000-0000-0000-0000000000e7'), 'saved');
select pg_temp.check((select totals = '{"employees":1}'::jsonb from payroll_runs where id = '300000e7-0000-0000-0000-000000000001'), 'draft untouched');
-- anything payroll reads still marks the client's drafts
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ra, true);
update employees set daily_rate = 720 where id = '20000000-0000-0000-0000-0000000000e7';
commit;
select pg_temp.check((select totals = '{}'::jsonb from payroll_runs where id = '300000e7-0000-0000-0000-000000000001'), 'a rate change: recompute');

\echo 'PASSED 30'
