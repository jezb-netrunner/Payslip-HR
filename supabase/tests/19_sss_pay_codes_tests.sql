-- Spec T3 (payroll tax rules spec, 2026-10-25): the SSS base by pay code.
-- sss_include on every code; the Christmas bonus and liquidated allowances
-- are out; the PENDING P2/P3 codes are settings company admins change.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set xs    '''00000000-0000-0000-0000-000000000019'''

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

\echo '--- 19.1 sss_include and the new codes'
select pg_temp.check(
  (select string_agg(code || ':' || (case when sss_include then 'in' else 'out' end) || (case when sss_include_pending then '?' else '' end),
     ' ' order by code) from pay_codes
   -- the codes of T2 and T3 (T7's de minimis items: suite 23)
   where code in ('BASIC_ADJ','BONUS','CHRISTMAS_BONUS','COLA','COMMISSION','DE_MINIMIS','FIXED_ALLOWANCE','HAZARD','HOLIDAY_ADJ',
                  'HOUSING','LIQUIDATED_ALLOWANCE','MAT_DIFFERENTIAL','MAT_SSS_BENEFIT','NIGHT_DIFF_ADJ','NON_TAXABLE','OTHER_TAXABLE',
                  'OVERTIME_ADJ','REPRESENTATION','THIRTEENTH_MONTH','TRANSPORTATION')) =
  'BASIC_ADJ:in BONUS:in CHRISTMAS_BONUS:out COLA:in COMMISSION:in DE_MINIMIS:out? FIXED_ALLOWANCE:in HAZARD:in '
  'HOLIDAY_ADJ:in HOUSING:in LIQUIDATED_ALLOWANCE:out MAT_DIFFERENTIAL:in MAT_SSS_BENEFIT:out? NIGHT_DIFF_ADJ:in '
  'NON_TAXABLE:out? OTHER_TAXABLE:in OVERTIME_ADJ:in REPRESENTATION:in THIRTEENTH_MONTH:out? TRANSPORTATION:in',
  'sss_include per code matches src/payroll/payCodes.ts');
select pg_temp.check((select is_christmas_bonus and bir_bucket = 'other_benefits' and for_one_time and not for_allowances
  from pay_codes where code = 'CHRISTMAS_BONUS'), 'CHRISTMAS_BONUS');
select pg_temp.check((select subject_to_liquidation and bir_bucket = 'other_non_taxable' and tax_treatment = 'exempt'
  from pay_codes where code = 'LIQUIDATED_ALLOWANCE'), 'LIQUIDATED_ALLOWANCE');
select pg_temp.check((select bir_bucket = 'thirteenth' and not for_allowances and not for_one_time
  from pay_codes where code = 'THIRTEENTH_MONTH'), 'THIRTEENTH_MONTH is the 13th month run''s own code');
select pg_temp.check((select count(*) from pay_codes where is_christmas_bonus) = 1, 'one Christmas bonus code');
-- a Christmas bonus or a liquidated allowance in the SSS base is refused, whoever ships it
select pg_temp.expect_error($$update pay_codes set sss_include = true where code = 'CHRISTMAS_BONUS'$$, '%pay_codes_sss_exclusions%');
select pg_temp.expect_error($$update pay_codes set sss_include = true where code = 'LIQUIDATED_ALLOWANCE'$$, '%pay_codes_sss_exclusions%');

\echo '--- 19.2 a company admin switches a pending code; nobody else, and only those'
insert into auth.users (id, email, raw_app_meta_data) values (:xs, 'xs@sss.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000000b9', 'SSB', 'SSS Base Co', 755);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month, totals)
values ('300000b9-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000b9', 'regular', 'monthly', '2026-11-01', '2026-11-30', '2026-11-30', '2026-11-01', 1, 1, '{"employees":0}');
select public.set_pay_code_sss_include('DE_MINIMIS', true);
select pg_temp.check((select sss_include from pay_codes where code = 'DE_MINIMIS'), 'switched on');
select pg_temp.check((select totals = '{}'::jsonb from payroll_runs where id = '300000b9-0000-0000-0000-000000000001'), 'drafts marked for recomputing');
select pg_temp.check((select count(*) from audit_logs where table_name = 'pay_codes' and actor_id = :owner) = 1, 'audit-logged');
select pg_temp.expect_error($$select public.set_pay_code_sss_include('BONUS', false)$$, '%not a setting%');
select pg_temp.expect_error($$update pay_codes set sss_include = false where code = 'DE_MINIMIS'$$, '%permission denied%');
select public.set_pay_code_sss_include('DE_MINIMIS', false);
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xs, true);
select pg_temp.expect_error($$select public.set_pay_code_sss_include('DE_MINIMIS', true)$$, '%company admin%');
commit;
begin;
set local role anon;
select pg_temp.expect_error($$select public.set_pay_code_sss_include('DE_MINIMIS', true)$$, '%permission denied%');
commit;
select pg_temp.check((select not sss_include from pay_codes where code = 'DE_MINIMIS'), 'back to the default');

\echo 'PASSED 19'
