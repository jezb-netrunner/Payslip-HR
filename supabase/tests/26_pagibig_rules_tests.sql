-- Spec T11 (payroll tax rules spec, 2026-10-25, PENDING P5): Pag-IBIG's
-- monthly compensation (basic pay, mandated COLA, other regular allowances)
-- and its ceiling are settings for every client, defaulting to today's
-- rule, changed by company admins only; a change marks drafts for
-- recomputing.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set pa    '''00000000-0000-0000-0000-0000000000eb'''

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

\echo '--- 26.1 defaults: basic pay plus the regular allowances, the statutory ceiling'
select pg_temp.check((select pagibig_base_basic and pagibig_base_cola and pagibig_base_other_allowances and pagibig_ceiling is null
  from payroll_rules), 'today''s rule');

-- fixture: a client with a computed draft, and a client admin
insert into auth.users (id, email, raw_app_meta_data) values (:pa, 'pa@pag.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000000eb', 'PAG', 'Pag Co', 755);
insert into entity_admins (profile_id, entity_id) values (:pa, '10000000-0000-0000-0000-0000000000eb');
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('300000eb-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000eb', 'regular', 'monthly', '2026-11-01', '2026-11-30', '2026-11-30', '2026-11-01', 1, 1);
commit;
update payroll_runs set totals = '{"employees":0}' where id = '300000eb-0000-0000-0000-000000000001';

\echo '--- 26.2 company admins set the components and the ceiling'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select public.set_payroll_rule('pagibig_base_cola', 'false');
select pg_temp.check((select not pagibig_base_cola and pagibig_base_basic and pagibig_base_other_allowances from payroll_rules), 'COLA out');
select pg_temp.check((select totals = '{}'::jsonb from payroll_runs where id = '300000eb-0000-0000-0000-000000000001'), 'drafts marked for recomputing');
select public.set_payroll_rule('pagibig_base_other_allowances', 'false');
select public.set_payroll_rule('pagibig_ceiling', '15000');
select pg_temp.check((select pagibig_ceiling = 15000 and not pagibig_base_other_allowances from payroll_rules), 'ceiling and allowances');
select pg_temp.expect_error($$select public.set_payroll_rule('pagibig_base_basic', 'maybe')$$, '%true or false%');
select pg_temp.expect_error($$select public.set_payroll_rule('pagibig_ceiling', 'ten thousand')$$, '%amount in pesos%');
select pg_temp.expect_error($$select public.set_payroll_rule('pagibig_ceiling', '0')$$, '%payroll_rules_pagibig_ceiling_check%');
-- blank: back to the statutory table's maximum fund salary
select public.set_payroll_rule('pagibig_ceiling', '');
select public.set_payroll_rule('pagibig_base_cola', 'true');
select public.set_payroll_rule('pagibig_base_other_allowances', 'true');
select pg_temp.check((select pagibig_ceiling is null and pagibig_base_cola and pagibig_base_other_allowances from payroll_rules), 'back to the defaults');
-- the P4 rule still works
select public.set_payroll_rule('maternity_contributions', 'as_usual');
commit;
select pg_temp.check((select count(*) >= 5 from audit_logs where table_name = 'payroll_rules'), 'audit-logged');

\echo '--- 26.3 nobody else changes them'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :pa, true);
select pg_temp.check((select pagibig_ceiling is null from payroll_rules), 'every admin reads them');
select pg_temp.expect_error($$select public.set_payroll_rule('pagibig_ceiling', '20000')$$, '%company admin%');
select pg_temp.expect_error($$update payroll_rules set pagibig_ceiling = 20000$$, '%permission denied%');
commit;

\echo 'PASSED 26'
