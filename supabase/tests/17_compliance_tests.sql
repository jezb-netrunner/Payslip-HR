-- Tests for the compliance update of 2026-10-25 (change IDs C1–C10): the
-- client settings and their defaults, the pay-item and employee fields and
-- the database checks behind them.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set ma    '''00000000-0000-0000-0000-000000000117'''

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

-- fixture: client MU, its admin and an employee
insert into auth.users (id, email, raw_app_meta_data) values (:ma, 'ma@mu.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000017f0', 'MU', 'Mu Store', 700);
insert into entity_admins (profile_id, entity_id) values (:ma, '10000000-0000-0000-0000-0000000017f0');
commit;
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate, is_minimum_wage_earner)
values ('20000000-0000-0000-0000-0000000017f1', '10000000-0000-0000-0000-0000000017f0', 'M-001', 'Mia', 'Uno', '2025-01-06', 'daily', 700, true);

\echo '--- 17.1 C1: an MWE''s extra 30% for a regular holiday on the rest day is taxable by default; hazard certification on file'
select pg_temp.check((select mwe_rh_restday_premium_taxable from entities where id = '10000000-0000-0000-0000-0000000017f0'), 'default taxable (O1)');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ma, true);
update entities set mwe_rh_restday_premium_taxable = false where id = '10000000-0000-0000-0000-0000000017f0';
update employees set hazard_certification_ref = 'DOLE-RO-CAR 2026-118' where id = '20000000-0000-0000-0000-0000000017f1';
select pg_temp.expect_error($$update employees set hazard_certification_ref = repeat('x', 201) where id = '20000000-0000-0000-0000-0000000017f1'$$, '%employees_hazard_certification_ref_length%');
commit;
select pg_temp.check((select hazard_certification_ref from employees where id = '20000000-0000-0000-0000-0000000017f1') = 'DOLE-RO-CAR 2026-118', 'certification saved');

\echo 'PASSED 17'
