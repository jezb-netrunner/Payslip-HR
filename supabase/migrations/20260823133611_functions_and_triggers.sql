-- ============================================================
-- Helper functions, auth bootstrap, audit + immutability triggers
-- ============================================================

-- Role helpers (security definer so RLS policies can use them without recursion)
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'admin' and is_active
  )
$$;

create or replace function public.current_employee_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select employee_id from profiles
  where id = auth.uid() and is_active
$$;

-- Payroll-run helpers for recursion-free RLS between payslips and payroll_runs
create or replace function public.run_is_finalized(p_run uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from payroll_runs
    where id = p_run and status in ('finalized','paid')
  )
$$;

create or replace function public.run_has_own_payslip(p_run uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from payslips
    where payroll_run_id = p_run and employee_id = public.current_employee_id()
  )
$$;

-- ---------- auth bootstrap ----------
-- First account ever created becomes admin (single-entity bootstrap).
-- Accounts provisioned by the admin edge function carry role/employee_id in app_metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_role text;
  v_employee_id uuid;
begin
  v_role := new.raw_app_meta_data->>'role';
  begin
    v_employee_id := nullif(new.raw_app_meta_data->>'employee_id','')::uuid;
  exception when others then
    v_employee_id := null;
  end;

  if v_role is null or v_role not in ('admin','employee') then
    if exists (select 1 from profiles where role = 'admin') then
      v_role := 'employee';
    else
      v_role := 'admin';
    end if;
  end if;

  insert into profiles (id, role, employee_id, email, full_name)
  values (
    new.id,
    v_role,
    v_employee_id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name','')
  )
  on conflict (id) do nothing;
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- generic audit trigger ----------
create or replace function public.audit_trigger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_entity_id text;
begin
  if tg_op = 'DELETE' then
    v_entity_id := old.id::text;
  else
    v_entity_id := new.id::text;
  end if;

  insert into audit_logs (actor_id, action, entity, entity_id, old_data, new_data)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_entity_id,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end
$$;

create trigger audit_employees
  after insert or update or delete on public.employees
  for each row execute function public.audit_trigger();
create trigger audit_time_entries
  after update or delete on public.time_entries
  for each row execute function public.audit_trigger();
create trigger audit_company_settings
  after update on public.company_settings
  for each row execute function public.audit_trigger();
create trigger audit_payroll_runs
  after insert or update or delete on public.payroll_runs
  for each row execute function public.audit_trigger();
create trigger audit_statutory_versions
  after insert or update or delete on public.statutory_versions
  for each row execute function public.audit_trigger();

-- ---------- immutability guards ----------
-- Payslips belonging to a finalized/paid run cannot be changed;
-- the run must be explicitly reopened (an audited action) first.
create or replace function public.prevent_finalized_payslip_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_run uuid;
begin
  v_run := coalesce(new.payroll_run_id, old.payroll_run_id);
  if public.run_is_finalized(v_run) then
    raise exception 'Payslips of a finalized payroll run are immutable. Reopen the run first.';
  end if;
  return coalesce(new, old);
end
$$;

create trigger payslips_immutable
  before insert or update or delete on public.payslips
  for each row execute function public.prevent_finalized_payslip_change();

create or replace function public.protect_finalized_run()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' and old.status in ('finalized','paid') then
    raise exception 'Cannot delete a finalized payroll run. Reopen it to draft first.';
  end if;
  return coalesce(new, old);
end
$$;

create trigger payroll_runs_protect_delete
  before delete on public.payroll_runs
  for each row execute function public.protect_finalized_run();
