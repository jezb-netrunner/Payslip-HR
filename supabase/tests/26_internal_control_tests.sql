-- Tests for the internal controls on posting a payroll: a run starts as a
-- draft, the database records who created, computed and finalized it (and
-- who reviewed a leave or entered an adjustment), and a client can require
-- a second person to finalize (four eyes).
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set ia    '''00000000-0000-0000-0000-000000000261'''
\set ib    '''00000000-0000-0000-0000-000000000262'''

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

-- what computeRun records: the payroll sequence and the run's totals
create or replace function pg_temp.computed(p_run uuid) returns void
language sql as $$
  update payslips p set employee_payroll_seq = e.payroll_seq
    from employees e where e.id = p.employee_id and p.payroll_run_id = p_run;
  update payroll_runs r
    set totals = (select jsonb_build_object('employees', count(*), 'gross', coalesce(sum(gross_pay), 0),
                                            'net', coalesce(sum(net_pay), 0), 'withholding_tax', coalesce(sum(withholding_tax), 0))
                  from payslips where payroll_run_id = p_run)
    where r.id = p_run;
$$;
grant execute on function pg_temp.computed(uuid) to authenticated;

create or replace function pg_temp.slip(p_run uuid, p_emp uuid, p_gross numeric) returns void
language sql as $$
  insert into payslips (payroll_run_id, employee_id, gross_pay, total_deductions, net_pay, earnings, deductions)
  values (p_run, p_emp, p_gross, 0, p_gross,
          jsonb_build_array(jsonb_build_object('code', 'basic', 'label', 'Basic Pay', 'amount', p_gross)), '[]'::jsonb);
$$;
grant execute on function pg_temp.slip(uuid, uuid, numeric) to authenticated;

-- fixture: client IC with two admins and one employee
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values (:ia, 'ia@ic.test', '{"role":"entity_admin"}', '{"full_name":"Ines Aguilar"}');
insert into auth.users (id, email, raw_app_meta_data) values (:ib, 'ib@ic.test', '{"role":"entity_admin"}');
update profiles set admin_session_id = null where id in (:ia, :ib);
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000026a0', 'IC', 'Ic Controls', 695);
insert into entity_admins (profile_id, entity_id) values (:ia, '10000000-0000-0000-0000-0000000026a0');
insert into entity_admins (profile_id, entity_id) values (:ib, '10000000-0000-0000-0000-0000000026a0');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ia, true);
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate)
values ('20000000-0000-0000-0000-0000000026e1', '10000000-0000-0000-0000-0000000026a0', 'I-001', 'Lito', 'Ramos', '2026-01-05', 'monthly', 30000);
commit;

\echo '--- 26.1 a payroll run starts as a draft, created by the caller'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ia, true);
select pg_temp.expect_error($$insert into payroll_runs (entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month, status, finalized_by, finalized_at)
  values ('10000000-0000-0000-0000-0000000026a0', 'special', 'monthly', '2031-01-01', '2031-01-31', '2031-01-31', '2031-01-01', 1, 1, 'finalized', '00000000-0000-0000-0000-0000000000c1', now())$$, '%starts as a draft%');
select pg_temp.expect_error($$insert into payroll_runs (entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month, status)
  values ('10000000-0000-0000-0000-0000000026a0', 'special', 'monthly', '2031-01-01', '2031-01-31', '2031-01-31', '2031-01-01', 1, 1, 'paid')$$, '%starts as a draft%');
-- a draft naming someone else as its author and finalizer, with totals that claim a computation
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month,
                          created_by, finalized_by, finalized_at, finalized_by_name, computed_by, computed_by_name, computed_at, totals)
values ('30000000-0000-0000-0000-0000000026a1', '10000000-0000-0000-0000-0000000026a0', 'regular', 'semi_monthly', '2026-10-01', '2026-10-15', '2026-10-15', '2026-10-01', 1, 2,
        :owner, :owner, now(), 'Someone Else', :ib, 'Someone Else', now(), '{"employees": 1}');
select pg_temp.check((select created_by = :ia::uuid and finalized_by is null and finalized_at is null and finalized_by_name is null
                             and computed_by is null and computed_by_name is null and computed_at is null and totals = '{}'::jsonb
                      from payroll_runs where id = '30000000-0000-0000-0000-0000000026a1'), 'the insert keeps none of the forged actor columns');
-- nor does an update of the draft
update payroll_runs set created_by = :owner, finalized_by = :owner, finalized_at = now(), finalized_by_name = 'Forged', computed_by = :ib, computed_by_name = 'Forged', computed_at = now(), notes = 'x'
  where id = '30000000-0000-0000-0000-0000000026a1';
select pg_temp.check((select created_by = :ia::uuid and finalized_by is null and finalized_at is null and finalized_by_name is null
                             and computed_by is null and computed_by_name is null and notes = 'x'
                      from payroll_runs where id = '30000000-0000-0000-0000-0000000026a1'), 'an update cannot rewrite who created, computed or finalized the run');
commit;

