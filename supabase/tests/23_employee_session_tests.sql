-- Employee sessions end at the database: 12 hours after sign-in, or 32
-- minutes after the last activity the app reported (or the sign-in).
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set ue    '''00000000-0000-0000-0000-000000000231'''
\set uo    '''00000000-0000-0000-0000-000000000232'''

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

-- calls of a function so far in this backend (pending statistics can include an
-- earlier transaction's for up to a second, so tests compare against a baseline)
create or replace function pg_temp.calls(p_fn regprocedure) returns bigint
language sql as $$ select coalesce(pg_stat_get_xact_function_calls(p_fn), 0) $$;
grant execute on function pg_temp.calls(regprocedure) to authenticated;

-- an API token of a session: role, subject and session id
create or replace function pg_temp.token(p_sub uuid, p_session uuid) returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated', 'aal', 'aal1', 'session_id', p_session,
                      'iat', floor(extract(epoch from now())))::text, true)
$$;
grant execute on function pg_temp.token(uuid, uuid) to authenticated;

-- fixture: a client, two employees, a login for each
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values ('10000000-0000-0000-0000-0000000023a0', 'ES', 'Session Co', 700);
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate) values
  ('20000000-0000-0000-0000-0000000023a1', '10000000-0000-0000-0000-0000000023a0', 'ES-1', 'Ella', 'Sesion', '2026-01-05', 'daily', 700),
  ('20000000-0000-0000-0000-0000000023a2', '10000000-0000-0000-0000-0000000023a0', 'ES-2', 'Omar', 'Otro', '2026-01-05', 'daily', 700);
commit;
insert into auth.users (id, email, raw_app_meta_data) values
  (:ue, 'ue@es.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000023a1"}'),
  (:uo, 'uo@es.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000023a2"}');
insert into auth.sessions (id, user_id, created_at) values
  ('50000000-0000-0000-0000-0000000023f1', :ue, now()),                          -- just signed in
  ('50000000-0000-0000-0000-0000000023f2', :ue, now() - interval '40 minutes'),  -- never active since
  ('50000000-0000-0000-0000-0000000023f3', :ue, now() - interval '2 hours'),     -- active 5 minutes ago
  ('50000000-0000-0000-0000-0000000023f4', :ue, now() - interval '13 hours'),    -- active, but past 12 hours
  ('50000000-0000-0000-0000-0000000023f5', :uo, now());                          -- the other employee's
insert into employee_session_activity (session_id, user_id, seen_at) values
  ('50000000-0000-0000-0000-0000000023f3', :ue, now() - interval '5 minutes'),
  ('50000000-0000-0000-0000-0000000023f4', :ue, now() - interval '1 minute');

\echo '--- 23.1 a fresh session reads its own records; a direct database session (no API token) too'
begin;
set local role authenticated;
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f1');
select pg_temp.check((select count(*) = 1 from employees), 'sees own employee row');
select pg_temp.check((select my_session_state()->>'state') = 'active', 'state active');
select pg_temp.check((select (my_session_state()->>'ends_in_seconds')::int > 43000), 'ends about 12 hours after sign-in');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :ue, true);
select pg_temp.check((select count(*) = 1 from employees), 'no API token: the suites act this way');
rollback;

\echo '--- 23.2 an API token without a session, or with another user''s session: nothing'
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :ue, 'role', 'authenticated')::text, true);
select pg_temp.check((select count(*) = 0 from employees), 'no session id: no access');
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f5');
select pg_temp.check((select count(*) = 0 from employees), 'another user''s session: no access');
select pg_temp.check((select my_session_state()->>'state') = 'ended', 'state ended');
rollback;

\echo '--- 23.3 32 minutes without activity: idle, and a touch does not revive it'
begin;
set local role authenticated;
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f2');
select pg_temp.check((select count(*) = 0 from employees), 'idle session: no access');
select pg_temp.check((select my_session_state()->>'state') = 'idle', 'state idle');
select pg_temp.check((select touch_employee_session()->>'state') = 'idle', 'touch answers idle');
select pg_temp.check((select count(*) = 0 from employees), 'still no access');
commit;
select pg_temp.check((select count(*) = 0 from employee_session_activity where session_id = '50000000-0000-0000-0000-0000000023f2'), 'no activity row was made for it');
select pg_temp.check((select count(*) = 0 from auth.sessions where id = '50000000-0000-0000-0000-0000000023f2'), 'the touch ended it at Auth too (its refresh token stops)');

