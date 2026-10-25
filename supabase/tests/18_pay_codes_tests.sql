-- Spec T2 (payroll tax rules spec, 2026-10-25): pay codes. Every allowance
-- and one-time earning carries one; the code decides the line's BIR bucket;
-- payslips store R, S and the withholding method.
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

\echo '--- 18.1 the pay codes on file'
select pg_temp.check((select count(*) from pay_codes) = 17, '17 pay codes');
select pg_temp.check(
  (select string_agg(code || ':' || bir_bucket || ':' || coalesce(income_class, '-') || ':' || tax_treatment
     || ':' || (case when for_allowances then 'A' else '' end) || (case when for_one_time then 'O' else '' end)
     || coalesce(':' || benefit, ''), ' ' order by code) from pay_codes) =
  'BASIC_ADJ:basic:regular:mwe_exempt:O BONUS:other_benefits:supplementary:benefits:AO '
  'COLA:cola:regular:mwe_exempt:AO COMMISSION:other_taxable:supplementary:taxable:O '
  'DE_MINIMIS:de_minimis:supplementary:de_minimis:AO FIXED_ALLOWANCE:other_taxable:regular:taxable:A '
  'HAZARD:hazard:supplementary:mwe_exempt:AO HOLIDAY_ADJ:holiday:supplementary:mwe_exempt:O '
  'HOUSING:housing:regular:taxable:AO MAT_DIFFERENTIAL:other_non_taxable:-:exempt:O:maternity_differential '
  'MAT_SSS_BENEFIT:other_non_taxable:-:exempt:O:sss_maternity NIGHT_DIFF_ADJ:night_diff:supplementary:mwe_exempt:O '
  'NON_TAXABLE:other_non_taxable:-:exempt:AO OTHER_TAXABLE:other_taxable:supplementary:taxable:O '
  'OVERTIME_ADJ:overtime:supplementary:mwe_exempt:O REPRESENTATION:representation:regular:taxable:AO '
  'TRANSPORTATION:transportation:regular:taxable:AO',
  'codes, buckets, R/S, tax rule and use match src/payroll/payCodes.ts');
-- every category an older screen may still send has a code
select pg_temp.check((select bool_and(public.default_pay_code(c, null, true) is not null)
  from unnest(array['de_minimis','other_benefits','hazard','representation','transportation','cola','housing',
                    'other_taxable','other_non_taxable']) c), 'every allowance category has a code');
select pg_temp.check((select bool_and(public.default_pay_code(c, null, false) is not null)
  from unnest(array['basic','holiday','overtime','night_diff','hazard','other_benefits','de_minimis','representation',
                    'transportation','cola','housing','other_taxable','other_non_taxable']) c), 'every one-time category has a code');

\echo '--- 18.2 no app role writes pay codes; signed-in users read them'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select pg_temp.check((select count(*) from pay_codes) = 17, 'a company admin reads them');
select pg_temp.expect_error($$insert into pay_codes (code, label, for_one_time, bir_bucket, income_class, tax_treatment)
  values ('X_CODE', 'x', true, 'other_taxable', 'supplementary', 'taxable')$$, '%permission denied%');
select pg_temp.expect_error($$update pay_codes set income_class = 'regular' where code = 'COMMISSION'$$, '%permission denied%');
select pg_temp.expect_error($$delete from pay_codes where code = 'COMMISSION'$$, '%permission denied%');
commit;
begin;
set local role anon;
select pg_temp.expect_error($$select * from pay_codes$$, '%permission denied%');
commit;
-- a malformed code is refused, whoever ships it
select pg_temp.expect_error($$insert into pay_codes (code, label, for_allowances, bir_bucket, income_class, tax_treatment)
  values ('BAD_ALLOWANCE', 'x', true, 'overtime', 'supplementary', 'mwe_exempt')$$, '%pay_codes_allowance_bucket%');
select pg_temp.expect_error($$insert into pay_codes (code, label, for_one_time, bir_bucket, income_class, tax_treatment)
  values ('BAD_RULE', 'x', true, 'overtime', 'supplementary', 'taxable')$$, '%pay_codes_tax_treatment%');

\echo '--- 18.3 allowances: the code decides the bucket; a category alone gets its code'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000000a8', 'PCD', 'Pay Code Co', 755);
commit;
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate, pay_frequency)
values ('20000000-0000-0000-0000-0000000000a8', '10000000-0000-0000-0000-0000000000a8', 'P-001', 'Pia', 'Code', '2025-01-06', 'monthly', 30000, 'monthly');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into employee_allowances (id, employee_id, label, amount, pay_code, basis)
  values ('a1000000-0000-0000-0000-0000000000a8', '20000000-0000-0000-0000-0000000000a8', 'Transport', 2000, 'TRANSPORTATION', 'monthly');
select pg_temp.check((select category from employee_allowances where id = 'a1000000-0000-0000-0000-0000000000a8') = 'transportation', 'category follows the code');
-- an older screen: category only
insert into employee_allowances (id, employee_id, label, amount, category, basis)
  values ('a2000000-0000-0000-0000-0000000000a8', '20000000-0000-0000-0000-0000000000a8', 'Rice', 1500, 'other_taxable', 'monthly');
