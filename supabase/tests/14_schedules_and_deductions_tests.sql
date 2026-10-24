-- Tests for 20261024100000_work_schedules.sql and 20261024100100_payroll_deduction_overrides.sql:
-- shift validation, who may read and write schedules, paid days staying as they
-- were paid, drafts going stale, and per-payroll deduction amounts.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set sa    '''00000000-0000-0000-0000-000000000079'''
\set ta    '''00000000-0000-0000-0000-000000000078'''
\set us1   '''00000000-0000-0000-0000-000000000071'''

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

-- fixture: client SIGMA with its admin and an employee (with a login), client TAU with its admin
insert into auth.users (id, email, raw_app_meta_data) values
  (:sa, 'sa@sigma.test', '{"role":"entity_admin"}'),
  (:ta, 'ta@tau.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values
  ('10000000-0000-0000-0000-0000000000e0', 'SIGMA', 'Sigma Diner', 755),
  ('10000000-0000-0000-0000-0000000000e1', 'TAU', 'Tau Trading', 755);
insert into entity_admins (profile_id, entity_id) values
  (:sa, '10000000-0000-0000-0000-0000000000e0'),
  (:ta, '10000000-0000-0000-0000-0000000000e1');
commit;
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate, pay_frequency)
values ('20000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-0000000000e0', 'S-001', 'Sol', 'Uno', '2025-01-06', 'daily', 755, 'weekly'),
       ('20000000-0000-0000-0000-0000000000b2', '10000000-0000-0000-0000-0000000000e0', 'S-002', 'Sam', 'Dos', '2025-01-06', 'daily', 755, 'weekly');
insert into auth.users (id, email, raw_app_meta_data) values
  (:us1, 'emp-s1@x.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000000b1"}');

\echo '--- 14.1 a shift needs valid times and some work time; a pattern is seven days'
select pg_temp.check(public.valid_shift('{"start":"08:00","end":"17:00","break_minutes":60}'), 'day shift');
select pg_temp.check(public.valid_shift('{"start":"22:00","end":"06:00","break_minutes":60,"flex_minutes":30,"compressed":false,"name":"Night"}'), 'overnight shift with options');
select pg_temp.check(public.valid_shift('{"start":"07:00","end":"07:00","break_minutes":120}'), '24-hour duty');
select pg_temp.check(not public.valid_shift('{"start":"8:00","end":"17:00","break_minutes":60}'), 'times are HH:MM');
select pg_temp.check(not public.valid_shift('{"start":"08:00","end":"24:00","break_minutes":60}'), 'no 24:00');
select pg_temp.check(not public.valid_shift('{"start":"08:00","end":"09:00","break_minutes":60}'), 'the break must leave work time');
select pg_temp.check(not public.valid_shift('{"start":"08:00","end":"17:00","break_minutes":"60"}'), 'the break is a number');
select pg_temp.check(not public.valid_shift('{"start":"08:00","end":"17:00","break_minutes":60.5}'), 'whole minutes');
select pg_temp.check(not public.valid_shift('{"start":"08:00","end":"17:00","break_minutes":60,"flex_minutes":600}'), 'flexible start up to 8 hours');
select pg_temp.check(not public.valid_shift('{"start":"08:00","end":"17:00","break_minutes":60,"compressed":"yes"}'), 'compressed is true/false');
select pg_temp.check(not public.valid_shift('[]'), 'an object');
select pg_temp.check(public.valid_week_pattern('[{"start":"08:00","end":"17:00","break_minutes":60},null,null,null,null,{"start":"08:00","end":"12:00","break_minutes":0},null]'), 'seven days with rest days');
select pg_temp.check(not public.valid_week_pattern('[null,null,null,null,null,null]'), 'six days');
select pg_temp.check(not public.valid_week_pattern('[{"start":"08:00"},null,null,null,null,null,null]'), 'a broken shift');

