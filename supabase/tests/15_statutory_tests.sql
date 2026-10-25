-- Tests for the statutory_tables_managed migration: statutory tables are
-- read-only for every app role, versions shipped by the maintainer are checked
-- for shape and figures, and a version finalized payrolls may have used is frozen.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set xa    '''00000000-0000-0000-0000-000000000069'''

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

\echo '--- 15.1 no app role writes statutory tables'
insert into auth.users (id, email, raw_app_meta_data) values (:xa, 'xa@chi.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select pg_temp.check((select count(*) from statutory_versions where verified_on is not null and legal_basis <> '') = (select count(*) from statutory_versions)
  and (select count(*) from statutory_versions) = 6, 'every version is documented and verified');
select pg_temp.expect_error($$insert into statutory_versions (kind, effective_from, description, legal_basis, source_url, data)
  values ('philhealth', '2027-01-01', 'x', 'x', 'https://x.test', '{"rate":0.05,"floor":10000,"ceiling":100000}')$$, '%permission denied%');
select pg_temp.expect_error($$update statutory_versions set verified_on = current_date$$, '%permission denied%');
select set_config('request.jwt.claim.sub', :xa, true);
select pg_temp.expect_error($$delete from statutory_versions$$, '%permission denied%');
commit;
begin;
set local role anon;
select pg_temp.expect_error($$update statutory_versions set description = 'x'$$, '%permission denied%');
commit;

\echo '--- 15.2 the database checks what the maintainer ships'
-- (each statement is its own transaction: a failed one leaves nothing behind)
select pg_temp.expect_error($$insert into statutory_versions (kind, effective_from, description, legal_basis, source_url, data)
  values ('philhealth', '2027-01-01', 'typo: 50%', 'x', 'https://x.test', '{"rate":0.5,"floor":10000,"ceiling":100000}')$$, '%statutory_versions_data_check%');
select pg_temp.expect_error($$insert into statutory_versions (kind, effective_from, description, legal_basis, source_url, data)
  values ('philhealth', '2027-01-01', 'floor above ceiling', 'x', 'https://x.test', '{"rate":0.05,"floor":100000,"ceiling":10000}')$$, '%statutory_versions_data_check%');
select pg_temp.expect_error($$insert into statutory_versions (kind, effective_from, description, legal_basis, source_url, data)
  values ('sss', '2027-01-01', 'MSC range off the step', 'x', 'https://x.test',
  '{"rate_ee":0.05,"rate_er":0.1,"msc_min":5000,"msc_max":35250,"msc_step":500,"mpf_threshold":20000,"ec_er_low":10,"ec_er_high":30,"ec_threshold_msc":15000}')$$, '%statutory_versions_data_check%');
select pg_temp.expect_error($$insert into statutory_versions (kind, effective_from, description, legal_basis, source_url, data)
  values ('pagibig', '2027-01-01', 'missing key', 'x', 'https://x.test', '{"max_fund_salary":10000,"ee_rate_low":0.01,"ee_rate_high":0.02,"er_rate":0.02}')$$, '%statutory_versions_data_check%');
-- a bracket whose base doesn't follow from the one before (a mistyped figure)
select pg_temp.expect_error($$insert into statutory_versions (kind, effective_from, description, legal_basis, source_url, data)
  select 'bir_annual', '2027-01-01', 'mistyped base', 'x', 'https://x.test',
    jsonb_set(data, '{brackets,2,base}', '25000') from statutory_versions where kind = 'bir_annual'$$, '%statutory_versions_data_check%');
select pg_temp.expect_error($$insert into statutory_versions (kind, effective_from, description, legal_basis, source_url, data)
  select 'bir_wht', '2027-01-01', 'brackets out of order', 'x', 'https://x.test',
    jsonb_set(data, '{monthly,2,over}', '1000') from statutory_versions where kind = 'bir_wht'$$, '%statutory_versions_data_check%');
select pg_temp.expect_error($$insert into statutory_versions (kind, effective_from, description, legal_basis, source_url, data)
  select kind, '2027-01-15', 'mid-month', 'x', 'https://x.test', data from statutory_versions where kind = 'pagibig'$$, '%statutory_versions_month_start%');
select pg_temp.expect_error($$insert into statutory_versions (kind, effective_from, description, legal_basis, source_url, data)
  select kind, '2027-01-01', 'no legal basis', '', 'https://x.test', data from statutory_versions where kind = 'pagibig'$$, '%statutory_versions_documented%');
select pg_temp.expect_error($$insert into statutory_versions (kind, effective_from, description, legal_basis, source_url, data)
  select kind, '2027-01-01', 'no source', 'x', null, data from statutory_versions where kind = 'pagibig'$$, '%statutory_versions_documented%');
begin;
insert into statutory_versions (kind, effective_from, description, legal_basis, source_url, data)
  select kind, '2027-01-01', 'a well-formed future version', 'x', 'https://x.test', data from statutory_versions where kind = 'bir_wht';
select pg_temp.check((select count(*) from statutory_versions where kind = 'bir_wht') = 2, 'a valid version is accepted');
rollback;

\echo '--- 15.3 a version finalized payrolls may have used is frozen'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000000f5', 'CHI', 'Chi Bakery', 755);
commit;
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate, pay_frequency)
values ('20000000-0000-0000-0000-0000000000f5', '10000000-0000-0000-0000-0000000000f5', 'C-001', 'Cy', 'Uno', '2025-01-06', 'daily', 755, 'weekly');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('3000000f-0000-0000-0000-000000000005', '10000000-0000-0000-0000-0000000000f5', 'regular', 'weekly', '2026-01-05', '2026-01-11', '2026-01-16', '2026-01-01', 2, 4);
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, total_deductions)
values ('3000000f-0000-0000-0000-000000000005', '20000000-0000-0000-0000-0000000000f5', 4530, 4530, 0);
update payslips p set employee_payroll_seq = e.payroll_seq from employees e where e.id = p.employee_id and p.payroll_run_id = '3000000f-0000-0000-0000-000000000005';
update payroll_runs set totals = '{"employees":1}' where id = '3000000f-0000-0000-0000-000000000005';
select public.finalize_payroll_run('3000000f-0000-0000-0000-000000000005');
commit;
select pg_temp.expect_error($$update statutory_versions set data = jsonb_set(data, '{rate}', '0.04') where kind = 'philhealth'$$, '%frozen%');
select pg_temp.expect_error($$update statutory_versions set effective_from = '2024-02-01' where kind = 'philhealth'$$, '%frozen%');
-- notes stay editable, and a version after every finalized payroll is not frozen
update statutory_versions set description = description || ' ' where kind = 'philhealth';
begin;
insert into statutory_versions (kind, effective_from, description, legal_basis, source_url, data)
  select kind, '2027-01-01', 'future', 'x', 'https://x.test', data from statutory_versions where kind = 'philhealth';
update statutory_versions set data = jsonb_set(data, '{rate}', '0.045') where kind = 'philhealth' and effective_from = '2027-01-01';
delete from statutory_versions where kind = 'philhealth' and effective_from = '2027-01-01';
rollback;
-- a deliberate correction of a published mistake
begin;
set local statutory.correction = 'on';
update statutory_versions set data = jsonb_set(data, '{rate}', '0.05') where kind = 'philhealth';
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select public.reopen_payroll_run('3000000f-0000-0000-0000-000000000005');
commit;

\echo 'PASSED 15'
