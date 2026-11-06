-- Admin policies ask "which clients may this caller manage" once per
-- statement (managed_entity_ids / managed_employee_ids), not once per row,
-- with the same answers as the per-row can_manage_entity they replaced.
\set ON_ERROR_STOP 1
\set owner '''00000000-0000-0000-0000-0000000000c1'''
\set aa    '''00000000-0000-0000-0000-000000000241'''
\set ab    '''00000000-0000-0000-0000-000000000242'''
\set ad    '''00000000-0000-0000-0000-000000000243'''
\set ar    '''00000000-0000-0000-0000-000000000244'''
\set ue    '''00000000-0000-0000-0000-000000000245'''

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

-- can_manage_entity as it was before 20261106130000 (one per-row lookup)
create or replace function pg_temp.old_can_manage_entity(p_entity uuid) returns boolean
language sql stable as $$
  select p_entity is not null and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active
      and (p.sessions_revoked_at is null
           or coalesce((auth.jwt()->>'iat')::bigint, 0) >= floor(extract(epoch from p.sessions_revoked_at)))
      and public.admin_session_ok(p.id, p.admin_session_id)
      and (
        p.role = 'company_admin'
        or (p.role = 'entity_admin' and exists (
              select 1 from public.entity_admins ea
              join public.entities en on en.id = ea.entity_id
              where ea.profile_id = p.id and ea.entity_id = p_entity and en.is_active))
      )
  )
$$;

-- fixture: clients P1, P2 (deactivated later) and P3; admin AA of P1 and P2,
-- AB of P3, AD of P1 (deactivated), AR of P1 (sessions revoked); an employee
-- of P1 and one of P3 with time entries
insert into auth.users (id, email, raw_app_meta_data) values
  (:aa, 'aa@p.test', '{"role":"entity_admin"}'),
  (:ab, 'ab@p.test', '{"role":"entity_admin"}'),
  (:ad, 'ad@p.test', '{"role":"entity_admin"}'),
  (:ar, 'ar@p.test', '{"role":"entity_admin"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
insert into entities (id, code, name, minimum_wage_daily) values
  ('10000000-0000-0000-0000-0000000024a1', 'P1', 'Policy One', 700),
  ('10000000-0000-0000-0000-0000000024a2', 'P2', 'Policy Two', 700),
  ('10000000-0000-0000-0000-0000000024a3', 'P3', 'Policy Three', 700);
insert into entity_admins (profile_id, entity_id) values
  (:aa, '10000000-0000-0000-0000-0000000024a1'),
  (:aa, '10000000-0000-0000-0000-0000000024a2'),
  (:ab, '10000000-0000-0000-0000-0000000024a3'),
  (:ad, '10000000-0000-0000-0000-0000000024a1'),
  (:ar, '10000000-0000-0000-0000-0000000024a1');
insert into employees (id, entity_id, employee_no, first_name, last_name, hire_date, pay_type, daily_rate) values
  ('20000000-0000-0000-0000-0000000024e1', '10000000-0000-0000-0000-0000000024a1', 'P1-1', 'Pia', 'Uno', '2026-01-05', 'daily', 700),
  ('20000000-0000-0000-0000-0000000024e3', '10000000-0000-0000-0000-0000000024a3', 'P3-1', 'Tess', 'Tres', '2026-01-05', 'daily', 700);
commit;
insert into auth.users (id, email, raw_app_meta_data)
values (:ue, 'ue@p.test', '{"role":"employee","employee_id":"20000000-0000-0000-0000-0000000024e1"}');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :owner, true);
update entities set is_active = false where id = '10000000-0000-0000-0000-0000000024a2';
update profiles set is_active = false where id = :ad;
commit;
update profiles set sessions_revoked_at = now() + interval '1 minute' where id = :ar;
select pg_temp.check((select count(*) from profiles where (id = :ad and not is_active) or (id = :ar and sessions_revoked_at > now())) = 2, 'fixture: AD deactivated, AR revoked');
insert into time_entries (employee_id, work_date, clock_in, clock_out, status, source)
select e, d::date, d + interval '1 hour', d + interval '9 hours', 'closed', 'admin'
from unnest(array['20000000-0000-0000-0000-0000000024e1', '20000000-0000-0000-0000-0000000024e3']::uuid[]) e,
     generate_series('2026-04-01'::timestamptz, '2026-04-30', interval '1 day') d;