\echo '--- 14.2 admins of the client manage schedules; other clients and employees only read their own'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :sa, true);
insert into shift_templates (id, entity_id, name, shift) values
  ('5100000e-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000e0', 'Opening', '{"start":"06:00","end":"15:00","break_minutes":60}');
select pg_temp.expect_error($$insert into shift_templates (entity_id, name, shift) values ('10000000-0000-0000-0000-0000000000e0', 'Opening', '{"start":"07:00","end":"16:00","break_minutes":60}')$$, '%shift_templates_name_unique%');
select pg_temp.expect_error($$insert into shift_templates (entity_id, name, shift) values ('10000000-0000-0000-0000-0000000000e0', 'Bad', '{"start":"07:00","end":"07:30","break_minutes":60}')$$, '%shift_templates_shift_check%');
insert into employee_schedules (id, employee_id, entity_id, effective_from, pattern) values
  ('5200000e-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-0000000000e1', '2026-11-02',
   '[{"start":"06:00","end":"15:00","break_minutes":60},{"start":"06:00","end":"15:00","break_minutes":60},null,{"start":"06:00","end":"15:00","break_minutes":60},{"start":"06:00","end":"15:00","break_minutes":60},{"start":"06:00","end":"12:00","break_minutes":0},null]');
select pg_temp.check((select entity_id from employee_schedules where id = '5200000e-0000-0000-0000-000000000001') = '10000000-0000-0000-0000-0000000000e0', 'the client comes from the employee, not the request');
select pg_temp.check((select created_by from employee_schedules where id = '5200000e-0000-0000-0000-000000000001') = :sa, 'who changed it is recorded');
insert into schedule_overrides (id, employee_id, work_date, shift, note) values
  ('5300000e-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000b1', '2026-11-04', '{"start":"14:00","end":"23:00","break_minutes":60}', 'covers the closing shift'),
  ('5300000e-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000b1', '2026-11-05', null, 'rest day moved');
select pg_temp.expect_error($$insert into schedule_overrides (employee_id, work_date, shift) values ('20000000-0000-0000-0000-0000000000b1', '2026-11-04', null)$$, '%schedule_overrides_one_per_date%');
select pg_temp.expect_error($$update employee_schedules set employee_id = '20000000-0000-0000-0000-0000000000b2' where id = '5200000e-0000-0000-0000-000000000001'$$, '%cannot move to another employee%');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ta, true);
select pg_temp.check((select count(*) from shift_templates) = 0, 'another client sees no templates');
select pg_temp.check((select count(*) from employee_schedules) = 0, 'another client sees no schedules');
select pg_temp.check((select count(*) from schedule_overrides) = 0, 'another client sees no roster');
select pg_temp.expect_error($$insert into schedule_overrides (employee_id, work_date, shift) values ('20000000-0000-0000-0000-0000000000b1', '2026-11-06', null)$$, 'Employee not found.');  -- refused before RLS, saying nothing about them
update employee_schedules set note = 'x';  -- matches no row they may update
delete from schedule_overrides;              -- nor one they may delete
commit;
select pg_temp.check((select count(*) from schedule_overrides where employee_id = '20000000-0000-0000-0000-0000000000b1') = 2, 'foreign delete removed nothing');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :us1, true);
select pg_temp.check((select count(*) from employee_schedules) = 1, 'employee reads own schedule');
select pg_temp.check((select count(*) from schedule_overrides) = 2, 'employee reads own roster');
select pg_temp.check((select count(*) from shift_templates) = 0, 'employees do not see templates');
select pg_temp.expect_error($$insert into schedule_overrides (employee_id, work_date, shift) values ('20000000-0000-0000-0000-0000000000b1', '2026-11-07', null)$$, 'Employee not found.');  -- employees never write their schedule
update schedule_overrides set shift = null;  -- no update right
commit;
select pg_temp.check((select shift is not null from schedule_overrides where id = '5300000e-0000-0000-0000-000000000001'), 'employee could not change the roster');

