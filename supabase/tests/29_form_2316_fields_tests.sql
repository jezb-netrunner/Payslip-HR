-- Owner's answer to the T10 question (2026-10-25): BIR Form 2316 September
-- 2021 (ENCS) items — the employee's RDO code (5), local home address and
-- ZIP (6B, 6C), foreign address (6D), and whether this employer is the main
-- or a secondary employer (15).
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''

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

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000000ef', 'TWO', '2316 Co', 755);
commit;
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate, pay_frequency)
values ('20000000-0000-0000-0000-0000000000ef', '10000000-0000-0000-0000-0000000000ef', 'T-001', 'Tess', 'Two', '2025-01-06', 'monthly', 30000, 'monthly');

\echo '--- 29.1 the employee''s items 5 and 6B to 6D'
select pg_temp.check((select rdo_code = '' and local_address is null and local_zip_code is null and foreign_address is null
  from employees where id = '20000000-0000-0000-0000-0000000000ef'), 'blank by default');
update employees set rdo_code = '21A', local_address = 'Antipolo', local_zip_code = '1870', foreign_address = '12 Rue X, Paris'
  where id = '20000000-0000-0000-0000-0000000000ef';
update employees set rdo_code = '039' where id = '20000000-0000-0000-0000-0000000000ef';
select pg_temp.expect_error($$update employees set rdo_code = 'RDO 39' where id = '20000000-0000-0000-0000-0000000000ef'$$, '%employees_rdo_code_check%');

\echo '--- 29.2 item 15: main employer unless said otherwise'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into employee_tax_years (employee_id, year) values ('20000000-0000-0000-0000-0000000000ef', 2026);
select pg_temp.check((select employer_type = 'main' from employee_tax_years where employee_id = '20000000-0000-0000-0000-0000000000ef'), 'main by default');
update employee_tax_years set employer_type = 'secondary' where employee_id = '20000000-0000-0000-0000-0000000000ef';
select pg_temp.expect_error($$update employee_tax_years set employer_type = 'tertiary' where employee_id = '20000000-0000-0000-0000-0000000000ef'$$, '%employee_tax_years_employer_type_check%');
commit;

\echo 'PASSED 29'
