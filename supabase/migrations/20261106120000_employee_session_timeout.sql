-- Employee sessions end in the database too: 12 hours after sign-in, or after
-- 32 minutes without activity (the app warns at 25 and signs out at 30). Until
-- now only the app signed an idle employee out, so a token copied off a shared
-- phone or kiosk kept reading payslips until it expired, and a session the
-- employee signed out of elsewhere kept working at the database.
--
-- The rules, as for admins (20261104072713_cas_controls), minus the second
-- factor and the one-session limit: the session must still exist at Auth,
-- begun within 12 hours (Auth's own sessions.created_at, which no client can
-- move) and active within 32 minutes (the app's last report here, or the
-- sign-in itself until the first report). A request without a role claim is
-- no API token: a direct database session (SQL editor, migrations, tests).
--
-- Additive: a new table and functions, the two employee RLS helpers,
-- my_session_state and log_activity re-created.

create table public.employee_session_activity (
  session_id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  seen_at timestamptz not null default now()
);
create index employee_session_activity_user on public.employee_session_activity (user_id);
alter table public.employee_session_activity enable row level security;
revoke all on public.employee_session_activity from anon, authenticated;

-- The rules of an employee session, in one place.
create or replace function public.employee_session_ok(p_user uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when coalesce(auth.jwt()->>'role', '') = '' then true
    else exists (
      select 1
      from auth.sessions s
      left join employee_session_activity a on a.session_id = s.id and a.user_id = s.user_id
      where s.id = nullif(auth.jwt()->>'session_id', '')::uuid
        and s.user_id = p_user
        and s.created_at > now() - interval '12 hours'
        and coalesce(a.seen_at, s.created_at) > now() - interval '32 minutes')
  end
$$;
revoke execute on function public.employee_session_ok(uuid) from public, anon, authenticated;

-- every "read own" / "file own" policy goes through these two
create or replace function public.current_employee_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select employee_id from profiles
  where id = auth.uid() and is_active and role = 'employee'
    and (sessions_revoked_at is null
         or coalesce((auth.jwt()->>'iat')::bigint, 0) >= floor(extract(epoch from sessions_revoked_at)))
    and public.employee_session_ok(id)
$$;

create or replace function public.current_employee_entity_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select e.entity_id
  from profiles p join employees e on e.id = p.employee_id
  where p.id = auth.uid() and p.is_active and p.role = 'employee'
    and (p.sessions_revoked_at is null
         or coalesce((auth.jwt()->>'iat')::bigint, 0) >= floor(extract(epoch from p.sessions_revoked_at)))
    and public.employee_session_ok(p.id)
$$;

-- The state of the caller's session, for the app: the admin rules as before,
-- and now an employee's too (idle, expired, or active with the seconds since
-- its last activity and until it ends).
create or replace function public.my_session_state()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_p profiles;
  v_a admin_session_activity;
  v_sid uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  v_started timestamptz;
  v_seen timestamptz;
begin
  select * into v_p from profiles where id = auth.uid();
  if v_p.id is null or not v_p.is_active
     or not exists (select 1 from auth.sessions s where s.id = v_sid and s.user_id = auth.uid())
     or (v_p.sessions_revoked_at is not null
         and coalesce((auth.jwt()->>'iat')::bigint, 0) < floor(extract(epoch from v_p.sessions_revoked_at))) then
    return jsonb_build_object('state', 'ended');
  end if;
  if v_p.role = 'employee' then
    select s.created_at, coalesce(a.seen_at, s.created_at) into v_started, v_seen
    from auth.sessions s
    left join employee_session_activity a on a.session_id = s.id and a.user_id = s.user_id
    where s.id = v_sid and s.user_id = v_p.id;
    if v_started <= now() - interval '12 hours' then
      return jsonb_build_object('state', 'expired');
    end if;
    if v_seen <= now() - interval '32 minutes' then
      return jsonb_build_object('state', 'idle');
    end if;
    return jsonb_build_object(
      'state', 'active',
      'idle_seconds', floor(extract(epoch from now() - v_seen)),
      'ends_in_seconds', floor(extract(epoch from v_started + interval '12 hours' - now())));
  end if;
  -- the first sign-up of a deployment: no admin session rules
  if v_p.admin_session_id is null then
    return jsonb_build_object('state', 'active');
  end if;
  if v_p.admin_session_id is distinct from v_sid then
    return jsonb_build_object('state', 'ended');
  end if;
  select * into v_a from admin_session_activity where user_id = v_p.id and session_id = v_sid;
  if v_a.user_id is null or v_a.started_at <= now() - interval '12 hours' then
    return jsonb_build_object('state', 'expired');
  end if;
  if v_a.seen_at <= now() - interval '32 minutes' then
    return jsonb_build_object('state', 'idle');
  end if;
  return jsonb_build_object(
    'state', 'active',
    'idle_seconds', floor(extract(epoch from now() - v_a.seen_at)),
    'ends_in_seconds', floor(extract(epoch from v_a.started_at + interval '12 hours' - now())));
