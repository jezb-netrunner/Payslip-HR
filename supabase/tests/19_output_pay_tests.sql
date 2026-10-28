-- Tests for output pay: an output needs output pay on for the employee, its
-- amount follows units × rate, a finalized payroll locks it, admins only,
-- and the output reports bucket is the client's admins' only.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set oa    '''00000000-0000-0000-0000-000000000191'''
\set oe    '''00000000-0000-0000-0000-000000000192'''
\set other '''00000000-0000-0000-0000-000000000089'''

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

-- fixture: client OU, its admin, a consultant on retainer and her login
insert into auth.users (id, email, raw_app_meta_data) values (:oa, 'oa@ou.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000019f0', 'OU', 'Ou Consulting', 695);
insert into entity_admins (profile_id, entity_id) values (:oa, '10000000-0000-0000-0000-0000000019f0');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :oa, true);
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate)
values ('20000000-0000-0000-0000-0000000019f1', '10000000-0000-0000-0000-0000000019f0', 'O-001', 'Rhea', 'Santos', '2026-03-02', 'monthly', 30000);
commit;
insert into auth.users (id, email, raw_app_meta_data)
values (:oe, 'oe@ou.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000019f1"}');

\echo '--- 19.1 an output needs output pay on; units × rate make the amount'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :oa, true);
select pg_temp.expect_error($$insert into employee_outputs (employee_id, output_date, description, amount) values ('20000000-0000-0000-0000-0000000019f1', '2026-10-05', 'Market study', 20000)$$, '%Turn on output pay%');
select pg_temp.expect_error($$update employees set output_pay = 'bonus' where id = '20000000-0000-0000-0000-0000000019f1'$$, '%employees_output_pay_check%');
update employees set output_pay = 'fees' where id = '20000000-0000-0000-0000-0000000019f1';
insert into employee_outputs (id, employee_id, output_date, description, quantity, unit_rate, amount)
values ('60000000-0000-0000-0000-0000000019a1', '20000000-0000-0000-0000-0000000019f1', '2026-10-05', 'Article', 3, 1666.6667, 1);
select pg_temp.check((select amount = 5000.00 and entity_id = '10000000-0000-0000-0000-0000000019f0' and created_by = :oa::uuid
  from employee_outputs where id = '60000000-0000-0000-0000-0000000019a1'), 'the amount follows 3 × 1,666.6667; client and author from the record');
insert into employee_outputs (id, employee_id, output_date, description, amount, accepted_by)
values ('60000000-0000-0000-0000-0000000019a2', '20000000-0000-0000-0000-0000000019f1', '2026-10-09', 'Market study', 20000, 'Project lead');
select pg_temp.expect_error($$insert into employee_outputs (employee_id, output_date, description, quantity, amount) values ('20000000-0000-0000-0000-0000000019f1', '2026-10-05', 'Article', 2, 100)$$, '%employee_outputs_units%');
select pg_temp.expect_error($$insert into employee_outputs (employee_id, output_date, description, amount) values ('20000000-0000-0000-0000-0000000019f1', current_date + 1, 'Report', 100)$$, '%can''t be in the future%');
select pg_temp.expect_error($$insert into employee_outputs (employee_id, output_date, description, amount) values ('20000000-0000-0000-0000-0000000019f1', '2026-02-27', 'Report', 100)$$, '%before the employee''s hire date%');
select pg_temp.expect_error($$update employee_outputs set report_path = '10000000-0000-0000-0000-0000000019f0/someone-else/r.pdf', report_name = 'r.pdf' where id = '60000000-0000-0000-0000-0000000019a2'$$, '%employee''s folder%');
update employee_outputs set report_path = '10000000-0000-0000-0000-0000000019f0/20000000-0000-0000-0000-0000000019f1/a1-study.pdf', report_name = 'study.pdf'
  where id = '60000000-0000-0000-0000-0000000019a2';
-- the 13th month policy is for pay on top of the salary only
select pg_temp.expect_error($$update employees set output_pay = 'basic', output_thirteenth_month = false where id = '20000000-0000-0000-0000-0000000019f1'$$, '%employees_output_thirteenth_policy%');
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate)
values ('20000000-0000-0000-0000-0000000019f2', '10000000-0000-0000-0000-0000000019f0', 'O-002', 'Lino', 'Bautista', '2026-03-02', 'daily', 695);
select pg_temp.expect_error($$update employees set output_thirteenth_month = false where id = '20000000-0000-0000-0000-0000000019f2'$$, '%employees_output_thirteenth_policy%');
update employees set output_thirteenth_month = false where id = '20000000-0000-0000-0000-0000000019f1';
-- output pay stays on while outputs wait for their payroll
select pg_temp.expect_error($$update employees set output_pay = null, output_thirteenth_month = true where id = '20000000-0000-0000-0000-0000000019f1'$$, '%2 output(s) of this employee are not paid yet%');
commit;

