-- Employee sign-in through the auth-guard edge function, and no table
-- privileges for the anonymous role.
--
-- Employees sign in with a login code. Supabase Auth needs an email, so each
-- code maps to an address. Until now the browser derived it with a public
-- recipe (an unsalted SHA-256 of the code), and the address is in every
-- access token and in the browser's stored session: a stale session on a
-- shared computer gave the code away to an offline search. From this release
-- the address and the password are HMACs under an edge-function secret
-- (ADMIN_PASSWORD_PEPPER), made only by auth-guard and admin-users, so the
-- address reveals nothing and the Auth API alone can't confirm a guess.
--
-- A code names no account, so a per-account lockout can't slow guessing:
-- each client's codes share one budget of failed sign-ins per window, kept
-- here (service role only) and checked before anything reaches the Auth
-- server, whose per-IP limit every request from the edge function shares.

create table public.employee_sign_in_failures (
  entity_id uuid primary key references public.entities(id) on delete cascade,
  window_start timestamptz not null default now(),
  failures int not null default 0 constraint employee_sign_in_failures_failures_check check (failures >= 0),
  updated_at timestamptz not null default now()
);
alter table public.employee_sign_in_failures enable row level security;
revoke all on public.employee_sign_in_failures from anon, authenticated;

-- One employee sign-in attempt, under the client's row lock (concurrent
-- guesses count one by one). p_email is the address the code maps to; it
-- names an account only when the whole code is right, so no password is
-- needed here. The p_max-th failure in a window refuses the client's
-- sign-ins until the window ends and goes on the audit trail once.
-- Answers result ok (with user_id), invalid, deactivated or throttled (with
-- retry_at).
create or replace function public.employee_sign_in_check(p_client text, p_email text, p_max int, p_window_minutes int, p_ip text, p_agent text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_entity uuid;
  v_row employee_sign_in_failures;
  v_user uuid;
  v_role text;
  v_employee_entity uuid;
  v_active boolean;
begin
  select id into v_entity from entities where code = upper(btrim(p_client));
  if v_entity is null then
    return jsonb_build_object('result', 'invalid');
  end if;
  insert into employee_sign_in_failures (entity_id) values (v_entity) on conflict (entity_id) do nothing;
  select * into v_row from employee_sign_in_failures where entity_id = v_entity for update;
  if v_row.window_start <= now() - make_interval(mins => p_window_minutes) then
    update employee_sign_in_failures set window_start = now(), failures = 0, updated_at = now()
     where entity_id = v_entity
    returning * into v_row;
  end if;
  if v_row.failures >= p_max then
    return jsonb_build_object('result', 'throttled', 'retry_at', v_row.window_start + make_interval(mins => p_window_minutes));
  end if;

  select u.id into v_user
    from auth.users u
   where lower(u.email) = lower(btrim(p_email)) and u.deleted_at is null
   order by u.created_at
   limit 1;
  if v_user is not null then
    select p.role, e.entity_id, p.is_active into v_role, v_employee_entity, v_active
      from profiles p left join employees e on e.id = p.employee_id
     where p.id = v_user;
  end if;
  -- only an employee login of this client counts as a right code
  if v_user is null or v_role is distinct from 'employee' or v_employee_entity is distinct from v_entity then
    update employee_sign_in_failures set failures = failures + 1, updated_at = now() where entity_id = v_entity;
    if v_row.failures + 1 = p_max then
      insert into audit_logs (actor_id, actor_email, action, table_name, record_id, entity_id, new_data)
      values (null, null, 'employee_sign_in_throttled', 'activity', null, v_entity,
              jsonb_build_object('failures', p_max, 'minutes', p_window_minutes, 'ip', p_ip, 'user_agent', p_agent, 'via', 'employee sign-in'));
    end if;
    return jsonb_build_object('result', 'invalid');
  end if;
  if not coalesce(v_active, false) then
    return jsonb_build_object('result', 'deactivated');
  end if;
  return jsonb_build_object('result', 'ok', 'user_id', v_user);
end
$$;
revoke execute on function public.employee_sign_in_check(text, text, int, int, text, text) from public, anon, authenticated;
grant execute on function public.employee_sign_in_check(text, text, int, int, text, text) to service_role;

-- ---------- no table privileges for the anonymous role ----------
-- Every table has RLS and no policy for anon, so no answer changes. Without
-- the privileges a policy written "to public" by mistake still can't reach a
-- signed-out caller, and the tables stay out of what the publishable key can
-- describe through the REST and GraphQL APIs. Tables, sequences and
-- functions made by later migrations start without them too.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;