\echo '--- 26.2 the computation is stamped with who completed it'
select count(*) as audited_before from audit_logs where table_name = 'payroll_runs' and record_id = '30000000-0000-0000-0000-0000000026a1' \gset
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ia, true);
select pg_temp.slip('30000000-0000-0000-0000-0000000026a1', '20000000-0000-0000-0000-0000000026e1', 15000);
-- the token written before the inputs are read is not a computation
update payroll_runs set totals = '{"computing": "t"}' where id = '30000000-0000-0000-0000-0000000026a1';
select pg_temp.check((select computed_by is null from payroll_runs where id = '30000000-0000-0000-0000-0000000026a1'), 'no stamp for the computing token');
select pg_temp.computed('30000000-0000-0000-0000-0000000026a1');
select pg_temp.check((select computed_by = :ia::uuid and computed_by_name = 'Ines Aguilar' and computed_at is not null
                      from payroll_runs where id = '30000000-0000-0000-0000-0000000026a1'), 'stamped with the admin who computed it, by name');
commit;
-- a recompute by another admin restamps it
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ib, true);
update payroll_runs set totals = '{"computing": "t2"}' where id = '30000000-0000-0000-0000-0000000026a1';
select pg_temp.computed('30000000-0000-0000-0000-0000000026a1');
select pg_temp.check((select computed_by = :ib::uuid and computed_by_name = 'ib@ic.test' from payroll_runs where id = '30000000-0000-0000-0000-0000000026a1'), 'restamped with the second admin (no name on file: the email)');
commit;
-- the stamp is bookkeeping, like the totals: not on the audit trail
select pg_temp.check((select count(*) = :audited_before from audit_logs where table_name = 'payroll_runs' and record_id = '30000000-0000-0000-0000-0000000026a1'), 'computing leaves no audit row');

\echo '--- 26.3 only a company admin switches the four-eyes rule'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ia, true);
select pg_temp.expect_error($$update entities set require_second_approver = true where id = '10000000-0000-0000-0000-0000000026a0'$$, '%Only company admins%');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
update entities set require_second_approver = true where id = '10000000-0000-0000-0000-0000000026a0';
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ib, true);
select pg_temp.expect_error($$update entities set require_second_approver = false where id = '10000000-0000-0000-0000-0000000026a0'$$, '%Only company admins%');
commit;

\echo '--- 26.4 four eyes: whoever computed the draft cannot finalize it'
-- (the settings change sent the draft back to be recomputed)
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ib, true);
select pg_temp.check((select totals = '{}'::jsonb from payroll_runs where id = '30000000-0000-0000-0000-0000000026a1'), 'a settings change stales the draft');
select pg_temp.computed('30000000-0000-0000-0000-0000000026a1');
select pg_temp.expect_error($$select public.finalize_payroll_run('30000000-0000-0000-0000-0000000026a1')$$, '%you computed this draft%');
commit;
select pg_temp.check((select status = 'draft' and control_no is null from payroll_runs where id = '30000000-0000-0000-0000-0000000026a1'), 'still a draft');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ia, true);
select public.finalize_payroll_run('30000000-0000-0000-0000-0000000026a1');
select pg_temp.check((select status = 'finalized' and finalized_by = :ia::uuid and finalized_by_name = 'Ines Aguilar' and computed_by = :ib::uuid and control_no = 'PR-000001'
                      from payroll_runs where id = '30000000-0000-0000-0000-0000000026a1'), 'the other admin finalizes it: maker and checker on the run');
-- a posted run keeps them
select pg_temp.expect_error($$update payroll_runs set finalized_by_name = 'Forged' where id = '30000000-0000-0000-0000-0000000026a1'$$, '%finalized%');
commit;
-- the audit row of the posting names both
select pg_temp.check((select count(*) = 1 from audit_logs where table_name = 'payroll_runs' and record_id = '30000000-0000-0000-0000-0000000026a1'
                             and action = 'update' and new_data->>'status' = 'finalized' and actor_id = :ia::uuid
                             and new_data->>'computed_by' = '00000000-0000-0000-0000-000000000262'), 'the trail shows who computed and who finalized');

\echo '--- 26.5 a voided run is recomputed before it is reissued, by two people again'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ia, true);
select public.void_payroll_run('30000000-0000-0000-0000-0000000026a1', 'Wrong period dates');
select pg_temp.check((select status = 'draft' and finalized_by is null and finalized_by_name is null from payroll_runs where id = '30000000-0000-0000-0000-0000000026a1'), 'a draft again, no finalizer');
select pg_temp.computed('30000000-0000-0000-0000-0000000026a1');
select pg_temp.expect_error($$select public.finalize_payroll_run('30000000-0000-0000-0000-0000000026a1')$$, '%you computed this draft%');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
-- a company admin is a second person too
select public.finalize_payroll_run('30000000-0000-0000-0000-0000000026a1');
select pg_temp.check((select status = 'finalized' and finalized_by = :owner::uuid and control_no = 'PR-000002' from payroll_runs where id = '30000000-0000-0000-0000-0000000026a1'), 'reissued by the company admin');
commit;