\echo '--- 14.3 a schedule change marks the drafts it touches stale'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :sa, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('3000000e-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000e0', 'regular', 'weekly', '2026-11-02', '2026-11-08', '2026-11-13', '2026-11-01', 1, 4),
       ('3000000e-0000-0000-0000-000000000002', '10000000-0000-0000-0000-0000000000e0', 'regular', 'weekly', '2026-11-09', '2026-11-15', '2026-11-20', '2026-11-01', 2, 4);
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, total_deductions)
values ('3000000e-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000b1', 4530, 4530, 0),
       ('3000000e-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000b1', 4530, 4530, 0);
select pg_temp.computed('3000000e-0000-0000-0000-000000000001');
select pg_temp.computed('3000000e-0000-0000-0000-000000000002');
update schedule_overrides set shift = '{"start":"15:00","end":"23:00","break_minutes":30}' where id = '5300000e-0000-0000-0000-000000000001';
select pg_temp.check((select totals from payroll_runs where id = '3000000e-0000-0000-0000-000000000001') = '{}'::jsonb, 'a roster change stales the draft holding its date');
select pg_temp.check((select totals ? 'employees' from payroll_runs where id = '3000000e-0000-0000-0000-000000000002'), 'and not the next week''s');
select pg_temp.computed('3000000e-0000-0000-0000-000000000001');
insert into employee_schedules (id, employee_id, effective_from, pattern) values
  ('5200000e-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000b1', '2026-11-10',
   '[null,{"start":"06:00","end":"15:00","break_minutes":60},{"start":"06:00","end":"15:00","break_minutes":60},{"start":"06:00","end":"15:00","break_minutes":60},{"start":"06:00","end":"15:00","break_minutes":60},{"start":"06:00","end":"15:00","break_minutes":60},null]');
select pg_temp.check((select totals ? 'employees' from payroll_runs where id = '3000000e-0000-0000-0000-000000000001'), 'a pattern from Nov 10 leaves the first week alone');
select pg_temp.check((select totals from payroll_runs where id = '3000000e-0000-0000-0000-000000000002') = '{}'::jsonb, 'and stales the week it starts in');
commit;

\echo '--- 14.4 paid days keep the schedule they were paid with'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :sa, true);
select pg_temp.computed('3000000e-0000-0000-0000-000000000001');
select public.finalize_payroll_run('3000000e-0000-0000-0000-000000000001');
-- the Nov 2 pattern now covers paid days; the Nov 10 one does not
select pg_temp.expect_error($$update employee_schedules set pattern = '[null,null,null,null,null,null,null]' where id = '5200000e-0000-0000-0000-000000000001'$$, '%covers days already paid (through 2026-11-08)%');
select pg_temp.expect_error($$delete from employee_schedules where id = '5200000e-0000-0000-0000-000000000001'$$, '%covers days already paid%');
select pg_temp.expect_error($$insert into employee_schedules (employee_id, effective_from, pattern) values ('20000000-0000-0000-0000-0000000000b1', '2026-11-08', '[null,null,null,null,null,null,null]')$$, '%can start on 2026-11-09 at the earliest%');
select pg_temp.expect_error($$update employee_schedules set effective_from = '2026-11-05' where id = '5200000e-0000-0000-0000-000000000002'$$, '%can start on 2026-11-09 at the earliest%');
update employee_schedules set note = 'opening crew' where id = '5200000e-0000-0000-0000-000000000001';
update employee_schedules set effective_from = '2026-11-09' where id = '5200000e-0000-0000-0000-000000000002';
-- the paid week's roster is locked like its time in/out; later dates are not
select pg_temp.expect_error($$update schedule_overrides set note = 'x' where id = '5300000e-0000-0000-0000-000000000001'$$, '%was paid in a finalized payroll run%');
select pg_temp.expect_error($$delete from schedule_overrides where id = '5300000e-0000-0000-0000-000000000002'$$, '%was paid in a finalized payroll run%');
select pg_temp.expect_error($$insert into schedule_overrides (employee_id, work_date, shift) values ('20000000-0000-0000-0000-0000000000b1', '2026-11-03', null)$$, '%was paid in a finalized payroll run%');
insert into schedule_overrides (employee_id, work_date, shift) values ('20000000-0000-0000-0000-0000000000b1', '2026-11-11', null);
-- another employee of the client was not paid: their schedule is free
insert into employee_schedules (employee_id, effective_from, pattern) values
  ('20000000-0000-0000-0000-0000000000b2', '2026-11-02', '[null,null,null,null,null,null,null]');
