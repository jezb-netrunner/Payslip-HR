-- Spec T12 (payroll tax rules spec, 2026-10-25): the statutory minimum wage
-- table (region, sector, daily rate, effective dates, wage order), kept by
-- company admins; a past-dated rate marks the region's open drafts for
-- recomputing (finalized payrolls stay); the WAGE_ORDER_TOPUP pay code; the
-- client's sector and holiday-pay setting.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set wa    '''00000000-0000-0000-0000-0000000000ec'''

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

\echo '--- 27.1 WAGE_ORDER_TOPUP: SMW for an MWE, R for others'
select pg_temp.check((select bir_bucket = 'basic' and income_class = 'regular' and tax_treatment = 'mwe_exempt' and for_one_time and not for_allowances
  and sss_include and not sss_include_pending and include_in_13th_month_base and active from pay_codes where code = 'WAGE_ORDER_TOPUP'), 'the code');

\echo '--- 27.2 client settings: sector and holiday pay after an unpaid absence'
insert into auth.users (id, email, raw_app_meta_data) values (:wa, 'wa@wage.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_region, minimum_wage_daily) values
  ('10000000-0000-0000-0000-0000000000ec', 'WGE', 'Wage Co', 'NCR', 645),
  ('10000000-0000-0000-0000-0000000000ed', 'CEB', 'Cebu Co', 'R7', 540);
insert into entity_admins (profile_id, entity_id) values (:wa, '10000000-0000-0000-0000-0000000000ec');
commit;
select pg_temp.check((select minimum_wage_sector = '' and holiday_pay_after_absence = 'apply_rule' from entities where id = '10000000-0000-0000-0000-0000000000ec'),
  'defaults: the general rate, apply the rule');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :wa, true);
select pg_temp.expect_error($$update entities set holiday_pay_after_absence = 'sometimes' where id = '10000000-0000-0000-0000-0000000000ec'$$, '%entities_holiday_pay_after_absence_check%');
update entities set holiday_pay_after_absence = 'pay_anyway', minimum_wage_sector = 'Agriculture' where id = '10000000-0000-0000-0000-0000000000ec';
update entities set holiday_pay_after_absence = 'apply_rule', minimum_wage_sector = '' where id = '10000000-0000-0000-0000-0000000000ec';
commit;

\echo '--- 27.3 company admins keep the table; everyone signed in reads it'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into minimum_wages (id, region, sector, daily_rate, effective_from, wage_order_ref) values
  ('500000ec-0000-0000-0000-000000000001', 'NCR', '', 645, '2025-07-17', 'NCR-26'),
  ('500000ec-0000-0000-0000-000000000002', 'R7', '', 540, '2025-10-01', 'ROVII-25');
select pg_temp.expect_error($$insert into minimum_wages (region, sector, daily_rate, effective_from, wage_order_ref) values ('NCR', '', 650, '2025-07-17', 'dup')$$, '%minimum_wages_once%');
select pg_temp.expect_error($$insert into minimum_wages (region, sector, daily_rate, effective_from, wage_order_ref) values ('NCR', '', 0, '2026-01-01', 'zero')$$, '%minimum_wages_daily_rate_check%');
select pg_temp.expect_error($$insert into minimum_wages (region, sector, daily_rate, effective_from, effective_to, wage_order_ref) values ('NCR', '', 700, '2026-05-01', '2026-04-30', 'x')$$, '%minimum_wages_dates%');
select pg_temp.expect_error($$insert into minimum_wages (region, sector, daily_rate, effective_from, wage_order_ref) values ('NCR', '', 700, '2026-05-01', '  ')$$, '%minimum_wages_wage_order_ref_check%');
select pg_temp.expect_error($$insert into minimum_wages (region, sector, daily_rate, effective_from, wage_order_ref) values ('NCR', ' Agriculture', 600, '2026-05-01', 'x')$$, '%minimum_wages_sector_check%');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :wa, true);
select pg_temp.check((select count(*) = 2 from minimum_wages), 'a client admin reads every region');
select pg_temp.expect_error($$insert into minimum_wages (region, sector, daily_rate, effective_from, wage_order_ref) values ('NCR', '', 700, '2026-05-01', 'x')$$, '%row-level security%');
update minimum_wages set daily_rate = 1 where id = '500000ec-0000-0000-0000-000000000001';
delete from minimum_wages where id = '500000ec-0000-0000-0000-000000000001';
commit;
select pg_temp.check((select daily_rate = 645 from minimum_wages where id = '500000ec-0000-0000-0000-000000000001'), 'untouched by a client admin');
begin;
set local role anon;
select pg_temp.expect_error($$select count(*) from minimum_wages$$, '%permission denied%');
commit;

\echo '--- 27.4 a past-dated rate marks the region''s drafts from that date for recomputing'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month) values
  ('300000ec-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000ec', 'regular', 'monthly', '2026-06-01', '2026-06-30', '2026-06-30', '2026-06-01', 1, 1),
  ('300000ec-0000-0000-0000-000000000002', '10000000-0000-0000-0000-0000000000ec', 'regular', 'monthly', '2026-09-01', '2026-09-30', '2026-09-30', '2026-09-01', 1, 1),
  ('300000ec-0000-0000-0000-000000000003', '10000000-0000-0000-0000-0000000000ed', 'regular', 'monthly', '2026-09-01', '2026-09-30', '2026-09-30', '2026-09-01', 1, 1);
commit;
update payroll_runs set totals = '{"employees":0}' where id in
  ('300000ec-0000-0000-0000-000000000001', '300000ec-0000-0000-0000-000000000002', '300000ec-0000-0000-0000-000000000003');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into minimum_wages (id, region, sector, daily_rate, effective_from, wage_order_ref)
  values ('500000ec-0000-0000-0000-000000000003', 'NCR', '', 695, '2026-07-17', 'NCR-27');
commit;
select pg_temp.check((select totals = '{"employees":0}'::jsonb from payroll_runs where id = '300000ec-0000-0000-0000-000000000001'), 'June: before the new rate');
select pg_temp.check((select totals = '{}'::jsonb from payroll_runs where id = '300000ec-0000-0000-0000-000000000002'), 'September: recompute');
select pg_temp.check((select totals = '{"employees":0}'::jsonb from payroll_runs where id = '300000ec-0000-0000-0000-000000000003'), 'another region: untouched');
-- moving the date back marks from the earlier of the two dates
update payroll_runs set totals = '{"employees":0}' where id = '300000ec-0000-0000-0000-000000000002';
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
update minimum_wages set effective_from = '2026-06-15' where id = '500000ec-0000-0000-0000-000000000003';
commit;
select pg_temp.check((select bool_and(totals = '{}'::jsonb) from payroll_runs where id in ('300000ec-0000-0000-0000-000000000001', '300000ec-0000-0000-0000-000000000002')),
  'June and September: recompute');
select pg_temp.check((select count(*) >= 4 from audit_logs where table_name = 'minimum_wages'), 'audit-logged');

\echo 'PASSED 27'