\echo '--- 26.6 a draft computed before the rule (no stamp) is recomputed first'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ia, true);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('30000000-0000-0000-0000-0000000026a2', '10000000-0000-0000-0000-0000000026a0', 'regular', 'semi_monthly', '2026-10-16', '2026-10-31', '2026-10-31', '2026-10-01', 2, 2);
select pg_temp.slip('30000000-0000-0000-0000-0000000026a2', '20000000-0000-0000-0000-0000000026e1', 15000);
commit;
-- as a migration would leave it: computed, without a stamp
update payslips p set employee_payroll_seq = e.payroll_seq from employees e where e.id = p.employee_id and p.payroll_run_id = '30000000-0000-0000-0000-0000000026a2';
update payroll_runs set totals = '{"employees": 1, "gross": 15000, "net": 15000, "withholding_tax": 0}', computed_by = null, computed_by_name = null, computed_at = null
  where id = '30000000-0000-0000-0000-0000000026a2';
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ib, true);
select pg_temp.expect_error($$select public.finalize_payroll_run('30000000-0000-0000-0000-0000000026a2')$$, '%records who prepared it%');
commit;

\echo '--- 26.7 without the rule one admin computes and finalizes'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
update entities set require_second_approver = false where id = '10000000-0000-0000-0000-0000000026a0';
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ia, true);
select pg_temp.computed('30000000-0000-0000-0000-0000000026a2');
select public.finalize_payroll_run('30000000-0000-0000-0000-0000000026a2');
select pg_temp.check((select status = 'finalized' and computed_by = :ia::uuid and finalized_by = :ia::uuid from payroll_runs where id = '30000000-0000-0000-0000-0000000026a2'), 'computed and finalized by the same admin');
commit;

\echo '--- 26.8 the reviewer of a leave and the author of an adjustment come from the session'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ia, true);
insert into leave_requests (id, entity_id, employee_id, leave_type_id, start_date, end_date, days, reason, status, reviewed_by, reviewed_at)
select '40000000-0000-0000-0000-0000000026c1', '10000000-0000-0000-0000-0000000026a0', '20000000-0000-0000-0000-0000000026e1', id, '2026-12-01', '2026-12-01', 1, 'Errand', 'pending', :owner, '2020-01-01'
from leave_types where entity_id = '10000000-0000-0000-0000-0000000026a0' and code = 'LWOP';
select pg_temp.check((select reviewed_by is null and reviewed_at is null from leave_requests where id = '40000000-0000-0000-0000-0000000026c1'), 'a pending request has no reviewer');
update leave_requests set status = 'approved', reviewed_by = :owner, reviewed_at = '2020-01-01' where id = '40000000-0000-0000-0000-0000000026c1';
select pg_temp.check((select reviewed_by = :ia::uuid and reviewed_at > now() - interval '1 minute' from leave_requests where id = '40000000-0000-0000-0000-0000000026c1'), 'the approving admin is the reviewer, now');
-- an edit that decides nothing keeps the reviewer
update leave_requests set review_notes = 'ok', reviewed_by = :ib where id = '40000000-0000-0000-0000-0000000026c1';
select pg_temp.check((select reviewed_by = :ia::uuid and review_notes = 'ok' from leave_requests where id = '40000000-0000-0000-0000-0000000026c1'), 'a later edit cannot rename the reviewer');
-- a leave filed approved by an admin
insert into leave_requests (id, entity_id, employee_id, leave_type_id, start_date, end_date, days, reason, status, reviewed_by)
select '40000000-0000-0000-0000-0000000026c2', '10000000-0000-0000-0000-0000000026a0', '20000000-0000-0000-0000-0000000026e1', id, '2026-12-02', '2026-12-02', 1, 'Filed by HR', 'approved', :owner
from leave_types where entity_id = '10000000-0000-0000-0000-0000000026a0' and code = 'LWOP';
select pg_temp.check((select reviewed_by = :ia::uuid from leave_requests where id = '40000000-0000-0000-0000-0000000026c2'), 'filed approved: the filing admin is the reviewer');
-- an adjustment
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('30000000-0000-0000-0000-0000000026a3', '10000000-0000-0000-0000-0000000026a0', 'special', 'semi_monthly', '2026-11-01', '2026-11-15', '2026-11-15', '2026-11-01', 1, 2);
insert into payroll_adjustments (id, payroll_run_id, employee_id, entity_id, kind, label, amount, category, created_by)
values ('50000000-0000-0000-0000-0000000026d1', '30000000-0000-0000-0000-0000000026a3', '20000000-0000-0000-0000-0000000026e1', '10000000-0000-0000-0000-0000000026a0', 'earning', 'Bonus', 1000, 'other_benefits', :owner);
select pg_temp.check((select created_by = :ia::uuid from payroll_adjustments where id = '50000000-0000-0000-0000-0000000026d1'), 'the adjustment is its author''s');
update payroll_adjustments set amount = 1200, created_by = :ib where id = '50000000-0000-0000-0000-0000000026d1';
select pg_temp.check((select created_by = :ia::uuid and amount = 1200 from payroll_adjustments where id = '50000000-0000-0000-0000-0000000026d1'), 'an edit keeps the author');
commit;

\echo 'PASSED 26'