select public.reopen_payroll_run('3000000e-0000-0000-0000-000000000001');
update schedule_overrides set note = 'reopened: editable again' where id = '5300000e-0000-0000-0000-000000000001';
delete from employee_schedules where id = '5200000e-0000-0000-0000-000000000001';
commit;
select pg_temp.check((select count(*) from audit_logs where table_name in ('employee_schedules','schedule_overrides','shift_templates')) >= 8, 'schedule changes are audit-logged');

\echo '--- 14.5 a draft payroll sets its own deduction amounts; finalized ones are locked'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :sa, true);
insert into recurring_deductions (id, employee_id, label, category, amount_per_period, total_amount, balance, released_on, release_method, authorized_on)
values ('7000000e-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000b1', 'Cash advance (Nov 2, 2026)', 'cash_advance', 0, 2000, 2000, '2026-11-02', 'cash', '2026-11-02');
insert into recurring_deductions (id, employee_id, label, category, amount_per_period, balance, total_amount, authorized_on)
values ('7000000e-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000b1', 'Company loan', 'company_loan', 500, 3000, 3000, '2026-11-02');
select pg_temp.computed('3000000e-0000-0000-0000-000000000001');
insert into payroll_deduction_overrides (id, payroll_run_id, deduction_id, amount, note) values
  ('5400000e-0000-0000-0000-000000000001', '3000000e-0000-0000-0000-000000000001', '7000000e-0000-0000-0000-000000000001', 750, 'agreed on payday'),
  ('5400000e-0000-0000-0000-000000000002', '3000000e-0000-0000-0000-000000000001', '7000000e-0000-0000-0000-000000000002', 0, 'skip this week');
