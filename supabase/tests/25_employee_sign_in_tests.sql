-- Employee sign-in through auth-guard: the per-client budget of failed
-- sign-ins (employee_sign_in_check, service role only), and no table
-- privileges for the anonymous role.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set ua    '''00000000-0000-0000-0000-000000000251'''
\set ub    '''00000000-0000-0000-0000-000000000252'''
\set uc    '''00000000-0000-0000-0000-000000000253'''
\set ent   '''10000000-0000-0000-0000-0000000025a0'''
\set other '''10000000-0000-0000-0000-0000000025b0'''

create or replace function pg_temp.check(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'CHECK FAILED: %', p_msg; end if;
end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon, service_role;

-- one attempt as the edge function makes it: 5 failures per 15 minutes here
create or replace function pg_temp.try(p_client text, p_email text) returns jsonb
language sql as $$ select public.employee_sign_in_check(p_client, p_email, 5, 15, '203.0.113.9', 'suite 25') $$;
grant execute on function pg_temp.try(text, text) to service_role;

create or replace function pg_temp.failures(p_entity uuid) returns int
language sql as $$ select coalesce((select failures from public.employee_sign_in_failures where entity_id = p_entity), -1) $$;

-- fixture: two clients; logins for two employees of SI (one deactivated) and
-- one of the other client
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values
  (:ent, 'SI', 'Sign-in Co', 700),
  (:other, 'SO', 'Other Co', 700);
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate) values
  ('20000000-0000-0000-0000-0000000025a1', :ent, 'SI-1', 'Ana', 'Ingreso', '2026-01-05', 'daily', 700),
  ('20000000-0000-0000-0000-0000000025a2', :ent, 'SI-2', 'Ben', 'Baja', '2026-01-05', 'daily', 700),
  ('20000000-0000-0000-0000-0000000025b1', :other, 'SO-1', 'Cid', 'Otro', '2026-01-05', 'daily', 700);
commit;
insert into auth.users (id, email, raw_app_meta_data) values
  (:ua, 'emp2-aaaa@payslip.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000025a1"}'),
  (:ub, 'emp2-bbbb@payslip.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000025a2"}'),
  (:uc, 'emp2-cccc@payslip.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000025b1"}');
update profiles set is_active = false where id = :ub;

\echo '--- 25.1 the budget and its check are the service role''s alone'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
select pg_temp.check(not has_function_privilege('authenticated', 'public.employee_sign_in_check(text, text, int, int, text, text)', 'execute'), 'signed-in users can''t run the check');
select pg_temp.check(not has_function_privilege('anon', 'public.employee_sign_in_check(text, text, int, int, text, text)', 'execute'), 'signed-out callers can''t run the check');
select pg_temp.check(not has_table_privilege('authenticated', 'public.employee_sign_in_failures', 'select'), 'signed-in users can''t read the budget');
rollback;

\echo '--- 25.2 a right code signs in; an unknown client is refused without a row'
begin;
set local role service_role;
select pg_temp.check(pg_temp.try('SI', 'emp2-aaaa@payslip.test') = jsonb_build_object('result', 'ok', 'user_id', :ua::uuid), 'the employee''s address: ok, with the account');
select pg_temp.check(pg_temp.try('si', ' EMP2-AAAA@payslip.test ') ->> 'result' = 'ok', 'case and spaces don''t matter');
select pg_temp.check(pg_temp.failures(:ent) = 0, 'right codes count nothing');
select pg_temp.check(pg_temp.try('NOPE', 'emp2-aaaa@payslip.test') ->> 'result' = 'invalid', 'a client code no client has');
select pg_temp.check(not exists (select 1 from public.employee_sign_in_failures where entity_id not in (:ent, :other)), 'and no row for it');
rollback;

\echo '--- 25.3 only an active employee login of that client is a right code'
begin;
set local role service_role;
select pg_temp.check(pg_temp.try('SI', 'emp2-zzzz@payslip.test') ->> 'result' = 'invalid', 'an address no account has');
select pg_temp.check(pg_temp.try('SI', 'emp2-cccc@payslip.test') ->> 'result' = 'invalid', 'another client''s employee under this prefix');
select pg_temp.check(pg_temp.try('SI', 'owner@example.test') ->> 'result' = 'invalid', 'an admin account');
select pg_temp.check(pg_temp.failures(:ent) = 3, 'each counted against the client');
select pg_temp.check(pg_temp.failures(:other) = -1, 'not against the client the account belongs to');
select pg_temp.check(pg_temp.try('SI', 'emp2-bbbb@payslip.test') ->> 'result' = 'deactivated', 'a deactivated login: deactivated');
select pg_temp.check(pg_temp.failures(:ent) = 3, 'not counted as a guess');
rollback;

\echo '--- 25.4 the fifth failure refuses the client''s sign-ins until the window ends, on the trail once'
begin;
set local role service_role;
select pg_temp.try('SI', 'emp2-wrong' || g || '@payslip.test') from generate_series(1, 5) g;
select pg_temp.check(pg_temp.failures(:ent) = 5, 'five counted');
select pg_temp.check(pg_temp.try('SI', 'emp2-aaaa@payslip.test') ->> 'result' = 'throttled', 'now even a right code waits');
select pg_temp.check((pg_temp.try('SI', 'emp2-zzzz@payslip.test') ->> 'retry_at')::timestamptz
  between now() + interval '14 minutes' and now() + interval '15 minutes', 'retry_at is the end of the window');
select pg_temp.check(pg_temp.failures(:ent) = 5, 'refused attempts aren''t counted or checked');
select pg_temp.check(pg_temp.try('SO', 'emp2-cccc@payslip.test') ->> 'result' = 'ok', 'other clients sign in as usual');
select pg_temp.check((select count(*) from audit_logs where action = 'employee_sign_in_throttled' and entity_id = :ent) = 1, 'one audit row, under the client');
select pg_temp.check((select new_data ->> 'ip' from audit_logs where action = 'employee_sign_in_throttled' and entity_id = :ent) = '203.0.113.9', 'with where it came from');
-- the window ends: a fresh budget
update public.employee_sign_in_failures set window_start = now() - interval '16 minutes' where entity_id = :ent;
select pg_temp.check(pg_temp.try('SI', 'emp2-aaaa@payslip.test') ->> 'result' = 'ok', 'after the window a right code signs in');
select pg_temp.check(pg_temp.failures(:ent) = 0, 'and the count starts over');
rollback;

\echo '--- 25.5 the anonymous role has no table privileges, now or for later tables'
select pg_temp.check(not exists (select 1 from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'), 'no table grants to anon');
select pg_temp.check(not exists (
  select 1 from pg_class c where c.relnamespace = 'public'::regnamespace
    and case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'usage') else false end), 'no sequence usage for anon');
begin;
create table public.suite25_later (id int);
create sequence public.suite25_later_seq;
select pg_temp.check(not has_table_privilege('anon', 'public.suite25_later', 'select'), 'a later table starts without anon access');
select pg_temp.check(has_table_privilege('authenticated', 'public.suite25_later', 'select'), 'signed-in users keep the default (RLS decides)');
select pg_temp.check(not has_sequence_privilege('anon', 'public.suite25_later_seq', 'usage'), 'a later sequence starts without anon usage');
rollback;
select pg_temp.check(not exists (select 1 from pg_default_acl a, aclexplode(a.defaclacl) x
  where a.defaclnamespace = 'public'::regnamespace and x.grantee = 'anon'::regrole), 'no default privileges name anon');

\echo 'PASSED 25'