-- as each caller (direct claims: the session rules are the suites 21 and 23's)
create or replace function pg_temp.as_caller(p_sub uuid) returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'iat', floor(extract(epoch from now())))::text, true)
$$;
grant execute on function pg_temp.as_caller(uuid) to authenticated;

\echo '--- 24.1 the managed clients: active ones only, nothing for a deactivated or revoked admin'
begin;
select pg_temp.as_caller(:aa);
select pg_temp.check(managed_entity_ids() = array['10000000-0000-0000-0000-0000000024a1']::uuid[], 'AA: P1, not the deactivated P2');
select pg_temp.as_caller(:ab);
select pg_temp.check(managed_entity_ids() = array['10000000-0000-0000-0000-0000000024a3']::uuid[], 'AB: P3');
select pg_temp.as_caller(:ad);
select pg_temp.check(managed_entity_ids() = '{}', 'deactivated admin: none');
select pg_temp.as_caller(:ar);
select pg_temp.check(managed_entity_ids() = '{}', 'revoked sessions: none');
select pg_temp.as_caller(:owner);
select pg_temp.check(managed_entity_ids() = '{}' and is_company_admin(), 'company admin: by is_company_admin, not a list');
select pg_temp.check((select count(*) from managed_employee_ids()) = (select count(*) from employees), 'company admin: every employee');
select pg_temp.as_caller(:ue);
select pg_temp.check(managed_entity_ids() = '{}' and (select count(*) from managed_employee_ids()) = 0, 'employee: none');
rollback;

\echo '--- 24.2 the same answers as before, for every caller, client and employee'
begin;
create temp table callers (id uuid);
insert into callers select id from profiles;
insert into callers values (null), ('00000000-0000-0000-0000-00000000dead');
create temp table probe_entities (id uuid);
insert into probe_entities select id from entities;
insert into probe_entities values (null), ('10000000-0000-0000-0000-00000000dead');
create temp table probe_employees (id uuid);
insert into probe_employees select id from employees;
insert into probe_employees values (null), ('20000000-0000-0000-0000-00000000dead');
create temp table mismatches (caller uuid, what text, x uuid);
do $$
declare c uuid; begin
  for c in select id from callers loop
    perform pg_temp.as_caller(c);
    insert into mismatches select c, 'entity', e.id from probe_entities e
      where public.can_manage_entity(e.id) is distinct from pg_temp.old_can_manage_entity(e.id)
         or ((e.id is not null and ((select public.is_company_admin()) or e.id = any ((select public.managed_entity_ids())::uuid[]))) is not true)
            <> (pg_temp.old_can_manage_entity(e.id) is not true);
    insert into mismatches select c, 'employee', x.id from probe_employees x
      where (public.can_manage_employee(x.id) is true)
         <> (coalesce(x.id in (select public.managed_employee_ids()), false))
         or (public.can_manage_employee(x.id) is true)
         <> (pg_temp.old_can_manage_entity((select entity_id from public.employees where id = x.id)) is true);
  end loop;
end $$;
select pg_temp.check((select count(*) from callers) > 8 and (select count(*) from probe_entities) > 5, 'probed many callers and clients');
select pg_temp.check((select count(*) from mismatches) = 0,
  'no differences: ' || coalesce((select string_agg(caller || ' ' || what || ' ' || coalesce(x::text, 'null'), ', ') from mismatches), ''));
rollback;