select pg_temp.check((select totals from payroll_runs where id = '3000000e-0000-0000-0000-000000000001') = '{}'::jsonb, 'a deduction amount stales the draft');
select pg_temp.check((select employee_id = '20000000-0000-0000-0000-0000000000b1' and entity_id = '10000000-0000-0000-0000-0000000000e0' from payroll_deduction_overrides where id = '5400000e-0000-0000-0000-000000000001'), 'employee and client come from the deduction and run');
select pg_temp.expect_error($$insert into payroll_deduction_overrides (payroll_run_id, deduction_id, amount) values ('3000000e-0000-0000-0000-000000000002', '7000000e-0000-0000-0000-000000000001', 2000.01)$$, '%at most 2000.00%');
select pg_temp.expect_error($$insert into payroll_deduction_overrides (payroll_run_id, deduction_id, amount) values ('3000000e-0000-0000-0000-000000000002', '7000000e-0000-0000-0000-000000000001', -1)$$, '%amount_check%');
select pg_temp.expect_error($$insert into payroll_deduction_overrides (payroll_run_id, deduction_id, amount) values ('3000000e-0000-0000-0000-000000000001', '7000000e-0000-0000-0000-000000000001', 10)$$, '%payroll_deduction_overrides_one%');
select pg_temp.expect_error($$update payroll_deduction_overrides set deduction_id = '7000000e-0000-0000-0000-000000000002' where id = '5400000e-0000-0000-0000-000000000001'$$, '%cannot move%');
insert into payroll_runs (id, entity_id, run_type, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('3000000e-0000-0000-0000-000000000003', '10000000-0000-0000-0000-0000000000e0', 'thirteenth_month', '2026-01-01', '2026-12-31', '2026-12-18', '2026-12-01', 1, 1);
select pg_temp.expect_error($$insert into payroll_deduction_overrides (payroll_run_id, deduction_id, amount) values ('3000000e-0000-0000-0000-000000000003', '7000000e-0000-0000-0000-000000000002', 100)$$, '%13th month payroll makes no deductions%');
-- finalize moves balances by the payslip lines, which carry the amounts set for this payroll
update payslips set deductions = '[{"code":"other:cash_advance","label":"Cash advance (Nov 2, 2026) — 1,250.00 left","amount":750,"meta":"7000000e-0000-0000-0000-000000000001"}]', total_deductions = 750, net_pay = 3780
  where payroll_run_id = '3000000e-0000-0000-0000-000000000001';
select pg_temp.computed('3000000e-0000-0000-0000-000000000001');
select public.finalize_payroll_run('3000000e-0000-0000-0000-000000000001');
select pg_temp.check((select balance from recurring_deductions where id = '7000000e-0000-0000-0000-000000000001') = 1250, 'the amount set for this payroll left the advance');
select pg_temp.check((select balance from recurring_deductions where id = '7000000e-0000-0000-0000-000000000002') = 3000, 'the skipped loan kept its balance');
select pg_temp.expect_error($$update payroll_deduction_overrides set amount = 100 where id = '5400000e-0000-0000-0000-000000000001'$$, '%finalized payroll run are locked%');
select pg_temp.expect_error($$delete from payroll_deduction_overrides where id = '5400000e-0000-0000-0000-000000000002'$$, '%finalized payroll run are locked%');
select public.reopen_payroll_run('3000000e-0000-0000-0000-000000000001');
select pg_temp.check((select balance from recurring_deductions where id = '7000000e-0000-0000-0000-000000000001') = 2000, 'reopen restored the advance');
delete from payroll_deduction_overrides where id = '5400000e-0000-0000-0000-000000000002';
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ta, true);
select pg_temp.check((select count(*) from payroll_deduction_overrides) = 0, 'another client sees no deduction amounts');
-- refused before the guard says anything about the other client's run or deduction
select pg_temp.expect_error($$insert into payroll_deduction_overrides (payroll_run_id, deduction_id, amount) values ('3000000e-0000-0000-0000-000000000002', '7000000e-0000-0000-0000-000000000002', 999999)$$, 'Payroll run not found.');
select pg_temp.expect_error($$insert into employee_schedules (employee_id, effective_from, pattern) values ('20000000-0000-0000-0000-0000000000b1', '2026-01-01', '[null,null,null,null,null,null,null]')$$, 'Employee not found.');
select pg_temp.expect_error($$insert into schedule_overrides (employee_id, work_date, shift) values ('20000000-0000-0000-0000-0000000000b1', '2026-11-03', null)$$, 'Employee not found.');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :us1, true);
select pg_temp.check((select count(*) from payroll_deduction_overrides) = 0, 'employees do not read pay run settings');
commit;
select pg_temp.check((select count(*) from audit_logs where table_name = 'payroll_deduction_overrides') >= 3, 'deduction amounts are audit-logged');

