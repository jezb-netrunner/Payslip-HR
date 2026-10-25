-- Spec T7 (payroll tax rules spec, 2026-10-25): one pay code per de minimis
-- item (RR 29-2025, items a and c–k), leave cash conversion with its days,
-- and the client's leave policy.
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

\echo '--- 23.1 a code per item'
select pg_temp.check(
  (select string_agg(de_minimis_item || ':' || code, ' ' order by de_minimis_item) from pay_codes where de_minimis_item is not null) =
  'a:LEAVE_CONVERSION c:DM_MEDICAL_DEPENDENTS d:DM_RICE e:DM_UNIFORM f:DM_MEDICAL_ASSISTANCE g:DM_LAUNDRY h:DM_ACHIEVEMENT i:DM_GIFTS j:DM_MEAL k:DM_CBA_PRODUCTIVITY',
  'items a and c–k');
select pg_temp.check((select bool_and(bir_bucket = 'de_minimis' and sss_include_pending and not sss_include)
  from pay_codes where de_minimis_item is not null), 'de minimis, SSS a setting (P2)');
select pg_temp.check((select not active from pay_codes where code = 'DE_MINIMIS'), 'the item-less code is retired');
select pg_temp.check((select for_one_time and not for_allowances from pay_codes where code = 'LEAVE_CONVERSION'), 'leave conversion is one-time');

\echo '--- 23.2 leave conversion needs its days; other pay has none'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000000f7', 'DMN', 'De Minimis Co', 755);
commit;
select pg_temp.check((select leave_policy = 'sil_only' from entities where id = '10000000-0000-0000-0000-0000000000f7'), 'leave policy: SIL only by default');
select pg_temp.expect_error($$update entities set leave_policy = 'unlimited' where id = '10000000-0000-0000-0000-0000000000f7'$$, '%entities_leave_policy_check%');
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate, pay_frequency)
values ('20000000-0000-0000-0000-0000000000f7', '10000000-0000-0000-0000-0000000000f7', 'D-001', 'Dee', 'Min', '2025-01-06', 'monthly', 21750, 'monthly');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('300000f7-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000f7', 'regular', 'monthly', '2026-06-01', '2026-06-30', '2026-06-30', '2026-06-01', 1, 1);
insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, pay_code, days)
  values ('300000f7-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000f7', 'earning', 'VL conversion', 15000, 'LEAVE_CONVERSION', 15);
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, pay_code)
  values ('300000f7-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000f7', 'earning', 'VL', 5000, 'LEAVE_CONVERSION')$$, '%days%');
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, pay_code, days)
  values ('300000f7-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000f7', 'earning', 'Rice', 2500, 'DM_RICE', 3)$$, '%days%');
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, pay_code, days)
  values ('300000f7-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000f7', 'earning', 'VL', 5000, 'LEAVE_CONVERSION', 0)$$, '%payroll_adjustments_days_check%');
-- the retired code: no new rows
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, pay_code)
  values ('300000f7-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000f7', 'earning', 'x', 100, 'DE_MINIMIS')$$, '%no longer in use%');
commit;

\echo 'PASSED 23'