end
$$;
revoke execute on function public.my_session_state() from public, anon;
grant execute on function public.my_session_state() to authenticated;

-- The app reports activity in an employee's session (at most about once a
-- minute). Only a session still within its limits is extended. One the
-- database already ended (idle or past 12 hours) is deleted at Auth, so its
-- refresh token stops too. Old rows of the caller go. Answers the state.
create or replace function public.touch_employee_session()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_sid uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  v_state jsonb;
begin
  if v_sid is not null and public.current_employee_id() is not null then
    insert into employee_session_activity (session_id, user_id, seen_at)
    values (v_sid, auth.uid(), now())
    on conflict (session_id) do update set seen_at = now()
      where employee_session_activity.user_id = auth.uid();
    delete from employee_session_activity
     where user_id = auth.uid() and seen_at < now() - interval '13 hours';
  end if;
  v_state := public.my_session_state();
  if v_sid is not null and v_state->>'state' in ('idle', 'expired')
     and exists (select 1 from profiles where id = auth.uid() and role = 'employee') then
    delete from auth.sessions where id = v_sid and user_id = auth.uid();
    delete from employee_session_activity where session_id = v_sid and user_id = auth.uid();
  end if;
  return v_state;
end
$$;
revoke execute on function public.touch_employee_session() from public, anon;
grant execute on function public.touch_employee_session() to authenticated;

-- An employee's sign-out is filed under their client even when the database
-- already ended the session (the app reports it as it signs out). Otherwise
-- as in 20261104072713_cas_controls (the definition there, unchanged).
CREATE OR REPLACE FUNCTION public.log_activity(p_action text, p_entity uuid, p_detail jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if p_action not in ('sign_in', 'sign_out', 'report', 'print', 'export') then
    raise exception 'Unknown activity.';
  end if;
  if p_entity is not null and not (public.can_manage_entity(p_entity) or coalesce(public.current_employee_entity_id() = p_entity, false)) then
    raise exception 'Client not found.';
  end if;
  if jsonb_typeof(coalesce(p_detail, '{}'::jsonb)) <> 'object' or length(coalesce(p_detail, '{}'::jsonb)::text) > 2000 then
    raise exception 'The activity detail must be a short object.';
  end if;
  -- the app reports these: at most 120 in ten minutes per user
  if (select count(*) from audit_logs
       where actor_id = auth.uid() and table_name = 'activity' and created_at > now() - interval '10 minutes') >= 120 then
    raise exception 'Too many activity entries: try again in a few minutes.';
  end if;
  select coalesce(p.email, nullif(p.full_name, ''), nullif(btrim(e.first_name || ' ' || e.last_name), '')) into v_email
    from profiles p left join employees e on e.id = p.employee_id
    where p.id = auth.uid();
  insert into audit_logs (actor_id, actor_email, action, table_name, record_id, entity_id, new_data)
  -- an employee's sign-in and sign-out are filed under their own client.
  -- Reported by the app, and marked so: the keys only the sign-in guard
  -- writes (the caller's address and browser) can't be supplied here
  values (auth.uid(), v_email, p_action, 'activity', null,
          coalesce(p_entity, public.current_employee_entity_id(),
                   -- the sign-out of a session the database already ended
                   case when p_action = 'sign_out' then (
                     select e.entity_id from profiles p join employees e on e.id = p.employee_id
                     where p.id = auth.uid() and p.role = 'employee') end),
          (coalesce(p_detail, '{}'::jsonb) - 'ip' - 'user_agent' - 'via' - 'source') || jsonb_build_object('source', 'app'));
end
$function$;
revoke execute on function public.log_activity(text, uuid, jsonb) from public, anon;
grant execute on function public.log_activity(text, uuid, jsonb) to authenticated;