\echo '--- 23.4 an active session: the touch keeps it going'
begin;
set local role authenticated;
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f3');
select pg_temp.check((select count(*) = 1 from employees), 'active 5 minutes ago: access');
select pg_temp.check((select (my_session_state()->>'idle_seconds')::int between 290 and 310), 'idle about 5 minutes');
select pg_temp.check((select touch_employee_session()->>'state') = 'active', 'touch answers active');
select pg_temp.check((select (my_session_state()->>'idle_seconds')::int < 5), 'activity recorded');
commit;
-- the first touch of a fresh session makes its row
begin;
set local role authenticated;
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f1');
select touch_employee_session();
commit;
select pg_temp.check((select count(*) = 1 from employee_session_activity where session_id = '50000000-0000-0000-0000-0000000023f1'), 'first touch made the row');

\echo '--- 23.5 12 hours after sign-in: expired, whatever the activity'
begin;
set local role authenticated;
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f4');
select pg_temp.check((select count(*) = 0 from employees), 'expired: no access');
select pg_temp.check((select my_session_state()->>'state') = 'expired', 'state expired');
select pg_temp.check((select touch_employee_session()->>'state') = 'expired', 'touch answers expired');
commit;
select pg_temp.check((select count(*) = 0 from auth.sessions where id = '50000000-0000-0000-0000-0000000023f4'), 'expired session ended at Auth');
select pg_temp.check((select count(*) = 0 from employee_session_activity where session_id = '50000000-0000-0000-0000-0000000023f4'), 'and its activity row gone');

\echo '--- 23.6 signed out (the Auth session is gone): ended at once'
delete from auth.sessions where id = '50000000-0000-0000-0000-0000000023f3';
begin;
set local role authenticated;
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f3');
select pg_temp.check((select count(*) = 0 from employees), 'signed out: no access');
select pg_temp.check((select my_session_state()->>'state') = 'ended', 'state ended');
rollback;

\echo '--- 23.7 the activity table is the system''s: no one reads or writes it through the API'
begin;
set local role authenticated;
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f1');
select pg_temp.expect_error($$select count(*) from employee_session_activity$$, '%permission denied%');
select pg_temp.expect_error($$update employee_session_activity set seen_at = now()$$, '%permission denied%');
select pg_temp.expect_error($$select employee_session_ok('00000000-0000-0000-0000-000000000231')$$, '%permission denied%');
rollback;
-- an admin's touch of the employee function records nothing
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :owner, 'role', 'authenticated', 'aal', 'aal2', 'session_id', '50000000-0000-0000-0000-0000000023f9')::text, true);
select touch_employee_session();
commit;
select pg_temp.check((select count(*) = 0 from employee_session_activity where session_id = '50000000-0000-0000-0000-0000000023f9'), 'no row for a non-employee');

\echo '--- 23.8 a touch clears the caller''s old rows'
insert into employee_session_activity (session_id, user_id, seen_at)
values ('50000000-0000-0000-0000-0000000023f8', :ue, now() - interval '14 hours');
begin;
set local role authenticated;
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f1');
select touch_employee_session();
commit;
select pg_temp.check((select count(*) = 0 from employee_session_activity where session_id = '50000000-0000-0000-0000-0000000023f8'), 'old row removed');

\echo '--- 23.9 client-scoped reads and filing follow the session too'
insert into announcements (entity_id, title, body) values ('10000000-0000-0000-0000-0000000023a0', 'Payday moved', 'to Friday');
select id as lwop from leave_types where entity_id = '10000000-0000-0000-0000-0000000023a0' and code = 'LWOP' \gset
begin;
set local role authenticated;
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f1');
select pg_temp.check((select count(*) = 1 from announcements), 'active: sees the client''s announcement');
select pg_temp.check((select count(*) = 1 from entities), 'active: sees the client');
insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days)
values ('20000000-0000-0000-0000-0000000023a1', :'lwop', '2026-12-01', '2026-12-01', 1);
select pg_temp.check((select count(*) = 1 from leave_requests), 'active: filed a leave');
rollback;
begin;
set local role authenticated;
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f3');
select pg_temp.check((select count(*) = 0 from announcements), 'ended: no announcements');
select pg_temp.check((select count(*) = 0 from entities), 'ended: no client');
select pg_temp.check((select count(*) = 0 from leave_types where entity_id is not null), 'ended: no client leave types');
select pg_temp.expect_error(format('insert into leave_requests (employee_id, leave_type_id, start_date, end_date, days) values (%L, %L, %L, %L, 1)',
  '20000000-0000-0000-0000-0000000023a1', :'lwop', '2026-12-01', '2026-12-01'), '%row-level security%');
