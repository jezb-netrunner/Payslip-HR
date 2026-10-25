-- Spec T8 (payroll tax rules spec, 2026-10-25): tax the employer pays when
-- the year-end pay can't cover the shortfall. The payslip records it,
-- finalize records a paused advance without a signed authorization, reopen
-- removes it unless part of it was repaid, and its amount and release come
-- from the payroll only.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set ya    '''00000000-0000-0000-0000-0000000000e8'''

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

create or replace function pg_temp.computed(p_run uuid) returns void
language sql as $$
  update payslips p set employee_payroll_seq = e.payroll_seq
    from employees e where e.id = p.employee_id and p.payroll_run_id = p_run;
  update payroll_runs
    set totals = jsonb_build_object('employees', (select count(*) from payslips where payroll_run_id = p_run))
    where id = p_run;
$$;
grant execute on function pg_temp.computed(uuid) to authenticated;

-- fixture: client YEA with its admin, one employee
insert into auth.users (id, email, raw_app_meta_data) values (:ya, 'ya@yea.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000000e8', 'YEA', 'Year End Co', 755);
insert into entity_admins (profile_id, entity_id) values (:ya, '10000000-0000-0000-0000-0000000000e8');
commit;
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate, pay_frequency)
values ('20000000-0000-0000-0000-0000000000e8', '10000000-0000-0000-0000-0000000000e8', 'Y-001', 'Yuri', 'Endo', '2025-01-06', 'monthly', 20000, 'monthly');

\echo '--- 24.1 only an annualizing payslip carries tax paid by the employer'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ya, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month, annualize)
values ('300000e8-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000e8', 'regular', 'monthly', '2026-12-01', '2026-12-31', '2026-12-22', '2026-12-01', 1, 1, true);
select pg_temp.expect_error($$insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, total_deductions, withholding_tax, wht_method, tax_paid_by_employer)
  values ('300000e8-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000e8', 20000, 0, 20000, 10000, 'regular', 7500)$$, '%payslips_tax_paid_by_employer_check%');
select pg_temp.expect_error($$insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, total_deductions, withholding_tax, wht_method, tax_paid_by_employer)
  values ('300000e8-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000e8', 20000, 0, 20000, 10000, 'annualized', -1)$$, '%payslips_tax_paid_by_employer_check%');
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, total_deductions, withholding_tax, wht_method, tax_paid_by_employer)
  values ('300000e8-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000e8', 20000, 0, 20000, 10000, 'annualized', 7500);
select pg_temp.computed('300000e8-0000-0000-0000-000000000001');
commit;
select pg_temp.check((select tax_paid_by_employer from payslips where payroll_run_id = '300000e8-0000-0000-0000-000000000001') = 7500, 'stored');

\echo '--- 24.2 finalize records a paused advance without a signed authorization'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ya, true);
select pg_temp.expect_error($$insert into recurring_deductions (employee_id, label, category, amount_per_period, total_amount, balance, released_on, authorized_on, source_run_id)
  values ('20000000-0000-0000-0000-0000000000e8', 'Tax advance', 'cash_advance', 0, 100, 100, '2026-12-22', '2026-12-22', '300000e8-0000-0000-0000-000000000001')$$, '%recorded by finalizing that payroll%');
select public.finalize_payroll_run('300000e8-0000-0000-0000-000000000001');
select pg_temp.check((select count(*) = 1 from recurring_deductions where source_run_id = '300000e8-0000-0000-0000-000000000001'), 'one advance');
select pg_temp.check((
  select label = 'Tax paid by employer (2026 year-end adjustment)' and category = 'cash_advance' and total_amount = 7500 and balance = 7500
     and not active and amount_per_period = 0 and released_on = '2026-12-22' and authorized_on is null and employee_id = '20000000-0000-0000-0000-0000000000e8'
  from recurring_deductions where source_run_id = '300000e8-0000-0000-0000-000000000001'), 'paused, no authorization, the amount the employer paid');
commit;

