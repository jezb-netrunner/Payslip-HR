-- Spec T4 (payroll tax rules spec, 2026-10-25): maternity leave. The
-- differential's tax flag (P1) and 13th month flag (P9) are company-admin
-- settings; clients record their DOLE exemption from the differential; the
-- PhilHealth / Pag-IBIG rule during the leave is a setting (P4); a payslip
-- with errors can't be finalized.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set xm    '''00000000-0000-0000-0000-000000000020'''

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

\echo '--- 20.1 the maternity pay codes'
select pg_temp.check((select tax_treatment = 'taxable' and bir_bucket = 'other_taxable' and income_class = 'supplementary'
  and sss_include and not sss_include_pending and include_in_13th_month_base and tax_pending and thirteenth_pending
  from pay_codes where code = 'MAT_DIFFERENTIAL'), 'MAT_DIFFERENTIAL: taxable S, SSS, 13th month, P1 and P9 pending');
select pg_temp.check((select tax_treatment = 'exempt' and not sss_include and sss_include_pending and not include_in_13th_month_base
  from pay_codes where code = 'MAT_SSS_BENEFIT'), 'MAT_SSS_BENEFIT: exempt, SSS a setting (P3)');
select pg_temp.check((select string_agg(code, ',' order by code) from pay_codes where include_in_13th_month_base) = 'BASIC_ADJ,MAT_DIFFERENTIAL,WAGE_ORDER_TOPUP',
  'what counts toward the 13th month besides basic pay');

\echo '--- 20.2 company admins set P1 and P9; nothing else is a setting'
insert into auth.users (id, email, raw_app_meta_data) values (:xm, 'xm@mat.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select public.set_pay_code_rule('MAT_DIFFERENTIAL', 'taxable', false);
select pg_temp.check((select tax_treatment = 'exempt' and bir_bucket = 'other_non_taxable' and income_class is null
  from pay_codes where code = 'MAT_DIFFERENTIAL'), 'P1 exempt');
select public.set_pay_code_rule('MAT_DIFFERENTIAL', 'taxable', true);
select pg_temp.check((select tax_treatment = 'taxable' and bir_bucket = 'other_taxable' and income_class = 'supplementary'
  from pay_codes where code = 'MAT_DIFFERENTIAL'), 'P1 back to taxable');
select public.set_pay_code_rule('MAT_DIFFERENTIAL', 'include_in_13th_month_base', false);
select pg_temp.check((select not include_in_13th_month_base from pay_codes where code = 'MAT_DIFFERENTIAL'), 'P9 off');
select public.set_pay_code_rule('MAT_DIFFERENTIAL', 'include_in_13th_month_base', true);
select pg_temp.expect_error($$select public.set_pay_code_rule('COMMISSION', 'taxable', false)$$, '%not a setting%');
select pg_temp.expect_error($$select public.set_pay_code_rule('MAT_DIFFERENTIAL', 'sss_include', false)$$, '%not a setting%');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xm, true);
select pg_temp.expect_error($$select public.set_pay_code_rule('MAT_DIFFERENTIAL', 'taxable', false)$$, '%company admin%');
commit;

\echo '--- 20.3 a taxable differential saves; a maternity benefit classed as taxable still does not'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000000d4', 'MAT', 'Maternity Co', 755);
commit;
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate, pay_frequency)
values ('20000000-0000-0000-0000-0000000000d4', '10000000-0000-0000-0000-0000000000d4', 'M-001', 'Mia', 'Ter', '2025-01-06', 'monthly', 30000, 'monthly');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('300000d4-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000d4', 'regular', 'monthly', '2026-03-01', '2026-03-31', '2026-03-31', '2026-03-01', 1, 1);
insert into payroll_adjustments (id, payroll_run_id, employee_id, kind, label, amount, pay_code)
  values ('b1000000-0000-0000-0000-0000000000d4', '300000d4-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000d4', 'earning', 'Differential', 30000, 'MAT_DIFFERENTIAL');
select pg_temp.check((select category = 'other_taxable' and benefit = 'maternity_differential' from payroll_adjustments
  where id = 'b1000000-0000-0000-0000-0000000000d4'), 'taxable differential');
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, category, benefit)
  values ('300000d4-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000d4', 'earning', 'Taxed by mistake', 100, 'other_taxable', 'sss_maternity')$$,
  '%payroll_adjustments_benefit_kind%');
commit;

\echo '--- 20.4 the client''s DOLE exemption from the differential'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
update entities set maternity_exemption_category = 'small_retail_service', maternity_exemption_dole_ref = 'DOLE-NCR-2026-0042',
  maternity_exemption_year = 2026 where id = '10000000-0000-0000-0000-0000000000d4';
select pg_temp.check((select maternity_exemption_year = 2026 from entities where id = '10000000-0000-0000-0000-0000000000d4'), 'recorded');
select pg_temp.expect_error($$update entities set maternity_exemption_year = null where id = '10000000-0000-0000-0000-0000000000d4'$$,
  '%entities_maternity_exemption%');
select pg_temp.expect_error($$update entities set maternity_exemption_category = 'big_company' where id = '10000000-0000-0000-0000-0000000000d4'$$,
  '%entities_maternity_exemption_category_check%');
update entities set maternity_exemption_category = null, maternity_exemption_dole_ref = null, maternity_exemption_year = null
  where id = '10000000-0000-0000-0000-0000000000d4';
commit;

\echo '--- 20.5 the P4 setting: one row, company admins change it'
select pg_temp.check((select count(*) = 1 and bool_and(maternity_contributions = 'as_usual') from payroll_rules), 'default as usual');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select public.set_payroll_rule('maternity_contributions', 'pause_full_leave');
select pg_temp.check((select maternity_contributions = 'pause_full_leave' from payroll_rules), 'changed');
select pg_temp.expect_error($$select public.set_payroll_rule('maternity_contributions', 'whatever')$$, '%payroll_rules_maternity_contributions_check%');
select pg_temp.expect_error($$select public.set_payroll_rule('no_such_rule', 'x')$$, '%Unknown payroll rule%');
select pg_temp.expect_error($$update payroll_rules set maternity_contributions = 'as_usual'$$, '%permission denied%');
select public.set_payroll_rule('maternity_contributions', 'as_usual');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xm, true);
select pg_temp.check((select count(*) from payroll_rules) = 1, 'every admin reads it');
select pg_temp.expect_error($$select public.set_payroll_rule('maternity_contributions', 'pause_full_leave')$$, '%company admin%');
commit;

\echo '--- 20.6 a run whose payslips carry errors is not finalized'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
delete from payroll_adjustments where payroll_run_id = '300000d4-0000-0000-0000-000000000001';
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, total_deductions, computation_trace)
values ('300000d4-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000d4', 0, 0, 0,
        '{"notes":[],"warnings":[],"errors":["Differential required: no DOLE exemption approval for this year"]}');
commit;
update payslips p set employee_payroll_seq = e.payroll_seq from employees e
  where e.id = p.employee_id and p.payroll_run_id = '300000d4-0000-0000-0000-000000000001';
update payroll_runs set totals = '{"employees":1}' where id = '300000d4-0000-0000-0000-000000000001';
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select pg_temp.expect_error($$select public.finalize_payroll_run('300000d4-0000-0000-0000-000000000001')$$, '%Fix the errors%');
commit;

\echo 'PASSED 20'
