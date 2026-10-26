-- Tests for the legal_accuracy migration: the December year-end
-- adjustment, the 8-hour normal day, the compressed workweek, service
-- requirements, written authorization for deductions, maternity pay and the
-- PhilHealth waiver, holiday look-back staleness and the 2027 holidays.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set la    '''00000000-0000-0000-0000-000000000089'''

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

-- fixture: client LAMBDA, its admin and an employee
insert into auth.users (id, email, raw_app_meta_data) values (:la, 'la@lambda.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000016f0', 'LAMBDA', 'Lambda Bakery', 755);
insert into entity_admins (profile_id, entity_id) values (:la, '10000000-0000-0000-0000-0000000016f0');
commit;
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, monthly_rate)
values ('20000000-0000-0000-0000-0000000016f1', '10000000-0000-0000-0000-0000000016f0', 'L-001', 'Lia', 'Uno', '2025-01-06', 30000);

\echo '--- 16.1 only a payroll paid in December annualizes'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :la, true);
select pg_temp.expect_error($$insert into payroll_runs (entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month, annualize)
  values ('10000000-0000-0000-0000-0000000016f0', 'regular', 'semi_monthly', '2026-12-16', '2026-12-31', '2027-01-05', '2026-12-01', 2, 2, true)$$, '%payroll_runs_annualize_december%');
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month, annualize)
values ('30000000-0000-0000-0000-0000000016f1', '10000000-0000-0000-0000-0000000016f0', 'regular', 'semi_monthly', '2026-12-01', '2026-12-15', '2026-12-20', '2026-12-01', 1, 2, true);
select pg_temp.expect_error($$update payroll_runs set pay_date = '2027-01-04' where id = '30000000-0000-0000-0000-0000000016f1'$$, '%payroll_runs_annualize_december%');
commit;

\echo '--- 16.2 normal hours are eight a day at most; a compressed workweek keeps to five days and 48 hours'
select pg_temp.expect_error($$update entities set standard_hours_per_day = 9 where id = '10000000-0000-0000-0000-0000000016f0'$$, '%entities_standard_hours_max8%');
update entities set standard_hours_per_day = 7.5 where id = '10000000-0000-0000-0000-0000000016f0';
update entities set standard_hours_per_day = 8 where id = '10000000-0000-0000-0000-0000000016f0';
select pg_temp.check(public.valid_week_pattern(
  '[{"start":"07:00","end":"18:00","break_minutes":60,"compressed":true},{"start":"07:00","end":"18:00","break_minutes":60,"compressed":true},{"start":"07:00","end":"18:00","break_minutes":60,"compressed":true},{"start":"07:00","end":"18:00","break_minutes":60,"compressed":true},null,null,null]'),
  'four 10-hour days');
select pg_temp.check(not public.valid_week_pattern(
  '[{"start":"07:00","end":"18:00","break_minutes":60,"compressed":true},{"start":"07:00","end":"18:00","break_minutes":60,"compressed":true},{"start":"07:00","end":"18:00","break_minutes":60,"compressed":true},{"start":"07:00","end":"18:00","break_minutes":60,"compressed":true},{"start":"07:00","end":"18:00","break_minutes":60,"compressed":true},null,null]'),
  'five 10-hour days are 50 hours');
select pg_temp.check(not public.valid_week_pattern(
  '[{"start":"07:00","end":"16:00","break_minutes":60,"compressed":true},{"start":"07:00","end":"16:00","break_minutes":60},{"start":"07:00","end":"16:00","break_minutes":60},{"start":"07:00","end":"16:00","break_minutes":60},{"start":"07:00","end":"16:00","break_minutes":60},{"start":"07:00","end":"11:00","break_minutes":0},null]'),
  'a compressed week has fewer than six workdays');
select pg_temp.check(public.valid_week_pattern(
  '[{"start":"08:00","end":"17:00","break_minutes":60},{"start":"08:00","end":"17:00","break_minutes":60},{"start":"08:00","end":"17:00","break_minutes":60},{"start":"08:00","end":"17:00","break_minutes":60},{"start":"08:00","end":"17:00","break_minutes":60},{"start":"08:00","end":"12:00","break_minutes":0},null]'),
  'an ordinary six-day week is fine');