\echo '--- 19.2 admins only: not the employee, not another client''s admin'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :oe, true);
select pg_temp.check((select count(*) from employee_outputs) = 0, 'the employee sees no outputs');
select pg_temp.expect_error($$insert into employee_outputs (employee_id, output_date, description, amount) values ('20000000-0000-0000-0000-0000000019f1', '2026-10-06', 'Report', 100)$$, '%Employee not found%');
select set_config('request.jwt.claim.sub', :other, true);
select pg_temp.check((select count(*) from employee_outputs where employee_id = '20000000-0000-0000-0000-0000000019f1') = 0, 'another client''s admin sees none');
select pg_temp.expect_error($$insert into employee_outputs (employee_id, output_date, description, amount) values ('20000000-0000-0000-0000-0000000019f1', '2026-10-06', 'Report', 100)$$, '%Employee not found%');
commit;

\echo '--- 19.3 a change sends the draft back for recompute; a finalized payroll locks the output'
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month, totals)
values ('30000000-0000-0000-0000-0000000019f1', '10000000-0000-0000-0000-0000000019f0', 'regular', 'semi_monthly', '2026-10-01', '2026-10-15', '2026-10-15', '2026-10-01', 1, 2, '{"employees": 1}');
insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, total_deductions)
values ('30000000-0000-0000-0000-0000000019f1', '20000000-0000-0000-0000-0000000019f1', 40000, 40000, 0);
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :oa, true);
select pg_temp.computed('30000000-0000-0000-0000-0000000019f1');
update employee_outputs set amount = 21000 where id = '60000000-0000-0000-0000-0000000019a2';
select pg_temp.check((select totals = '{}'::jsonb from payroll_runs where id = '30000000-0000-0000-0000-0000000019f1'), 'the draft computes again');
select pg_temp.computed('30000000-0000-0000-0000-0000000019f1');
select public.finalize_payroll_run('30000000-0000-0000-0000-0000000019f1');
select pg_temp.expect_error($$update employee_outputs set amount = 22000 where id = '60000000-0000-0000-0000-0000000019a2'$$, '%paid in a finalized payroll and is locked%');
select pg_temp.expect_error($$update employee_outputs set output_date = '2026-10-20' where id = '60000000-0000-0000-0000-0000000019a2'$$, '%paid in a finalized payroll and is locked%');
select pg_temp.expect_error($$delete from employee_outputs where id = '60000000-0000-0000-0000-0000000019a1'$$, '%paid in a finalized payroll and is locked%');
select pg_temp.expect_error($$insert into employee_outputs (employee_id, output_date, description, amount) values ('20000000-0000-0000-0000-0000000019f1', '2026-10-14', 'Report', 100)$$, '%already paid 2026-10-14%');
-- its report and approver can still be filed
update employee_outputs set accepted_by = 'Client CFO', note = 'signed off' where id = '60000000-0000-0000-0000-0000000019a2';
-- paid outputs don't hold output pay on
update employees set output_pay = null, output_thirteenth_month = true where id = '20000000-0000-0000-0000-0000000019f1';
select pg_temp.expect_error($$insert into employee_outputs (employee_id, output_date, description, amount) values ('20000000-0000-0000-0000-0000000019f1', '2026-10-20', 'Report', 100)$$, '%Turn on output pay%');
commit;

\echo '--- 19.4 output reports: the client''s admins store, read and remove them'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :oa, true);
insert into storage.objects (bucket_id, name, owner)
values ('output-reports', '10000000-0000-0000-0000-0000000019f0/20000000-0000-0000-0000-0000000019f1/a1-study.pdf', :oa::uuid);
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('output-reports', '10000000-0000-0000-0000-0000000019f0/not-a-uuid/x.pdf')$$, '%row-level security%');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('output-reports', '10000000-0000-0000-0000-0000000019f0/x.pdf')$$, '%row-level security%');
-- an employee of another client under this client's folder
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('output-reports', '10000000-0000-0000-0000-0000000019f0/20000000-0000-0000-0000-0000000018f2/x.pdf')$$, '%row-level security%');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'output-reports') = 1, 'the admin reads the report');
select set_config('request.jwt.claim.sub', :oe, true);
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'output-reports') = 0, 'the employee does not');
select set_config('request.jwt.claim.sub', :other, true);
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'output-reports') = 0, 'nor another client''s admin');
delete from storage.objects where bucket_id = 'output-reports';
select set_config('request.jwt.claim.sub', :oa, true);
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'output-reports') = 1, 'whose delete removed nothing');
delete from storage.objects where bucket_id = 'output-reports';
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'output-reports') = 0, 'the admin removes it');
commit;

\echo 'PASSED 19'