\echo '--- 24.3 an admin read: the client list once per statement, no per-row check'
begin;
set local track_functions = 'all';
set local role authenticated;
select pg_temp.as_caller(:aa);
select pg_temp.calls('public.managed_entity_ids()') as me0, pg_temp.calls('public.managed_employee_ids()') as mp0,
  pg_temp.calls('public.can_manage_entity(uuid)') as cm0, pg_temp.calls('public.can_manage_employee(uuid)') as cp0,
  pg_temp.calls('public.is_company_admin()') as ic0 \gset
select pg_temp.check((select count(*) from time_entries where work_date between '2026-04-01' and '2026-04-30') = 30, 'AA: P1''s 30 entries, not P3''s');
select pg_temp.check((select count(*) from employees where entity_id in ('10000000-0000-0000-0000-0000000024a1', '10000000-0000-0000-0000-0000000024a3')) = 1, 'AA: P1''s employee only');
select pg_temp.check(pg_temp.calls('public.can_manage_entity(uuid)') = :cm0
  and pg_temp.calls('public.can_manage_employee(uuid)') = :cp0, 'no can_manage_* per row');
select pg_temp.check(pg_temp.calls('public.managed_entity_ids()') - :me0 = 2, 'managed_entity_ids() once per statement');
-- an employee-keyed policy: the managed employees built once (a hashed subplan), not per row
select pg_temp.check((select count(*) from profiles where id = :ue) = 1, 'AA sees the profile of P1''s employee');
select pg_temp.check(pg_temp.calls('public.managed_employee_ids()') - :mp0 = 1, 'managed_employee_ids() once');
rollback;
begin;
set local role authenticated;
select pg_temp.as_caller(:ab);
select pg_temp.check((select count(*) from profiles where id = :ue) = 0, 'AB does not');
rollback;
begin;
set local track_functions = 'all';
set local role authenticated;
select pg_temp.as_caller(:owner);
select pg_temp.calls('public.managed_entity_ids()') as me0, pg_temp.calls('public.managed_employee_ids()') as mp0,
  pg_temp.calls('public.can_manage_entity(uuid)') as cm0, pg_temp.calls('public.can_manage_employee(uuid)') as cp0,
  pg_temp.calls('public.is_company_admin()') as ic0 \gset
select pg_temp.check((select count(*) from time_entries where work_date between '2026-04-01' and '2026-04-30') = 60, 'company admin: all 60');
select pg_temp.check(pg_temp.calls('public.is_company_admin()') - :ic0 = 1, 'is_company_admin() once per statement');
select pg_temp.check(pg_temp.calls('public.can_manage_entity(uuid)') = :cm0, 'no can_manage_entity per row');
rollback;

\echo '--- 24.4 writes follow the same rule'
begin;
set local role authenticated;
select pg_temp.as_caller(:aa);
update time_entries set admin_notes = 'seen' where work_date = '2026-04-01';
select pg_temp.check((select count(*) from time_entries where admin_notes = 'seen') = 1, 'AA updates P1''s entry only');
rollback;
begin;
set local role authenticated;
select pg_temp.as_caller(:ab);
update time_entries set admin_notes = 'seen' where work_date = '2026-04-01';
rollback;
select pg_temp.check((select count(*) from time_entries where admin_notes = 'seen') = 0, 'rolled back');

\echo '--- 24.5 no public policy checks the caller per row any more'
select pg_temp.check((select count(*) from pg_policies where schemaname = 'public'
  and coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'can_manage_(entity|employee)\(') = 0, 'no can_manage_* in a policy');
select pg_temp.check((select bool_and(
    regexp_count(coalesce(qual, '') || ' ' || coalesce(with_check, ''), '(is_company_admin|managed_entity_ids|managed_employee_ids|caller_is_admin)\(\)')
  = regexp_count(coalesce(qual, '') || ' ' || coalesce(with_check, ''), 'SELECT (is_company_admin|managed_entity_ids|managed_employee_ids|caller_is_admin)\(\)'))
  from pg_policies where schemaname = 'public'), 'the caller helpers are always wrapped in a select');

\echo 'PASSED 24'