\echo '--- 24.3 its amount and release come from the payroll; it stays on record'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ya, true);
select pg_temp.expect_error($$delete from recurring_deductions where source_run_id = '300000e8-0000-0000-0000-000000000001'$$, '%stays on record%');
-- deducting it from pay needs the employee's signed authorization first (so does any other change)
select pg_temp.expect_error($$update recurring_deductions set active = true where source_run_id = '300000e8-0000-0000-0000-000000000001'$$, '%signed the written authorization%');
update recurring_deductions set authorized_on = '2027-01-04', amount_per_period = 1000, label = 'Tax advance (2026)' where source_run_id = '300000e8-0000-0000-0000-000000000001';
select pg_temp.expect_error($$update recurring_deductions set total_amount = 5000, balance = 5000 where source_run_id = '300000e8-0000-0000-0000-000000000001'$$, '%come from that payroll%');
select pg_temp.expect_error($$update recurring_deductions set released_on = '2027-01-05' where source_run_id = '300000e8-0000-0000-0000-000000000001'$$, '%come from that payroll%');
select pg_temp.expect_error($$update recurring_deductions set source_run_id = null where source_run_id = '300000e8-0000-0000-0000-000000000001'$$, '%come from that payroll%');
select pg_temp.expect_error($$delete from recurring_deductions where source_run_id = '300000e8-0000-0000-0000-000000000001'$$, '%stays on record%');
update recurring_deductions set active = true where source_run_id = '300000e8-0000-0000-0000-000000000001';
select pg_temp.check((select active and authorized_on = '2027-01-04' from recurring_deductions where source_run_id = '300000e8-0000-0000-0000-000000000001'), 'resumed once authorized');
-- another advance can't be passed off as one
insert into recurring_deductions (id, employee_id, label, category, amount_per_period, total_amount, balance, released_on, authorized_on)
  values ('700000e8-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000e8', 'Cash advance', 'cash_advance', 100, 300, 300, '2026-12-01', '2026-12-01');
select pg_temp.expect_error($$update recurring_deductions set source_run_id = '300000e8-0000-0000-0000-000000000001' where id = '700000e8-0000-0000-0000-000000000001'$$, '%recorded by finalizing that payroll%');
delete from recurring_deductions where id = '700000e8-0000-0000-0000-000000000001';
commit;

\echo '--- 24.4 reopen removes it, unless part of it was repaid'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ya, true);
insert into advance_repayments (id, advance_id, paid_on, amount)
  values ('800000e8-0000-0000-0000-000000000001', (select id from recurring_deductions where source_run_id = '300000e8-0000-0000-0000-000000000001'), '2027-01-10', 1000);
select pg_temp.check((select balance = 6500 from recurring_deductions where source_run_id = '300000e8-0000-0000-0000-000000000001'), 'repaid 1,000');
select pg_temp.expect_error($$select public.reopen_payroll_run('300000e8-0000-0000-0000-000000000001')$$, '%Yuri Endo at this run''s year-end adjustment has already been repaid%');
select pg_temp.check((select status = 'finalized' from payroll_runs where id = '300000e8-0000-0000-0000-000000000001'), 'still finalized');
delete from advance_repayments where id = '800000e8-0000-0000-0000-000000000001';
select public.reopen_payroll_run('300000e8-0000-0000-0000-000000000001');
select pg_temp.check((select count(*) = 0 from recurring_deductions where source_run_id = '300000e8-0000-0000-0000-000000000001'), 'removed at reopen');
select pg_temp.check((select status = 'draft' from payroll_runs where id = '300000e8-0000-0000-0000-000000000001'), 'a draft again');
commit;

\echo '--- 24.5 finalizing again records it again'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ya, true);
select pg_temp.computed('300000e8-0000-0000-0000-000000000001');
select public.finalize_payroll_run('300000e8-0000-0000-0000-000000000001');
select pg_temp.check((select count(*) = 1 and bool_and(balance = 7500 and not active) from recurring_deductions where source_run_id = '300000e8-0000-0000-0000-000000000001'), 'recorded again, paused');
commit;

\echo 'PASSED 24'
