-- Owner's answer to the T3 question (2026-10-25): LIQUIDATED_ALLOWANCE is
-- only a liquidated business expense; BOARD_LODGING is the employee's own
-- board and lodging (taxable for rank-and-file, a fringe benefit for
-- managerial or supervisory staff); employees carry their job level.
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

\echo '--- 28.1 the codes'
select pg_temp.check((select label = 'Business expense reimbursement (liquidated)' and description like '%travel, representation%'
  and tax_treatment = 'exempt' and not sss_include and subject_to_liquidation and not fringe_benefit
  from pay_codes where code = 'LIQUIDATED_ALLOWANCE'), 'business expenses only');
select pg_temp.check((select for_allowances and for_one_time and bir_bucket = 'other_taxable' and income_class = 'regular'
  and tax_treatment = 'taxable' and sss_include and fringe_benefit and active
  from pay_codes where code = 'BOARD_LODGING'), 'board and lodging');
select pg_temp.check((select string_agg(code, ',') from pay_codes where fringe_benefit) = 'BOARD_LODGING', 'the only fringe benefit code');

\echo '--- 28.2 job level: rank and file by default'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000000ee', 'BNL', 'Board Co', 755);
commit;
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate, pay_frequency)
values ('20000000-0000-0000-0000-0000000000ee', '10000000-0000-0000-0000-0000000000ee', 'B-001', 'Bo', 'Lodge', '2025-01-06', 'monthly', 30000, 'monthly');
select pg_temp.check((select job_level = 'rank_and_file' from employees where id = '20000000-0000-0000-0000-0000000000ee'), 'default');
select pg_temp.expect_error($$update employees set job_level = 'executive' where id = '20000000-0000-0000-0000-0000000000ee'$$, '%employees_job_level_check%');
update employees set job_level = 'managerial_supervisory' where id = '20000000-0000-0000-0000-0000000000ee';
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into employee_allowances (employee_id, label, amount, basis, pay_code)
  values ('20000000-0000-0000-0000-0000000000ee', 'Board and lodging', 3000, 'monthly', 'BOARD_LODGING');
commit;
select pg_temp.check((select category = 'other_taxable' from employee_allowances where employee_id = '20000000-0000-0000-0000-0000000000ee'), 'the code sets the bucket');

\echo 'PASSED 28'