\echo '--- 16.3 Solo Parent Leave and Special Leave for Women need six months of service'
select pg_temp.check((select bool_and(min_service_months = 6) from leave_types where code in ('SPL', 'MCW')), 'SPL and MCW: 6 months, templates and clients');
select pg_temp.check((select count(*) from leave_types where entity_id = '10000000-0000-0000-0000-0000000016f0' and code in ('SPL', 'MCW') and min_service_months = 6) = 2, 'a new client starts with them');

\echo '--- 16.4 deductions the law does not provide for need the written authorization'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :la, true);
select pg_temp.expect_error($$insert into recurring_deductions (employee_id, label, category, amount_per_period) values ('20000000-0000-0000-0000-0000000016f1', 'HMO', 'hmo', 500)$$, '%written authorization%');
select pg_temp.expect_error($$insert into recurring_deductions (employee_id, label, category, amount_per_period) values ('20000000-0000-0000-0000-0000000016f1', 'Loan', 'company_loan', 500)$$, '%written authorization%');
insert into recurring_deductions (id, employee_id, label, category, amount_per_period, authorized_on)
values ('40000000-0000-0000-0000-0000000016f1', '20000000-0000-0000-0000-0000000016f1', 'HMO', 'hmo', 500, '2026-10-01');
insert into recurring_deductions (employee_id, label, category, amount_per_period) values ('20000000-0000-0000-0000-0000000016f1', 'SSS salary loan', 'sss_loan', 1200);
select pg_temp.expect_error($$update recurring_deductions set authorized_on = null where id = '40000000-0000-0000-0000-0000000016f1'$$, '%written authorization%');
select pg_temp.expect_error($$update recurring_deductions set category = 'other' where category = 'sss_loan' and employee_id = '20000000-0000-0000-0000-0000000016f1'$$, '%written authorization%');
-- one-time deductions in a payroll: 'other' needs it, union dues do not
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, category)
  values ('30000000-0000-0000-0000-0000000016f1', '20000000-0000-0000-0000-0000000016f1', 'deduction', 'Broken tray', 300, 'other')$$, '%written authorization%');
insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, category, authorized_on)
values ('30000000-0000-0000-0000-0000000016f1', '20000000-0000-0000-0000-0000000016f1', 'deduction', 'Broken tray', 300, 'other', '2026-12-02');
insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, category)
values ('30000000-0000-0000-0000-0000000016f1', '20000000-0000-0000-0000-0000000016f1', 'deduction', 'Union dues (Dec)', 100, 'union_dues');
commit;
-- a deduction recorded before the rule keeps working until it is re-classified
alter table recurring_deductions disable trigger recurring_deductions_authorization;
insert into recurring_deductions (id, employee_id, label, category, amount_per_period, balance)
values ('40000000-0000-0000-0000-0000000016f2', '20000000-0000-0000-0000-0000000016f1', 'Old loan', 'company_loan', 1000, 5000);
alter table recurring_deductions enable trigger recurring_deductions_authorization;
update recurring_deductions set amount_per_period = 800 where id = '40000000-0000-0000-0000-0000000016f2';

\echo '--- 16.5 maternity pay: other non-taxable earnings, marked'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :la, true);
insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, category, benefit) values
  ('30000000-0000-0000-0000-0000000016f1', '20000000-0000-0000-0000-0000000016f1', 'earning', 'SSS maternity benefit', 70000, 'other_non_taxable', 'sss_maternity'),
  ('30000000-0000-0000-0000-0000000016f1', '20000000-0000-0000-0000-0000000016f1', 'earning', 'Maternity salary differential', 5000, 'other_non_taxable', 'maternity_differential');
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, category, benefit)
  values ('30000000-0000-0000-0000-0000000016f1', '20000000-0000-0000-0000-0000000016f1', 'earning', 'Taxed by mistake', 100, 'other_taxable', 'sss_maternity')$$, '%payroll_adjustments_benefit_kind%');