\echo '--- 14.6 an approved request may have no fixed installment'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :us1, true);
insert into advance_requests (id, employee_id, amount, per_payroll) values ('6000000e-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000b1', 1500, 500);
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :sa, true);
select pg_temp.expect_error($$select public.approve_advance_request('6000000e-0000-0000-0000-000000000001', 1500, -1, '2026-11-16', null, 'cash', '2026-11-16')$$, '%deduction per payroll%');
select public.approve_advance_request('6000000e-0000-0000-0000-000000000001', 1500, 0, '2026-11-16', null, 'cash', '2026-11-16');
select pg_temp.check((select d.amount_per_period = 0 and d.balance = 1500 from advance_requests r join recurring_deductions d on d.id = r.advance_id where r.id = '6000000e-0000-0000-0000-000000000001'), 'approved with no fixed installment');
commit;
\echo '--- 14.7 reopening keeps a manual pause; deleting a deduction takes its amounts along'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :sa, true);
-- a paused loan that this payroll pays off through an amount set for it
insert into recurring_deductions (id, employee_id, label, category, amount_per_period, total_amount, balance, active, authorized_on)
values ('7000000e-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000b1', 'Paused loan', 'company_loan', 200, 600, 600, false, '2026-11-02');
insert into payroll_deduction_overrides (payroll_run_id, deduction_id, amount) values ('3000000e-0000-0000-0000-000000000001', '7000000e-0000-0000-0000-000000000003', 600);
-- an active loan its installment pays off
insert into recurring_deductions (id, employee_id, label, category, amount_per_period, total_amount, balance, active, authorized_on)
values ('7000000e-0000-0000-0000-000000000004', '20000000-0000-0000-0000-0000000000b1', 'Last installment', 'company_loan', 300, 300, 300, true, '2026-11-02');
update payslips set deductions = '[{"code":"other:company_loan","label":"Paused loan","amount":600,"meta":"7000000e-0000-0000-0000-000000000003"},{"code":"other:company_loan","label":"Last installment","amount":300,"meta":"7000000e-0000-0000-0000-000000000004"}]', total_deductions = 900, net_pay = 3630
  where payroll_run_id = '3000000e-0000-0000-0000-000000000001';
select pg_temp.computed('3000000e-0000-0000-0000-000000000001');
select public.finalize_payroll_run('3000000e-0000-0000-0000-000000000001');
select pg_temp.check((select balance = 0 and not active from recurring_deductions where id = '7000000e-0000-0000-0000-000000000003'), 'the paused loan is paid off');
select pg_temp.check((select balance = 0 and not active and closed_by_run = '3000000e-0000-0000-0000-000000000001' from recurring_deductions where id = '7000000e-0000-0000-0000-000000000004'), 'finalize stopped the paid-off loan and says so');
select public.reopen_payroll_run('3000000e-0000-0000-0000-000000000001');
select pg_temp.check((select balance = 600 and not active from recurring_deductions where id = '7000000e-0000-0000-0000-000000000003'), 'reopen restores the balance and keeps the pause');
select pg_temp.check((select balance = 300 and active and closed_by_run is null from recurring_deductions where id = '7000000e-0000-0000-0000-000000000004'), 'reopen restarts what finalize stopped');
-- skipped in a finalized payroll, then deleted: its amounts go with it
update payroll_deduction_overrides set amount = 0 where deduction_id = '7000000e-0000-0000-0000-000000000003';
update payslips set deductions = '[{"code":"other:company_loan","label":"Last installment","amount":300,"meta":"7000000e-0000-0000-0000-000000000004"}]', total_deductions = 300, net_pay = 4230
  where payroll_run_id = '3000000e-0000-0000-0000-000000000001';
select pg_temp.computed('3000000e-0000-0000-0000-000000000001');
select public.finalize_payroll_run('3000000e-0000-0000-0000-000000000001');
delete from recurring_deductions where id = '7000000e-0000-0000-0000-000000000003';
select pg_temp.check((select count(*) from payroll_deduction_overrides where deduction_id = '7000000e-0000-0000-0000-000000000003') = 0, 'the deduction and its amounts are gone');
select pg_temp.expect_error($$delete from payroll_deduction_overrides where payroll_run_id = '3000000e-0000-0000-0000-000000000001'$$, '%finalized payroll run are locked%');
select public.reopen_payroll_run('3000000e-0000-0000-0000-000000000001');
commit;
\echo 'PASSED 14'
