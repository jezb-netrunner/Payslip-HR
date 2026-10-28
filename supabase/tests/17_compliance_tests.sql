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

\echo '--- 17.2 C4: de minimis ceilings are read-only reference data, every pay item names its benefit'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ma, true);
select pg_temp.check((select (data->'ceilings'->'rice'->>'limit')::numeric from legal_parameters where key = 'de_minimis' and effective_from = '2026-01-06') = 2500, 'rice 2,500 a month from 6 Jan 2026');
select pg_temp.expect_error($$insert into legal_parameters (key, effective_from, data, description, legal_basis, source_url) values ('de_minimis', '2027-01-01', '{}', 'x', 'x', 'https://x')$$, '%permission denied%');
select pg_temp.expect_error($$update legal_parameters set verified_on = '2026-10-26' where key = 'de_minimis'$$, '%permission denied%');
select pg_temp.check((select paid_vl_days_per_year from entities where id = '10000000-0000-0000-0000-0000000017f0') = 0, 'no VL days by default');
select pg_temp.check((select sil_conversion_taxable from entities where id = '10000000-0000-0000-0000-0000000017f0'), 'SIL conversion taxable by default (O7)');
insert into employee_allowances (employee_id, label, amount, category, basis, de_minimis_kind)
values ('20000000-0000-0000-0000-0000000017f1', 'Rice subsidy', 2500, 'de_minimis', 'monthly', 'rice');
select pg_temp.expect_error($$insert into employee_allowances (employee_id, label, amount, category, basis) values ('20000000-0000-0000-0000-0000000017f1', 'Gym', 500, 'de_minimis', 'monthly')$$, '%employee_allowances_de_minimis_named%');
select pg_temp.expect_error($$insert into employee_allowances (employee_id, label, amount, category, basis, de_minimis_kind) values ('20000000-0000-0000-0000-0000000017f1', 'VL', 500, 'de_minimis', 'monthly', 'monetized_vl')$$, '%employee_allowances_de_minimis_kind_check%');
commit;
-- the table owner (a migration) still validates what it ships
select pg_temp.expect_error($$insert into legal_parameters (key, effective_from, data, description, legal_basis, source_url) values ('de_minimis', '2027-01-01', '{"ceilings": {"rice": {"limit": 2500, "per": "month"}}}', 'x', 'x', 'https://x')$$, '%legal_parameters_data_check%');
-- leave converted to cash carries its days
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('30000000-0000-0000-0000-0000000017f1', '10000000-0000-0000-0000-0000000017f0', 'regular', 'semi_monthly', '2026-11-01', '2026-11-15', '2026-11-20', '2026-11-01', 1, 2);
insert into payroll_adjustments (payroll_run_id, employee_id, entity_id, kind, label, amount, category, de_minimis_kind, leave_days)
values ('30000000-0000-0000-0000-0000000017f1', '20000000-0000-0000-0000-0000000017f1', '10000000-0000-0000-0000-0000000017f0', 'earning', 'Unused VL (14 days)', 9800, 'de_minimis', 'monetized_vl', 14);
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, entity_id, kind, label, amount, category, de_minimis_kind) values ('30000000-0000-0000-0000-0000000017f1', '20000000-0000-0000-0000-0000000017f1', '10000000-0000-0000-0000-0000000017f0', 'earning', 'Unused VL', 9800, 'de_minimis', 'monetized_vl')$$, '%payroll_adjustments_leave_conversion%');
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, entity_id, kind, label, amount, category) values ('30000000-0000-0000-0000-0000000017f1', '20000000-0000-0000-0000-0000000017f1', '10000000-0000-0000-0000-0000000017f0', 'earning', 'Gift', 900, 'de_minimis')$$, '%payroll_adjustments_de_minimis_named%');

\echo '--- 17.3 C5: the 13th month is SSS compensation by default, the Christmas bonus and liquidated allowances are typed'
select pg_temp.check((select sss_include_13th_month from entities where id = '10000000-0000-0000-0000-0000000017f0'), 'default include (O2)');
insert into employee_allowances (employee_id, label, amount, category, basis, pay_item_type)
values ('20000000-0000-0000-0000-0000000017f1', 'Transport reimbursement', 3000, 'transportation', 'monthly', 'liquidated_allowance');
select pg_temp.expect_error($$insert into employee_allowances (employee_id, label, amount, category, basis, pay_item_type) values ('20000000-0000-0000-0000-0000000017f1', 'Bonus', 3000, 'transportation', 'monthly', 'christmas_bonus')$$, '%employee_allowances_pay_item_type_category%');
insert into payroll_adjustments (payroll_run_id, employee_id, entity_id, kind, label, amount, category, pay_item_type)
values ('30000000-0000-0000-0000-0000000017f1', '20000000-0000-0000-0000-0000000017f1', '10000000-0000-0000-0000-0000000017f0', 'earning', 'Christmas bonus', 3000, 'other_benefits', 'christmas_bonus');
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, entity_id, kind, label, amount, category, pay_item_type) values ('30000000-0000-0000-0000-0000000017f1', '20000000-0000-0000-0000-0000000017f1', '10000000-0000-0000-0000-0000000017f0', 'deduction', 'Union dues', 300, 'union_dues', 'christmas_bonus')$$, '%payroll_adjustments_pay_item_type_category%');

\echo '--- 17.4 C6: a DOLE exemption from the maternity differential is documented'
select pg_temp.check(not (select maternity_differential_exempt from entities where id = '10000000-0000-0000-0000-0000000017f0'), 'not exempt by default');
select pg_temp.expect_error($$update entities set maternity_differential_exempt = true where id = '10000000-0000-0000-0000-0000000017f0'$$, '%entities_dole_exemption_documented%');
update entities set maternity_differential_exempt = true, dole_exemption_ref = 'DOLE-CAR-2026-0042', dole_exemption_valid_until = '2026-12-31'
  where id = '10000000-0000-0000-0000-0000000017f0';