select pg_temp.check((select pay_code from employee_allowances where id = 'a2000000-0000-0000-0000-0000000000a8') = 'FIXED_ALLOWANCE', 'other taxable allowance → FIXED_ALLOWANCE');
-- the older screen changes the category: the code follows
update employee_allowances set category = 'housing' where id = 'a2000000-0000-0000-0000-0000000000a8';
select pg_temp.check((select pay_code from employee_allowances where id = 'a2000000-0000-0000-0000-0000000000a8') = 'HOUSING', 'the code follows a category change');
-- a new screen changes the code: the category follows
update employee_allowances set pay_code = 'BONUS' where id = 'a2000000-0000-0000-0000-0000000000a8';
select pg_temp.check((select category from employee_allowances where id = 'a2000000-0000-0000-0000-0000000000a8') = 'other_benefits', 'the category follows a code change');
select pg_temp.expect_error($$insert into employee_allowances (employee_id, label, amount, pay_code, basis)
  values ('20000000-0000-0000-0000-0000000000a8', 'x', 100, 'COMMISSION', 'monthly')$$, '%not for recurring allowances%');
select pg_temp.expect_error($$insert into employee_allowances (employee_id, label, amount, pay_code, basis)
  values ('20000000-0000-0000-0000-0000000000a8', 'x', 100, 'NO_SUCH_CODE', 'monthly')$$, '%Unknown pay code%');
commit;

\echo '--- 18.4 one-time earnings: code, bucket and maternity benefit agree'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('300000a8-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000a8', 'regular', 'monthly', '2026-11-01', '2026-11-30', '2026-11-30', '2026-11-01', 1, 1);
insert into payroll_adjustments (id, payroll_run_id, employee_id, kind, label, amount, pay_code)
  values ('b1000000-0000-0000-0000-0000000000a8', '300000a8-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a8', 'earning', 'Commission (Oct)', 4000, 'COMMISSION');
select pg_temp.check((select category from payroll_adjustments where id = 'b1000000-0000-0000-0000-0000000000a8') = 'other_taxable', 'COMMISSION is other taxable');
insert into payroll_adjustments (id, payroll_run_id, employee_id, kind, label, amount, pay_code)
  values ('b2000000-0000-0000-0000-0000000000a8', '300000a8-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a8', 'earning', 'SSS maternity benefit', 20000, 'MAT_SSS_BENEFIT');
select pg_temp.check((select category = 'other_non_taxable' and benefit = 'sss_maternity' from payroll_adjustments where id = 'b2000000-0000-0000-0000-0000000000a8'), 'MAT_SSS_BENEFIT carries its benefit');
-- an older screen: category and benefit only
insert into payroll_adjustments (id, payroll_run_id, employee_id, kind, label, amount, category, benefit)
  values ('b3000000-0000-0000-0000-0000000000a8', '300000a8-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a8', 'earning', 'Differential', 5000, 'other_non_taxable', 'maternity_differential');
select pg_temp.check((select pay_code from payroll_adjustments where id = 'b3000000-0000-0000-0000-0000000000a8') = 'MAT_DIFFERENTIAL', 'benefit → MAT_DIFFERENTIAL');
insert into payroll_adjustments (id, payroll_run_id, employee_id, kind, label, amount, category)
  values ('b4000000-0000-0000-0000-0000000000a8', '300000a8-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a8', 'earning', 'Incentive', 1000, 'other_taxable');
select pg_temp.check((select pay_code from payroll_adjustments where id = 'b4000000-0000-0000-0000-0000000000a8') = 'OTHER_TAXABLE', 'one-time other taxable → OTHER_TAXABLE');
-- deductions have no pay code
insert into payroll_adjustments (id, payroll_run_id, employee_id, kind, label, amount, category)
  values ('b5000000-0000-0000-0000-0000000000a8', '300000a8-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a8', 'deduction', 'Union dues', 100, 'union_dues');
select pg_temp.check((select pay_code is null from payroll_adjustments where id = 'b5000000-0000-0000-0000-0000000000a8'), 'a deduction has no code');
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, category, pay_code)
  values ('300000a8-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a8', 'deduction', 'x', 100, 'union_dues', 'OTHER_TAXABLE')$$, '%deduction has no pay code%');
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, pay_code)
  values ('300000a8-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a8', 'earning', 'x', 100, 'FIXED_ALLOWANCE')$$, '%not for one-time earnings%');
commit;

\echo '--- 18.5 payslips store R, S and the withholding method'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, total_deductions, taxable_income, taxable_regular, taxable_supplementary, wht_method)
values ('300000a8-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a8', 34000, 30000, 4000, 31550, 27550, 4000, 'cam');
select pg_temp.check((select wht_method = 'cam' and taxable_regular = 27550 from payslips where payroll_run_id = '300000a8-0000-0000-0000-000000000001'), 'stored');
select pg_temp.expect_error($$update payslips set wht_method = 'guess' where payroll_run_id = '300000a8-0000-0000-0000-000000000001'$$, '%payslips_wht_method_check%');
select pg_temp.expect_error($$update payslips set taxable_supplementary = 5000 where payroll_run_id = '300000a8-0000-0000-0000-000000000001'$$, '%payslips_taxable_split%');
rollback;

\echo 'PASSED 18'