select pg_temp.expect_error($$insert into payroll_adjustments (payroll_run_id, employee_id, kind, label, amount, category, benefit)
  values ('30000000-0000-0000-0000-0000000016f1', '20000000-0000-0000-0000-0000000016f1', 'earning', 'Unknown', 100, 'other_non_taxable', 'paternity')$$, '%payroll_adjustments_benefit_check%');
commit;

\echo '--- 16.6 PhilHealth NG share (renamed by the C7 migration): a kind and its first month go together'
select pg_temp.expect_error($$update employees set ph_ng_type = 'pwd', id_number = 'PWD-1' where id = '20000000-0000-0000-0000-0000000016f1'$$, '%employees_ph_ng_dates%');
select pg_temp.expect_error($$update employees set ph_ng_type = 'senior', ph_ng_from_month = '2026-10-01', id_number = 'X' where id = '20000000-0000-0000-0000-0000000016f1'$$, '%employees_ph_ng_type_check%');
select pg_temp.expect_error($$update employees set ph_ng_type = 'pwd', ph_ng_from_month = '2026-10-01', id_number = 'PWD-1', id_valid_until = '2026-09-30' where id = '20000000-0000-0000-0000-0000000016f1'$$, '%employees_ph_ng_dates%');
update employees set ph_ng_type = 'solo_parent', ph_ng_from_month = '2026-10-01', id_number = 'SPIC-1', id_valid_until = '2027-09-30'
  where id = '20000000-0000-0000-0000-0000000016f1';
update employees set ph_ng_type = null, ph_ng_from_month = null, id_number = '', id_valid_until = null
  where id = '20000000-0000-0000-0000-0000000016f1';

\echo '--- 16.7 a change in the days before a period with a regular holiday stales that draft'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :la, true);
-- Nov 30 (Bonifacio Day) is in Nov 16–30; Dec 1–15 holds Dec 8, a special day only
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('30000000-0000-0000-0000-0000000016f2', '10000000-0000-0000-0000-0000000016f0', 'regular', 'semi_monthly', '2026-11-16', '2026-11-30', '2026-12-05', '2026-11-01', 2, 2),
       ('30000000-0000-0000-0000-0000000016f3', '10000000-0000-0000-0000-0000000016f0', 'regular', 'semi_monthly', '2026-12-16', '2026-12-31', '2026-12-29', '2026-12-01', 2, 2);
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, total_deductions) values
  ('30000000-0000-0000-0000-0000000016f2', '20000000-0000-0000-0000-0000000016f1', 15000, 15000, 0),
  ('30000000-0000-0000-0000-0000000016f3', '20000000-0000-0000-0000-0000000016f1', 15000, 15000, 0);
update payroll_runs set totals = '{"employees":1}' where id in ('30000000-0000-0000-0000-0000000016f2', '30000000-0000-0000-0000-0000000016f3');
commit;
-- Nov 13 is three days before Nov 16 (its regular holiday reads it); Dec 16–31 holds Dec 25 and 30 but Nov 13 is far before
insert into time_entries (employee_id, entity_id, work_date, clock_in, clock_out)
values ('20000000-0000-0000-0000-0000000016f1', '10000000-0000-0000-0000-0000000016f0', '2026-11-13', '2026-11-13 00:00:00+00', '2026-11-13 09:00:00+00');
select pg_temp.check((select totals from payroll_runs where id = '30000000-0000-0000-0000-0000000016f2') = '{}'::jsonb, 'Nov 16–30 draft is stale');
select pg_temp.check((select totals ? 'employees' from payroll_runs where id = '30000000-0000-0000-0000-0000000016f3'), 'Dec 16–31 draft is not');

\echo '--- 16.8 the 2027 national holidays are on file'
select pg_temp.check((select count(*) from holidays where entity_id is null and holiday_date between '2027-01-01' and '2027-12-31' and kind = 'regular') = 10, 'ten regular holidays (the Eids come later)');
select pg_temp.check((select kind from holidays where entity_id is null and holiday_date = '2027-03-26') = 'regular', 'Good Friday 2027');
select pg_temp.check((select kind from holidays where entity_id is null and holiday_date = '2027-02-25') = 'special_working', 'EDSA anniversary is a working day');

\echo 'PASSED 16'