select pg_temp.expect_error($$insert into time_correction_requests (employee_id, work_date, requested_clock_in, requested_clock_out, reason) values ('20000000-0000-0000-0000-0000000023a1', '2026-11-02', now(), now(), 'x')$$, '%row-level security%');
rollback;

\echo '--- 23.10 the sign-out of an ended session is still filed under the client'
begin;
set local role authenticated;
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f3');
select log_activity('sign_out', null, '{"reason":"session reached 12 hours"}');
select log_activity('report', null, '{}');
commit;
select pg_temp.check((select entity_id = '10000000-0000-0000-0000-0000000023a0' from audit_logs
  where actor_id = :ue and action = 'sign_out' order by id desc limit 1), 'sign-out filed under the client');
select pg_temp.check((select entity_id is null from audit_logs
  where actor_id = :ue and action = 'report' order by id desc limit 1), 'other activity of an ended session is not');

\echo '--- 23.11 an employee''s read: the employee helper once per statement, no admin check per row'
insert into time_entries (employee_id, work_date, clock_in, clock_out, status, source)
select e, d::date, d + interval '1 hour', d + interval '9 hours', 'closed', 'admin'
from unnest(array['20000000-0000-0000-0000-0000000023a1', '20000000-0000-0000-0000-0000000023a2']::uuid[]) e,
     generate_series('2026-03-02'::timestamptz, '2026-03-21', interval '1 day') d;
insert into holidays (entity_id, holiday_date, name, kind)
values ('10000000-0000-0000-0000-0000000023a0', '2026-03-10', 'Founding day', 'special_non_working');
begin;
set local track_functions = 'all';
set local role authenticated;
select pg_temp.token(:ue, '50000000-0000-0000-0000-0000000023f1');
select pg_temp.calls('public.current_employee_id()') as ce0, pg_temp.calls('public.current_employee_entity_id()') as cn0,
  pg_temp.calls('public.can_manage_entity(uuid)') as cm0, pg_temp.calls('public.can_manage_employee(uuid)') as cp0 \gset
select pg_temp.check((select count(*) from time_entries where work_date between '2026-03-02' and '2026-03-21') = 20, 'own 20 of the 40 entries');
select pg_temp.check(pg_temp.calls('public.current_employee_id()') - :ce0 = 1, 'current_employee_id() once, not per row');
select pg_temp.check((select count(*) from entities) = 1 and (select count(*) from holidays where entity_id is not null) = 1
  and (select count(*) from leave_types where entity_id is not null) > 0, 'own client, its holiday and leave types');
select pg_temp.check(pg_temp.calls('public.current_employee_entity_id()') - :cn0 = 3, 'current_employee_entity_id() once per statement');
select pg_temp.check(pg_temp.calls('public.can_manage_entity(uuid)') = :cm0
  and pg_temp.calls('public.can_manage_employee(uuid)') = :cp0, 'no admin check per row');
rollback;
-- the company admin still reads and manages them all
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select pg_temp.check((select count(*) from time_entries where work_date between '2026-03-02' and '2026-03-21') = 40, 'admin reads all 40');
update time_entries set admin_notes = 'checked' where work_date = '2026-03-02';
select pg_temp.check((select count(*) from time_entries where admin_notes = 'checked') = 2, 'admin updates both employees''');
rollback;
-- the policies keep the form: the helpers wrapped, the admin branches guarded
select pg_temp.check((select count(*) from pg_policies where coalesce(qual, '') || coalesce(with_check, '') ~ 'current_employee_') = 23,
  'the 23 employee policies');
select pg_temp.check((select bool_and(
    regexp_count(coalesce(qual, '') || ' ' || coalesce(with_check, ''), '(current_employee_(entity_)?id|is_company_admin)\(\)')
  = regexp_count(coalesce(qual, '') || ' ' || coalesce(with_check, ''), 'SELECT (current_employee_(entity_)?id|is_company_admin)\(\)')
  and (coalesce(qual, '') || coalesce(with_check, '') !~ 'can_manage_' or coalesce(qual, '') ~ 'SELECT caller_is_admin\(\)'))
  from pg_policies p where cmd in ('ALL', 'SELECT') and exists (select 1 from pg_policies e where e.tablename = p.tablename
    and coalesce(e.qual, '') || coalesce(e.with_check, '') ~ 'current_employee_')),
  'on the tables employees read: no helper per row, every admin branch behind caller_is_admin()');
select pg_temp.check((select count(*) from pg_policies where qual ~ 'SELECT caller_is_admin\(\)') = 19, '16 admin policies and 3 mixed read policies guarded');

\echo 'PASSED 23'