\echo '--- 17.5 C7: the PhilHealth NG share needs the ID; a solo parent''s ID has an expiry; payslips record the NG half'
select pg_temp.expect_error($$update employees set ph_ng_type = 'solo_parent', ph_ng_from_month = '2026-11-01' where id = '20000000-0000-0000-0000-0000000017f1'$$, '%employees_ph_ng_documented%');
select pg_temp.expect_error($$update employees set ph_ng_type = 'solo_parent', ph_ng_from_month = '2026-11-01', id_number = 'SPIC-2026-0099' where id = '20000000-0000-0000-0000-0000000017f1'$$, '%employees_ph_ng_documented%');
select pg_temp.expect_error($$update employees set ph_ng_type = 'pwd', ph_ng_from_month = '2026-11-15', id_number = 'PWD-1' where id = '20000000-0000-0000-0000-0000000017f1'$$, '%employees_ph_ng_from_month_start%');
update employees set ph_ng_type = 'solo_parent', ph_ng_from_month = '2026-11-01', id_number = 'SPIC-2026-0099', id_valid_until = '2027-03-15'
  where id = '20000000-0000-0000-0000-0000000017f1';
update employees set ph_ng_type = 'pwd', ph_ng_from_month = '2026-08-01', id_number = 'PWD-123', id_valid_until = null
  where id = '20000000-0000-0000-0000-0000000017f1';
select pg_temp.check((select column_default from information_schema.columns where table_name = 'payslips' and column_name = 'philhealth_ng') = '0', 'payslips.philhealth_ng defaults to 0');

\echo '--- 17.6 C8: the holiday absence rule is off by default; only a small retail or service establishment is exempt from holiday pay'
select pg_temp.check(not (select holiday_absence_rule from entities where id = '10000000-0000-0000-0000-0000000017f0'), 'rule off by default (O8)');
select pg_temp.check(not (select holiday_pay_exempt from entities where id = '10000000-0000-0000-0000-0000000017f0'), 'not exempt by default');
select pg_temp.expect_error($$update entities set holiday_pay_exempt = true where id = '10000000-0000-0000-0000-0000000017f0'$$, '%entities_holiday_pay_exempt_small_retail%');
select pg_temp.expect_error($$update entities set holiday_pay_exempt = true, retail_service_establishment = true, regular_workers = 10 where id = '10000000-0000-0000-0000-0000000017f0'$$, '%entities_holiday_pay_exempt_small_retail%');
update entities set holiday_pay_exempt = true, retail_service_establishment = true, regular_workers = 9 where id = '10000000-0000-0000-0000-0000000017f0';

\echo '--- 17.7 C9: due-date extensions per client and year, readable and writable by the client''s admins only'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ma, true);
update entities set bir_filing_method = 'efps', efps_group = 'C', pagibig_due_day = 15 where id = '10000000-0000-0000-0000-0000000017f0';
insert into filing_due_dates (entity_id, filing, period, due_date, note)
values ('10000000-0000-0000-0000-0000000017f0', '1601c', '2026-03-01', '2026-04-20', 'Extension');
select pg_temp.expect_error($$insert into filing_due_dates (entity_id, filing, period, due_date) values ('10000000-0000-0000-0000-0000000017f0', 'sss', '2026-03-15', '2026-04-30')$$, '%filing_due_dates_period_check%');
select pg_temp.expect_error($$update entities set efps_group = 'F' where id = '10000000-0000-0000-0000-0000000017f0'$$, '%entities_efps_group_check%');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000089', true);
select pg_temp.check((select count(*) from filing_due_dates) = 0, 'another client''s admin sees none');
commit;

\echo '--- 17.8 C10: commissions, profit sharing and fees are typed on the Other taxable classification'
insert into payroll_adjustments (payroll_run_id, employee_id, entity_id, kind, label, amount, category, pay_item_type)
values ('30000000-0000-0000-0000-0000000017f1', '20000000-0000-0000-0000-0000000017f1', '10000000-0000-0000-0000-0000000017f0', 'earning', 'Sales commission', 5000, 'other_taxable', 'commission');
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, entity_id, kind, label, amount, category, pay_item_type) values ('30000000-0000-0000-0000-0000000017f1', '20000000-0000-0000-0000-0000000017f1', '10000000-0000-0000-0000-0000000017f0', 'earning', 'Fee', 900, 'overtime', 'fees')$$, '%payroll_adjustments_pay_item_type_category%');

\echo '--- 17.9 the new checks hold for every row; a new de minimis version sends drafts back for recompute'
select pg_temp.check((select bool_and(convalidated) and count(*) = 2 from pg_constraint
  where conname in ('employees_ph_ng_documented', 'employee_allowances_de_minimis_named')),
  'NG and de minimis checks validated (an old row cannot block finalize or reopen)');
begin;
update payroll_runs set totals = '{"gross": 1}' where id = '30000000-0000-0000-0000-0000000017f1';
insert into legal_parameters (key, effective_from, data, description, legal_basis, source_url)
  select key, '2026-11-15', data, description, legal_basis, source_url from legal_parameters
  where key = 'de_minimis' and effective_from = '2026-01-06';
select pg_temp.check((select totals = '{}'::jsonb from payroll_runs where id = '30000000-0000-0000-0000-0000000017f1'),
  'a draft paid on or after a new version computes again');
rollback;

\echo 'PASSED 17'
