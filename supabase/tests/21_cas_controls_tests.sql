-- Tests for the payroll system's CAS controls (BIR RMO 9-2021 Annex B):
-- control numbers given at finalize and never reused, the totals
-- cross-check, void and reissue (the posted version kept, reopen refused),
-- an audit trail app users cannot write, report and sign-in activity, the
-- sign-in guard's table, and one active admin session.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set xa    '''00000000-0000-0000-0000-000000000211'''
\set xo    '''00000000-0000-0000-0000-000000000212'''

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

-- a payslip whose lines add up: basic pay, less SSS and tax
create or replace function pg_temp.slip(p_run uuid, p_emp uuid, p_gross numeric, p_sss numeric, p_tax numeric) returns void
language sql as $$
  insert into payslips (payroll_run_id, employee_id, gross_pay, sss_ee, withholding_tax, total_deductions, net_pay, earnings, deductions)
  values (p_run, p_emp, p_gross, p_sss, p_tax, p_sss + p_tax, p_gross - p_sss - p_tax,
          jsonb_build_array(jsonb_build_object('code', 'basic', 'label', 'Basic Pay', 'amount', p_gross)),
          jsonb_build_array(jsonb_build_object('code', 'sss', 'label', 'SSS', 'amount', p_sss),
                            jsonb_build_object('code', 'wht', 'label', 'Withholding tax', 'amount', p_tax)));
$$;
grant execute on function pg_temp.slip(uuid, uuid, numeric, numeric, numeric) to authenticated;

-- fixture: client CX, its admin, two employees and a payroll
insert into auth.users (id, email, raw_app_meta_data) values (:xa, 'xa@cx.test', '{"role":"entity_admin"}');
insert into auth.users (id, email, raw_app_meta_data) values (:xo, 'xo@other.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000021f0', 'CX', 'Cx Trading', 695);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000021f9', 'CY', 'Cy Other', 695);
insert into entity_admins (profile_id, entity_id) values (:xa, '10000000-0000-0000-0000-0000000021f0');
insert into entity_admins (profile_id, entity_id) values (:xo, '10000000-0000-0000-0000-0000000021f9');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xa, true);
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, monthly_rate)
values ('20000000-0000-0000-0000-0000000021f1', '10000000-0000-0000-0000-0000000021f0', 'X-001', 'Ana', 'Bautista', '2026-01-05', 'monthly', 30000),
       ('20000000-0000-0000-0000-0000000021f2', '10000000-0000-0000-0000-0000000021f0', 'X-002', 'Ben', 'Aquino', '2026-01-05', 'monthly', 20000);
insert into payroll_runs (id, entity_id, run_type, pay_frequency, period_start, period_end, pay_date, period_month, period_index, periods_in_month)
values ('30000000-0000-0000-0000-0000000021a1', '10000000-0000-0000-0000-0000000021f0', 'regular', 'semi_monthly', '2026-09-01', '2026-09-15', '2026-09-15', '2026-09-01', 1, 2),
       ('30000000-0000-0000-0000-0000000021a2', '10000000-0000-0000-0000-0000000021f0', 'regular', 'semi_monthly', '2026-09-16', '2026-09-30', '2026-09-30', '2026-09-01', 2, 2);
commit;

\echo '--- 21.1 control numbers: only finalize gives them, in name order, never reused'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xa, true);
select pg_temp.expect_error($$update payroll_runs set control_no = 'PR-000777' where id = '30000000-0000-0000-0000-0000000021a1'$$, '%assigned by the system%');
select pg_temp.expect_error($$insert into payslips (payroll_run_id, employee_id, gross_pay, net_pay, control_no) values ('30000000-0000-0000-0000-0000000021a1', '20000000-0000-0000-0000-0000000021f1', 0, 0, 'PS-000001')$$, '%assigned by the system%');
select pg_temp.slip('30000000-0000-0000-0000-0000000021a1', '20000000-0000-0000-0000-0000000021f1', 15000, 750, 1000);
select pg_temp.slip('30000000-0000-0000-0000-0000000021a1', '20000000-0000-0000-0000-0000000021f2', 10000, 500, 0);
select pg_temp.computed('30000000-0000-0000-0000-0000000021a1');
select public.finalize_payroll_run('30000000-0000-0000-0000-0000000021a1');
select pg_temp.check((select control_no = 'PR-000001' from payroll_runs where id = '30000000-0000-0000-0000-0000000021a1'), 'the first payroll of the client is PR-000001');
-- Aquino before Bautista
select pg_temp.check((select string_agg(control_no, ',' order by control_no) = 'PS-000001,PS-000002' from payslips where payroll_run_id = '30000000-0000-0000-0000-0000000021a1'), 'payslips numbered PS-000001, PS-000002');
select pg_temp.check((select control_no = 'PS-000001' from payslips where employee_id = '20000000-0000-0000-0000-0000000021f2'), 'in name order: Aquino first');
select pg_temp.expect_error($$update payslips set control_no = 'PS-000009' where payroll_run_id = '30000000-0000-0000-0000-0000000021a1'$$, '%');
commit;

\echo '--- 21.2 the totals cross-check refuses an out-of-balance draft'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xa, true);
select pg_temp.slip('30000000-0000-0000-0000-0000000021a2', '20000000-0000-0000-0000-0000000021f1', 15000, 750, 1000);
select pg_temp.slip('30000000-0000-0000-0000-0000000021a2', '20000000-0000-0000-0000-0000000021f2', 10000, 500, 0);
select pg_temp.computed('30000000-0000-0000-0000-0000000021a2');
-- a payslip whose net does not follow its lines
update payslips set net_pay = net_pay + 100 where payroll_run_id = '30000000-0000-0000-0000-0000000021a2' and employee_id = '20000000-0000-0000-0000-0000000021f2';
select pg_temp.computed('30000000-0000-0000-0000-0000000021a2');
select pg_temp.expect_error($$select public.finalize_payroll_run('30000000-0000-0000-0000-0000000021a2')$$, '%Out of balance: the payslip lines of Ben Aquino%');
update payslips set net_pay = net_pay - 100 where payroll_run_id = '30000000-0000-0000-0000-0000000021a2' and employee_id = '20000000-0000-0000-0000-0000000021f2';
-- run totals that no longer match the payslips
update payroll_runs set totals = totals || '{"gross": 1}'::jsonb where id = '30000000-0000-0000-0000-0000000021a2';
select pg_temp.expect_error($$select public.finalize_payroll_run('30000000-0000-0000-0000-0000000021a2')$$, '%Out of balance: the run totals%');
select pg_temp.check(public.payroll_run_out_of_balance('30000000-0000-0000-0000-0000000021a2') like 'Out of balance: the run totals%', 'the check is readable before finalizing');
select pg_temp.computed('30000000-0000-0000-0000-0000000021a2');
select pg_temp.check(public.payroll_run_out_of_balance('30000000-0000-0000-0000-0000000021a2') is null, 'balanced once recomputed');
select public.finalize_payroll_run('30000000-0000-0000-0000-0000000021a2');
select pg_temp.check((select control_no = 'PR-000002' from payroll_runs where id = '30000000-0000-0000-0000-0000000021a2'), 'the second payroll is PR-000002');
select pg_temp.check((select string_agg(control_no, ',' order by control_no) = 'PS-000003,PS-000004' from payslips where payroll_run_id = '30000000-0000-0000-0000-0000000021a2'), 'payslip numbers continue');
commit;

\echo '--- 21.3 a posted payroll is voided and reissued, never reopened'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xa, true);
select pg_temp.expect_error($$select public.reopen_payroll_run('30000000-0000-0000-0000-0000000021a2')$$, '%void it with a reason%');
select pg_temp.expect_error($$select public.void_payroll_run('30000000-0000-0000-0000-0000000021a2', 'oops')$$, '%reason for voiding%');
select pg_temp.expect_error($$delete from payroll_runs where id = '30000000-0000-0000-0000-0000000021a2'$$, '%finalized payroll run is never deleted%');
select public.void_payroll_run('30000000-0000-0000-0000-0000000021a2', 'Ben''s September allowance was left out');
select pg_temp.check((select status = 'draft' and control_no is null and finalized_at is null from payroll_runs where id = '30000000-0000-0000-0000-0000000021a2'), 'the run is a draft again, without its number');
select pg_temp.check((select count(*) = 2 from payslips where payroll_run_id = '30000000-0000-0000-0000-0000000021a2' and control_no is null), 'the draft payslips lost their numbers');
select pg_temp.check((select run_control_no = 'PR-000002' and reason = 'Ben''s September allowance was left out' and voided_by = :xa::uuid
                             and jsonb_array_length(payslips) = 2
                             and payslips->0->>'control_no' = 'PS-000003' and payslips->1->>'control_no' = 'PS-000004'
                      from payroll_voids where payroll_run_id = '30000000-0000-0000-0000-0000000021a2'), 'the posted version is kept with its numbers, reason and author');
select pg_temp.check((select count(*) = 1 from audit_logs where action = 'void' and record_id = '30000000-0000-0000-0000-0000000021a2' and new_data->>'reason' like 'Ben%'), 'the void is on the audit trail');
-- the archive can't be changed or removed
select pg_temp.expect_error($$update payroll_voids set reason = 'changed later' where payroll_run_id = '30000000-0000-0000-0000-0000000021a2'$$, '%permission denied%');
select pg_temp.expect_error($$delete from payroll_voids where payroll_run_id = '30000000-0000-0000-0000-0000000021a2'$$, '%permission denied%');
commit;
select pg_temp.check((select count(*) = 1 and min(reason) = 'Ben''s September allowance was left out' from payroll_voids where payroll_run_id = '30000000-0000-0000-0000-0000000021a2'), 'no app user changes or removes a voided version');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xa, true);
-- reissue: recomputed and finalized again, under new numbers
delete from payslips where payroll_run_id = '30000000-0000-0000-0000-0000000021a2';
select pg_temp.slip('30000000-0000-0000-0000-0000000021a2', '20000000-0000-0000-0000-0000000021f1', 15000, 750, 1000);
select pg_temp.slip('30000000-0000-0000-0000-0000000021a2', '20000000-0000-0000-0000-0000000021f2', 11000, 550, 0);
select pg_temp.computed('30000000-0000-0000-0000-0000000021a2');
select public.finalize_payroll_run('30000000-0000-0000-0000-0000000021a2');
select pg_temp.check((select control_no = 'PR-000003' from payroll_runs where id = '30000000-0000-0000-0000-0000000021a2'), 'the reissued payroll is PR-000003');
select pg_temp.check((select string_agg(control_no, ',' order by control_no) = 'PS-000005,PS-000006' from payslips where payroll_run_id = '30000000-0000-0000-0000-0000000021a2'), 'the voided numbers are never reused');
commit;
-- another client's admin sees no voided version
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xo, true);
select pg_temp.check((select count(*) = 0 from payroll_voids), 'voided versions are the client''s admins'' only');
select pg_temp.expect_error($$select public.void_payroll_run('30000000-0000-0000-0000-0000000021a2', 'not my client')$$, '%Payroll run not found%');
select pg_temp.expect_error($$select public.payroll_run_out_of_balance('30000000-0000-0000-0000-0000000021a2')$$, '%Payroll run not found%');
commit;

\echo '--- 21.4 no app user writes the audit trail, activity goes through log_activity'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xa, true);
select pg_temp.expect_error($$insert into audit_logs (action, table_name) values ('insert', 'fake')$$, '%permission denied%');
select pg_temp.expect_error($$update audit_logs set action = 'x' where table_name = 'payroll_runs'$$, '%permission denied%');
select pg_temp.expect_error($$delete from audit_logs where table_name = 'payroll_runs'$$, '%permission denied%');
select pg_temp.expect_error($$truncate audit_logs$$, '%permission denied%');
select public.log_activity('export', '10000000-0000-0000-0000-0000000021f0', '{"report": "payroll register", "run": "PR-000001"}');
select pg_temp.check((select count(*) = 1 from audit_logs where action = 'export' and table_name = 'activity' and actor_id = :xa::uuid
                             and actor_email = 'xa@cx.test' and entity_id = '10000000-0000-0000-0000-0000000021f0' and new_data->>'run' = 'PR-000001'), 'the export is logged with its author');
select pg_temp.expect_error($$select public.log_activity('delete_everything', null, '{}')$$, '%Unknown activity%');
select pg_temp.expect_error($$select public.log_activity('report', '10000000-0000-0000-0000-0000000021f9', '{}')$$, '%Client not found%');
select pg_temp.expect_error($$select public.log_activity('report', null, '[1, 2]')$$, '%short object%');
-- the sign-in guard's table is the service role's only
select pg_temp.expect_error($$select * from auth_guard$$, '%permission denied%');
select pg_temp.expect_error($$select * from document_counters$$, '%permission denied%');
commit;
-- an employee's sign-in is filed under their own client, named after them
insert into auth.users (id, email, raw_app_meta_data)
  values ('00000000-0000-0000-0000-0000000021e1', 'x-001@codes.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000021f1"}');
update profiles set email = null, full_name = '' where id = '00000000-0000-0000-0000-0000000021e1';
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000021e1', true);
select public.log_activity('sign_in', null, '{"method": "login code", "via": "admin sign-in", "ip": "198.51.100.1"}');
select pg_temp.expect_error($$select public.log_activity('export', '10000000-0000-0000-0000-0000000021f9', '{}')$$, '%Client not found%');
commit;
select pg_temp.check((select count(*) = 1 from audit_logs where action = 'sign_in' and actor_id = '00000000-0000-0000-0000-0000000021e1'
                             and entity_id = '10000000-0000-0000-0000-0000000021f0' and actor_email = 'Ana Bautista'),
  'an employee sign-in is filed under their client and names them');
select pg_temp.check((select new_data = '{"method": "login code", "source": "app"}' from audit_logs where action = 'sign_in' and actor_id = '00000000-0000-0000-0000-0000000021e1'),
  'the app''s entry is marked as such, without the keys only the sign-in guard writes');
begin;
set local role anon;
select pg_temp.expect_error($$select public.log_activity('sign_in', null, '{}')$$, '%permission denied%');
select pg_temp.expect_error($$select * from payroll_voids$$, '%permission denied%');
commit;

-- the app's entries are capped: 120 in ten minutes per user (xa has one already)
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xa, true);
select public.log_activity('report', null, '{}') from generate_series(1, 119);
select pg_temp.expect_error($$select public.log_activity('report', null, '{}')$$, '%Too many activity entries%');
commit;

\echo '--- 21.4b the guard checks passwords in the database, counts failures and locks, for the service role only'
-- xa's Auth password is the keyed form of Right2026pw (set through the guard)
update auth.users set encrypted_password = extensions.crypt('k1.keyed-Right2026pw', extensions.gen_salt('bf', 4)) where id = :xa;
insert into auth.users (id, email, encrypted_password) values
  ('00000000-0000-0000-0000-0000000021e2', 'argon@cx.test', '$argon2id$v=19$m=65536,t=3,p=4$abc$def'),
  ('00000000-0000-0000-0000-0000000021e3', 'bcrypt2b@cx.test', '$2b$10$abcdefghijklmnopqrstuuJ4bqUeRfAqG1nVv7v1o9tYxYxYxYxYx'),
  ('00000000-0000-0000-0000-0000000021e4', 'legacy@cx.test', extensions.crypt('Plain2026pw', extensions.gen_salt('bf', 4)));
begin;
set local role service_role;
select pg_temp.check(public.guard_sign_in('xa@cx.test', 'Right2026pw', 'k1.keyed-Right2026pw', 5, 30, '203.0.113.7', 'test') = '{"result": "ok", "keyed": true}', 'the keyed password');
select pg_temp.check(public.guard_sign_in('  XA@cx.test ', 'x', 'k1.keyed-Right2026pw', 5, 30, null, null)->>'result' = 'ok', 'the email matched as typed, any case');
select pg_temp.check(public.guard_sign_in('xa@cx.test', 'k1.keyed-Right2026pw', 'k1.other', 5, 30, null, null)->>'result' = 'ok', 'either form is tried');
select pg_temp.check(public.guard_sign_in('legacy@cx.test', 'Plain2026pw', 'k1.keyed-Plain2026pw', 5, 30, null, null) = '{"result": "ok", "keyed": false}', 'a password set before the guard (plain at the Auth server)');
select pg_temp.check(public.guard_sign_in('nobody@cx.test', 'x', 'y', 5, 30, null, null) = '{"result": "no_account"}', 'no such account');
select pg_temp.check((select count(*) = 0 from auth_guard where email = 'nobody@cx.test'), 'and nothing stored for it');
select pg_temp.check(public.guard_sign_in('argon@cx.test', 'x', 'y', 5, 30, null, null)->>'result' = 'upstream', 'an argon2 hash goes to the Auth server');
select pg_temp.check(public.guard_sign_in('bcrypt2b@cx.test', 'x', 'y', 5, 30, null, null)->>'result' = 'upstream', 'so does $2b$, which pgcrypto misreads');
-- four wrong passwords are counted and logged, the fifth locks
select pg_temp.check(public.guard_sign_in('legacy@cx.test', 'Wrong' || n || 'pw', 'k1.w', 5, 30, '203.0.113.9', 'test') = '{"result": "invalid"}', 'wrong password ' || n) from generate_series(1, 4) n;
select pg_temp.check((select failed_attempts = 4 from auth_guard where email = 'legacy@cx.test'), 'four failures counted');
select pg_temp.check(public.guard_sign_in('legacy@cx.test', 'Wrong5pw', 'k1.w', 5, 30, null, null)->>'result' = 'locked', 'the fifth locks');
select pg_temp.check(public.guard_sign_in('legacy@cx.test', 'Plain2026pw', 'k1.keyed-Plain2026pw', 5, 30, null, null)->>'result' = 'locked', 'even the right password waits out the lock');
select pg_temp.check((select count(*) = 4 from audit_logs where action = 'sign_in_failed' and actor_email = 'legacy@cx.test' and new_data->>'ip' = '203.0.113.9'), 'the failures are on the trail');
select pg_temp.check((select count(*) = 1 from audit_logs where action = 'sign_in_locked' and actor_email = 'legacy@cx.test'), 'the lock is on the trail once');
commit;
-- a lock ends after its period; a right password then clears the count
update auth_guard set locked_until = now() - interval '1 minute', failed_attempts = 0, last_failed_at = now() - interval '31 minutes' where email = 'legacy@cx.test';
begin;
set local role service_role;
select pg_temp.check(public.guard_sign_in('legacy@cx.test', 'Wrong6pw', 'k1.w', 5, 30, null, null) = '{"result": "invalid"}', 'after the lock, a wrong password counts from one');
select pg_temp.check((select failed_attempts = 1 from auth_guard where email = 'legacy@cx.test'), 'a new run of failures');
select pg_temp.check(public.guard_sign_in('legacy@cx.test', 'Plain2026pw', 'k1.x', 5, 30, null, null)->>'result' = 'ok', 'then the right password');
select pg_temp.check((select failed_attempts = 0 and last_failed_at is null from auth_guard where email = 'legacy@cx.test'), 'clears the count');
-- a failure the Auth server found (an upstream hash) counts the same way
select pg_temp.check(public.guard_record_failure('argon@cx.test', 5, 30, null, null) = '{"result": "invalid"}', 'an upstream failure counts');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :xa, true);
select pg_temp.expect_error($$select public.guard_sign_in('xa@cx.test', 'Right2026pw', 'k', 5, 30, null, null)$$, '%permission denied%');
select pg_temp.expect_error($$select public.guard_record_failure('xa@cx.test', 5, 30, null, null)$$, '%permission denied%');
commit;
begin;
set local role anon;
select pg_temp.expect_error($$select public.guard_sign_in('xa@cx.test', 'Right2026pw', 'k', 5, 30, null, null)$$, '%permission denied%');
commit;

\echo '--- 21.4c control numbers keep six digits and grow past them; an account made an admin starts without an admin session'
select pg_temp.check(public.format_control_no('PS', 7) = 'PS-000007', 'six running digits');
select pg_temp.check(public.format_control_no('PS', 1000000) = 'PS-1000000', 'a seventh digit past 999,999, never truncated');
-- a company admin promotes an employee login: it is no admin until it signs in through the guard
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
update profiles set role = 'entity_admin', employee_id = null where id = '00000000-0000-0000-0000-0000000021e1';
commit;
select pg_temp.check((select admin_session_id is not null from profiles where id = '00000000-0000-0000-0000-0000000021e1'), 'the promoted account has no admin session yet');
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000021e1', 'session_id', '40000000-0000-0000-0000-0000000021d1')::text, true);
select pg_temp.check(not public.can_manage_entity('10000000-0000-0000-0000-0000000021f0'), 'so none of its sessions manages a client');
commit;

\echo '--- 21.5 one active admin session: only the session the sign-in guard admitted'
-- the admin signed in through the guard twice: the second sign-in admitted
-- session b2, so session b1 (and any session made straight against the Auth
-- API) has no admin access
insert into auth.sessions (id, user_id) values ('40000000-0000-0000-0000-0000000021b2', :xa);
update profiles set admin_session_id = '40000000-0000-0000-0000-0000000021b2' where id = :xa;
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :xa, 'iat', 1790000000, 'session_id', '40000000-0000-0000-0000-0000000021b1')::text, true);
select pg_temp.check(not public.can_manage_entity('10000000-0000-0000-0000-0000000021f0'), 'a session the guard did not admit can''t manage the client');
select pg_temp.check((select count(*) = 0 from employees where entity_id = '10000000-0000-0000-0000-0000000021f0'), 'and reads nothing');
select pg_temp.check(not public.my_session_active(), 'it is not the active session');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :xa, 'iat', 1790000060, 'session_id', '40000000-0000-0000-0000-0000000021b2')::text, true);
select pg_temp.check(public.can_manage_entity('10000000-0000-0000-0000-0000000021f0'), 'the admitted session manages the client');
select pg_temp.check((select count(*) = 2 from employees where entity_id = '10000000-0000-0000-0000-0000000021f0'), 'and reads its employees');
select pg_temp.check(public.my_session_active(), 'the admitted session is the active one');
commit;
-- a revocation (deactivation, a password reset by another admin) ends even the admitted session
update profiles set sessions_revoked_at = to_timestamp(1790000100) where id = :xa;
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :xa, 'iat', 1790000060, 'session_id', '40000000-0000-0000-0000-0000000021b2')::text, true);
select pg_temp.check(not public.can_manage_entity('10000000-0000-0000-0000-0000000021f0'), 'a session older than a revocation can''t manage the client');
select pg_temp.check(not public.my_session_active(), 'and is not active');
commit;
-- a company admin's session the guard did not admit is not a company admin
update profiles set admin_session_id = '40000000-0000-0000-0000-0000000021c1' where id = :owner;
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :owner, 'iat', 1790000000, 'session_id', '40000000-0000-0000-0000-0000000021c2')::text, true);
select pg_temp.check(not public.is_company_admin(), 'a company admin session the guard did not admit is not a company admin');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :owner, 'iat', 1790000000, 'session_id', '40000000-0000-0000-0000-0000000021c1')::text, true);
select pg_temp.check(public.is_company_admin(), 'its admitted session is');
-- and no admin moves the sessions themselves (a second session of their own)
select pg_temp.expect_error(format('update profiles set admin_session_id = %L where id = %L', '40000000-0000-0000-0000-0000000021c2', :owner), '%managed by the system%');
select pg_temp.expect_error(format('update profiles set sessions_revoked_at = null where id = %L', :xa), '%managed by the system%');
commit;
update profiles set sessions_revoked_at = null, admin_session_id = null where id in (:owner, :xa);

\echo 'PASSED 21'
