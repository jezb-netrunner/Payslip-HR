-- ============================================================
-- Multi-client restructure, part 2: access control and integrity.
--   * role helpers (security definer, used by RLS policies)
--   * triggers: client assignment, attendance locking, overlap checks,
--     admin-profile protection, audit with client scope
--   * RLS policies for the three tiers
--   * payroll RPCs: finalize/reopen also settle cash-rounding balances
-- ============================================================

-- ---------- role helpers ----------
create or replace function public.is_company_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'company_admin' and is_active
  )
$$;

-- Company admins manage every client; entity admins only their assigned,
-- active clients.
create or replace function public.can_manage_entity(p_entity uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_entity is not null and exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.is_active
      and (
        p.role = 'company_admin'
        or (p.role = 'entity_admin' and exists (
              select 1 from entity_admins ea
              join entities en on en.id = ea.entity_id
              where ea.profile_id = p.id and ea.entity_id = p_entity and en.is_active))
      )
  )
$$;

create or replace function public.can_manage_employee(p_employee uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.can_manage_entity((select entity_id from employees where id = p_employee))
$$;

-- An employee's access token stops working the moment their login code is
-- replaced (sessions_revoked_at), not when it expires an hour later.
create or replace function public.current_employee_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select employee_id from profiles
  where id = auth.uid() and is_active and role = 'employee'
    and (sessions_revoked_at is null
         or coalesce((auth.jwt()->>'iat')::bigint, 0) >= floor(extract(epoch from sessions_revoked_at)))
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
$$;

-- Attendance inside a finalized regular/special/final-pay run's period has
-- been paid and must not change underneath the payslip.
create or replace function public.attendance_locked(p_employee uuid, p_date date)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from payslips p join payroll_runs r on r.id = p.payroll_run_id
    where p.employee_id = p_employee
      and r.status in ('finalized','paid')
      and r.run_type in ('regular','special','final_pay')
      and p_date between r.period_start and r.period_end
  )
$$;

-- ---------- auth bootstrap ----------
-- The first account ever created becomes a company admin; accounts made by
-- the admin-users edge function carry their role in app_metadata (which
-- users cannot set themselves). Anyone else gets an unlinked employee
-- profile with no access.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_role text;
  v_employee_id uuid;
begin
  v_role := new.raw_app_meta_data->>'role';
  if v_role is null or v_role not in ('company_admin','entity_admin','employee') then
    if exists (select 1 from profiles where role = 'company_admin') then
      v_role := 'employee';
    else
      v_role := 'company_admin';
    end if;
  end if;
  if v_role = 'employee' then
    begin
      v_employee_id := nullif(new.raw_app_meta_data->>'employee_id','')::uuid;
    exception when others then
      v_employee_id := null;
    end;
  end if;

  -- An employee's auth email is derived from their login code; keeping it
  -- where admins can read it would let them recover the code offline.
  insert into profiles (id, role, employee_id, email, full_name)
  values (
    new.id, v_role, v_employee_id,
    case when v_role = 'employee' then null else new.email end,
    coalesce(new.raw_user_meta_data->>'full_name','')
  )
  on conflict (id) do nothing;
  return new;
end
$$;

-- ---------- admin profile protection ----------
create or replace function public.protect_admin_profiles()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_others int;
begin
  if tg_op = 'DELETE' then
    if old.role = 'company_admin' then
      raise exception 'Company admin profiles cannot be deleted. Demote the account first.';
    end if;
    return old;
  end if;

  if new.id is distinct from old.id then
    raise exception 'A profile''s account id cannot change.';
  end if;

  -- Nobody (including the service role) may change ANOTHER company admin's
  -- role or active flag: closes the demote-then-hijack route.
  if old.role = 'company_admin' and old.id is distinct from auth.uid()
     and (new.role is distinct from old.role or new.is_active is distinct from old.is_active) then
    raise exception 'Another company admin''s role or active status cannot be changed.';
  end if;

  -- Never remove the last active company admin (self-demotion included).
  if old.role = 'company_admin' and (new.role <> 'company_admin' or not new.is_active) then
    select count(*) into v_others
      from profiles
      where role = 'company_admin' and is_active and id <> old.id;
    if v_others = 0 then
      raise exception 'Cannot remove the last active company admin.';
    end if;
  end if;

  return new;
end
$$;
create trigger profiles_protect_admins
  before update or delete on public.profiles
  for each row execute function public.protect_admin_profiles();

-- ---------- generic audit trigger (records client scope + actor) ----------
create or replace function public.audit_trigger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_row jsonb;
  v_entity uuid;
  v_email text;
begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  if tg_table_name = 'entities' then
    v_entity := (v_row->>'id')::uuid;
  elsif v_row ? 'entity_id' then
    v_entity := nullif(v_row->>'entity_id','')::uuid;
  elsif nullif(v_row->>'employee_id','') is not null then
    -- employee-owned rows without a client column of their own
    -- (allowances, recurring deductions, employee login profiles)
    select entity_id into v_entity from employees where id = (v_row->>'employee_id')::uuid;
  end if;
  -- employee logins have no email on their profile: name them instead
  select coalesce(email, nullif(full_name, '')) into v_email from profiles where id = auth.uid();

  insert into audit_logs (actor_id, actor_email, action, table_name, record_id, entity_id, old_data, new_data)
  values (
    auth.uid(),
    v_email,
    lower(tg_op),
    tg_table_name,
    coalesce(v_row->>'id', v_row->>'profile_id'),
    v_entity,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end
$$;

create trigger audit_entities
  after insert or update or delete on public.entities
  for each row execute function public.audit_trigger();
create trigger audit_entity_admins
  after insert or delete on public.entity_admins
  for each row execute function public.audit_trigger();
create trigger audit_profiles
  after update or delete on public.profiles
  for each row execute function public.audit_trigger();
create trigger audit_employee_allowances
  after insert or update or delete on public.employee_allowances
  for each row execute function public.audit_trigger();
create trigger audit_recurring_deductions
  after insert or update or delete on public.recurring_deductions
  for each row execute function public.audit_trigger();
create trigger audit_holidays
  after insert or update or delete on public.holidays
  for each row execute function public.audit_trigger();
create trigger audit_tax_remittances
  after insert or update or delete on public.tax_remittances
  for each row execute function public.audit_trigger();
create trigger audit_payroll_adjustments
  after insert or update or delete on public.payroll_adjustments
  for each row execute function public.audit_trigger();

-- ---------- client assignment + integrity triggers ----------
-- Child rows always take their client from the employee (never from the
-- caller), so a row can't be planted in another client.
create or replace function public.assign_entity_from_employee()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  return new;
end
$$;
create trigger employee_tax_years_entity before insert or update on public.employee_tax_years
  for each row execute function public.assign_entity_from_employee();

create or replace function public.guard_employee_entity()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.entity_id is distinct from old.entity_id then
    raise exception 'An employee cannot move to another client. Record the separation and create a new employee record under the new employer.';
  end if;
  return new;
end
$$;
create trigger employees_entity_immutable before update on public.employees
  for each row execute function public.guard_employee_entity();

-- SECURITY INVOKER on purpose: current_user is the API role for direct
-- writes but the definer (postgres) inside finalize/reopen, which are the
-- only paths allowed to move the cash-rounding balance and payroll_seq.
create or replace function public.guard_employee_rounding_balance()
returns trigger
language plpgsql set search_path = public
as $$
begin
  if current_user in ('authenticated','anon') then
    if tg_op = 'INSERT' then
      if new.rounding_balance <> 0 or new.payroll_seq <> 0 then
        raise exception 'The cash-rounding balance is maintained by payroll finalization only.';
      end if;
    elsif new.rounding_balance is distinct from old.rounding_balance
          or new.payroll_seq is distinct from old.payroll_seq then
      raise exception 'The cash-rounding balance is maintained by payroll finalization only.';
    end if;
  end if;
  return new;
end
$$;
create trigger employees_rounding_balance_guard before insert or update on public.employees
  for each row execute function public.guard_employee_rounding_balance();

create or replace function public.guard_entity_update()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.code is distinct from old.code then
    raise exception 'The client code is the prefix of every employee login code and cannot be changed.';
  end if;
  if new.is_active is distinct from old.is_active and not public.is_company_admin() then
    raise exception 'Only company admins can archive or reactivate a client.';
  end if;
  return new;
end
$$;
create trigger entities_guard before update on public.entities
  for each row execute function public.guard_entity_update();

-- New clients start with the statutory leave types (global template rows).
create or replace function public.seed_entity_defaults()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into leave_types (entity_id, code, name, default_annual_days, paid, active)
  select new.id, code, name, default_annual_days, paid, active
  from leave_types where entity_id is null;
  return new;
end
$$;
create trigger entities_seed_defaults after insert on public.entities
  for each row execute function public.seed_entity_defaults();

-- Admin-entered time entries: client from the employee, sane times, no
-- overlaps (double entry would double-pay hours), locked once paid.
create or replace function public.guard_time_entry()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op in ('UPDATE','DELETE') and public.attendance_locked(old.employee_id, old.work_date)
     and (tg_op = 'DELETE'
          or new.employee_id is distinct from old.employee_id
          or new.work_date is distinct from old.work_date
          or new.clock_in is distinct from old.clock_in
          or new.clock_out is distinct from old.clock_out) then
    raise exception 'Attendance on % was paid in a finalized payroll run and is locked. Reopen that run to change it.', old.work_date;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;

  if public.attendance_locked(new.employee_id, new.work_date)
     and (tg_op = 'INSERT'
          or new.employee_id is distinct from old.employee_id
          or new.work_date is distinct from old.work_date
          or new.clock_in is distinct from old.clock_in
          or new.clock_out is distinct from old.clock_out) then
    raise exception 'Attendance on % was paid in a finalized payroll run and is locked. Reopen that run to change it.', new.work_date;
  end if;

  -- an overnight shift may start after midnight (late arrival) but still
  -- belongs to the work date it was scheduled on
  if (new.clock_in at time zone 'Asia/Manila')::date not between new.work_date and new.work_date + 1 then
    raise exception 'Time in must fall on the work date (or just after midnight for an overnight shift).';
  end if;

  -- serialize writes per employee so two concurrent saves can't both pass
  -- the overlap check
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' || new.employee_id::text, 0));
  if exists (
    select 1 from time_entries t
    where t.employee_id = new.employee_id and t.id <> new.id
      and tstzrange(t.clock_in, coalesce(t.clock_out, t.clock_in + interval '1 minute'))
          && tstzrange(new.clock_in, coalesce(new.clock_out, new.clock_in + interval '1 minute'))
  ) then
    raise exception 'This entry overlaps another time entry of the same employee.';
  end if;

  new.status := case when new.clock_out is null then 'open' else 'closed' end;
  return new;
end
$$;
create trigger time_entries_guard before insert or update or delete on public.time_entries
  for each row execute function public.guard_time_entry();

-- Employees may only cancel their own pending request; anything else they
-- send would change what the admin reviews (and approval applies).
create or replace function public.guard_own_request_update()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and not public.can_manage_entity(old.entity_id)
     and (old.status <> 'pending' or new.status <> 'cancelled'
          or (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at')) then
    raise exception 'You can only cancel a pending request.';
  end if;
  return new;
end
$$;
create trigger tcr_own_update before update on public.time_correction_requests
  for each row execute function public.guard_own_request_update();
create trigger leave_requests_own_update before update on public.leave_requests
  for each row execute function public.guard_own_request_update();

create or replace function public.guard_correction_request()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  if new.time_entry_id is not null and not exists (
    select 1 from time_entries where id = new.time_entry_id and employee_id = new.employee_id
  ) then
    raise exception 'The referenced time entry does not belong to this employee.';
  end if;
  return new;
end
$$;
create trigger tcr_guard before insert or update on public.time_correction_requests
  for each row execute function public.guard_correction_request();

create or replace function public.guard_leave_request()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  if not exists (select 1 from leave_types where id = new.leave_type_id and entity_id = new.entity_id) then
    raise exception 'Leave type does not belong to this employee''s company.';
  end if;
  -- An approved leave changes pay for its dates: it can't be approved,
  -- moved or withdrawn on days a finalized payroll already paid.
  if (new.status = 'approved' or (tg_op = 'UPDATE' and old.status = 'approved'))
     and (tg_op = 'INSERT' or new.status is distinct from old.status
          or new.start_date is distinct from old.start_date or new.end_date is distinct from old.end_date
          or new.leave_type_id is distinct from old.leave_type_id) then
    if exists (
      select 1 from generate_series(least(new.start_date, coalesce(old.start_date, new.start_date)),
                                    greatest(new.end_date, coalesce(old.end_date, new.end_date)),
                                    interval '1 day') d
      where public.attendance_locked(new.employee_id, d::date)
    ) then
      raise exception 'Part of this leave falls in a finalized payroll run. Reopen that run first, or settle the leave as an adjustment in the next payroll.';
    end if;
  end if;
  return new;
end
$$;
create trigger leave_requests_guard before insert or update on public.leave_requests
  for each row execute function public.guard_leave_request();

create or replace function public.guard_leave_entitlement()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from leave_types lt join employees e on e.entity_id = lt.entity_id
    where lt.id = new.leave_type_id and e.id = new.employee_id
  ) then
    raise exception 'Leave type does not belong to this employee''s company.';
  end if;
  return new;
end
$$;
create trigger leave_entitlements_guard before insert or update on public.employee_leave_entitlements
  for each row execute function public.guard_leave_entitlement();

-- Payslips copy their run's client and period facts (authoritative), and
-- an employee from another client can never be put on a run.
create or replace function public.fill_payslip_from_run()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_run payroll_runs;
begin
  if tg_op = 'UPDATE' and (new.payroll_run_id is distinct from old.payroll_run_id
                           or new.employee_id is distinct from old.employee_id) then
    raise exception 'A payslip cannot move to another run or employee.';
  end if;
  select * into v_run from payroll_runs where id = new.payroll_run_id;
  if v_run.id is null then
    raise exception 'Payroll run not found.';
  end if;
  if not exists (select 1 from employees where id = new.employee_id and entity_id = v_run.entity_id) then
    raise exception 'Employee does not belong to this payroll run''s client.';
  end if;
  new.entity_id := v_run.entity_id;
  new.period_start := v_run.period_start;
  new.period_end := v_run.period_end;
  new.pay_date := v_run.pay_date;
  new.run_type := v_run.run_type;
  new.period_month := v_run.period_month;
  new.pay_frequency := v_run.pay_frequency;
  return new;
end
$$;
create trigger payslips_fill_from_run before insert or update on public.payslips
  for each row execute function public.fill_payslip_from_run();

create or replace function public.guard_payroll_adjustment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_run payroll_runs;
begin
  if tg_op = 'UPDATE' and (new.payroll_run_id is distinct from old.payroll_run_id
                           or new.employee_id is distinct from old.employee_id) then
    raise exception 'An adjustment cannot move to another run or employee.';
  end if;
  select * into v_run from payroll_runs
    where id = case when tg_op = 'DELETE' then old.payroll_run_id else new.payroll_run_id end;
  -- (a run being deleted is already gone: its cascade passes through)
  if v_run.id is not null and v_run.status <> 'draft' then
    raise exception 'Adjustments of a finalized payroll run are locked. Reopen the run first.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if v_run.id is null then
    raise exception 'Payroll run not found.';
  end if;
  if not exists (select 1 from employees where id = new.employee_id and entity_id = v_run.entity_id) then
    raise exception 'Employee does not belong to this payroll run''s client.';
  end if;
  new.entity_id := v_run.entity_id;
  return new;
end
$$;
create trigger payroll_adjustments_guard before insert or update or delete on public.payroll_adjustments
  for each row execute function public.guard_payroll_adjustment();

create or replace function public.guard_statutory_delete()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from statutory_versions where kind = old.kind and id <> old.id) then
    raise exception 'Cannot delete the only % table version. Add its replacement first.', old.kind;
  end if;
  return old;
end
$$;
create trigger statutory_versions_guard_delete before delete on public.statutory_versions
  for each row execute function public.guard_statutory_delete();

-- ---------- payroll run integrity ----------
-- A run's client never changes; its status moves only through the
-- finalize/reopen RPCs (they set payroll.lifecycle for their transaction);
-- a finalized run is frozen except for its notes. Changing a draft's
-- period facts discards its computation.
create or replace function public.guard_payroll_run_update()
returns trigger
language plpgsql set search_path = public
as $$
declare
  v_lifecycle boolean := coalesce(current_setting('payroll.lifecycle', true), '') = 'on';
begin
  if new.entity_id is distinct from old.entity_id then
    raise exception 'A payroll run cannot move to another client.';
  end if;
  if new.status is distinct from old.status and not v_lifecycle then
    raise exception 'Use Finalize or Reopen to change a payroll run''s status.';
  end if;
  if old.status <> 'draft' and not v_lifecycle
     and (to_jsonb(new) - 'notes' - 'updated_at') is distinct from (to_jsonb(old) - 'notes' - 'updated_at') then
    raise exception 'This payroll run is finalized — reopen it to make changes.';
  end if;
  if old.status = 'draft' and new.status = 'draft'
     and (new.run_type, new.period_start, new.period_end, new.pay_date, new.pay_frequency, new.period_month,
          new.period_index, new.periods_in_month, new.annualize, new.employee_ids)
         is distinct from
         (old.run_type, old.period_start, old.period_end, old.pay_date, old.pay_frequency, old.period_month,
          old.period_index, old.periods_in_month, old.annualize, old.employee_ids) then
    new.totals := '{}'::jsonb;
  end if;
  return new;
end
$$;
create trigger payroll_runs_guard before update on public.payroll_runs
  for each row execute function public.guard_payroll_run_update();

-- ---------- draft staleness ----------
-- A computed draft carries its payslip count in totals.employees. Any later
-- change to what it was computed from resets totals to '{}' and finalize
-- refuses it until it is recomputed. (computeRun writes a one-time
-- "computing" token first and only completes if the token survived.)
create or replace function public.mark_payroll_drafts_stale(
  p_entity uuid, p_employee uuid, p_from date, p_to date)
returns void
language sql security definer set search_path = public
as $$
  update payroll_runs r
     set totals = '{}'::jsonb
   where r.status = 'draft' and r.totals <> '{}'::jsonb
     and (p_entity is null or r.entity_id = p_entity)
     and (p_from is null or (r.run_type <> 'thirteenth_month' and r.period_end >= p_from))
     and (p_to is null or r.period_start <= p_to)
     and (p_employee is null
          or exists (select 1 from payslips p where p.payroll_run_id = r.id and p.employee_id = p_employee))
$$;

create or replace function public.stale_drafts_on_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_rows jsonb[] := array_remove(array[
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end], null);
  v_ignore text[] := array['updated_at','rounding_balance','payroll_seq','login_code_hint','login_code_set_at'];
  r jsonb;
  v_entity uuid;
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) - v_ignore) = (to_jsonb(old) - v_ignore) then
    return new;
  end if;
  foreach r in array v_rows loop
    case tg_table_name
      when 'payroll_adjustments' then
        update payroll_runs set totals = '{}'::jsonb
          where id = (r->>'payroll_run_id')::uuid and status = 'draft' and totals <> '{}'::jsonb;
      when 'time_entries' then
        perform mark_payroll_drafts_stale((r->>'entity_id')::uuid, (r->>'employee_id')::uuid,
                                          (r->>'work_date')::date, (r->>'work_date')::date);
      when 'leave_requests' then
        if r->>'status' = 'approved' then
          perform mark_payroll_drafts_stale((r->>'entity_id')::uuid, (r->>'employee_id')::uuid,
                                            (r->>'start_date')::date, (r->>'end_date')::date);
        end if;
      when 'holidays' then
        perform mark_payroll_drafts_stale(nullif(r->>'entity_id','')::uuid, null,
                                          (r->>'holiday_date')::date, (r->>'holiday_date')::date);
      when 'entities' then
        perform mark_payroll_drafts_stale((r->>'id')::uuid, null, null, null);
      when 'employees' then
        -- who is eligible can change too: every draft of the client
        perform mark_payroll_drafts_stale((r->>'entity_id')::uuid, null, null, null);
      else -- employee_allowances, recurring_deductions
        select entity_id into v_entity from employees where id = (r->>'employee_id')::uuid;
        perform mark_payroll_drafts_stale(v_entity, (r->>'employee_id')::uuid, null, null);
    end case;
  end loop;
  return coalesce(new, old);
end
$$;
create trigger payroll_adjustments_stale after insert or update or delete on public.payroll_adjustments
  for each row execute function public.stale_drafts_on_change();
create trigger time_entries_stale after insert or update or delete on public.time_entries
  for each row execute function public.stale_drafts_on_change();
create trigger leave_requests_stale after insert or update or delete on public.leave_requests
  for each row execute function public.stale_drafts_on_change();
create trigger holidays_stale after insert or update or delete on public.holidays
  for each row execute function public.stale_drafts_on_change();
create trigger entities_stale after update on public.entities
  for each row execute function public.stale_drafts_on_change();
create trigger employees_stale after insert or update on public.employees
  for each row execute function public.stale_drafts_on_change();
create trigger employee_allowances_stale after insert or update or delete on public.employee_allowances
  for each row execute function public.stale_drafts_on_change();
create trigger recurring_deductions_stale after insert or update or delete on public.recurring_deductions
  for each row execute function public.stale_drafts_on_change();

-- Loan balances move with finalize/reopen. The deduction id comes from
-- payslip JSON, so the update is pinned to that payslip's own employee.
create or replace function public.adjust_run_deduction_balances(p_run uuid, p_direction int)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  r record;
begin
  for r in
    select (line->>'meta')::uuid as ded_id,
           p.employee_id,
           sum((line->>'amount')::numeric) as amt
    from payslips p,
         jsonb_array_elements(p.deductions) as line
    where p.payroll_run_id = p_run
      and line->>'code' like 'other:%'
      and line->>'meta' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    group by 1, 2
  loop
    update recurring_deductions
      set balance = balance + p_direction * r.amt,
          active = case
            -- finalize: auto-deactivate a loan that just reached zero
            when p_direction < 0 then active and (balance + p_direction * r.amt) > 0
            -- reopen: only re-activate what auto-deactivated at zero;
            -- never un-pause a manually paused deduction
            else active or (balance <= 0 and balance + p_direction * r.amt > 0)
          end
      where id = r.ded_id and employee_id = r.employee_id and balance is not null;
  end loop;
end
$$;

-- ---------- payroll lifecycle RPCs ----------
-- Finalize: status flip, loan balance decrements and the cash-rounding
-- carry-forward chain settle in ONE transaction, on a complete, current
-- draft only: every payslip must come from the computation the totals
-- describe, from each employee's current payroll state (payroll_seq moves
-- with every finalize/reopen touching them: year-to-date, 13th-month and
-- carry inputs), and no employee may be paid twice for the same days.
create or replace function public.finalize_payroll_run(p_run uuid)
returns public.payroll_runs
language plpgsql security definer set search_path = public
as $$
declare
  v_run payroll_runs;
  v_names text;
  v_count int;
begin
  select * into v_run from payroll_runs where id = p_run for update;
  if v_run.id is null or not can_manage_entity(v_run.entity_id) then
    raise exception 'Payroll run not found.';
  end if;
  if v_run.status <> 'draft' then
    raise exception 'This run is not a draft — it may already be finalized.';
  end if;
  -- lock the run's employees: a concurrent finalize/reopen touching them
  -- waits instead of racing on their balances
  perform 1 from employees e
    where e.id in (select employee_id from payslips where payroll_run_id = p_run)
    order by e.id
    for update;

  select count(*) into v_count from payslips where payroll_run_id = p_run;
  if not (v_run.totals ? 'employees') or (v_run.totals->>'employees')::int <> v_count then
    raise exception 'This draft is out of date or its computation did not finish. Recompute the draft, then finalize.';
  end if;
  if v_count = 0 then
    raise exception 'Nothing to finalize: the draft has no payslips.';
  end if;

  select string_agg(e.first_name || ' ' || e.last_name, ', ') into v_names
    from payslips p join employees e on e.id = p.employee_id
    where p.payroll_run_id = p_run
      and (e.rounding_balance <> p.rounding_carry_in
           or e.payroll_seq is distinct from p.employee_payroll_seq);
  if v_names is not null then
    raise exception 'Another payroll for % was finalized or reopened after this draft was computed. Recompute the draft, then finalize.', v_names;
  end if;

  if v_run.run_type <> 'thirteenth_month' then
    select string_agg(distinct e.first_name || ' ' || e.last_name, ', ') into v_names
      from payslips p
      join employees e on e.id = p.employee_id
      join payslips q on q.employee_id = p.employee_id and q.payroll_run_id <> p_run
      join payroll_runs r on r.id = q.payroll_run_id
      where p.payroll_run_id = p_run
        and r.status in ('finalized','paid') and r.run_type <> 'thirteenth_month'
        and r.period_start <= v_run.period_end and r.period_end >= v_run.period_start;
    if v_names is not null then
      raise exception 'Already paid for an overlapping period in another finalized run: %. Recompute the draft (they are left out), then finalize.', v_names;
    end if;
  end if;

  perform set_config('payroll.lifecycle', 'on', true);
  update payroll_runs
    set status = 'finalized', finalized_at = now(), finalized_by = auth.uid()
    where id = p_run
    returning * into v_run;
  update employees e
    set rounding_balance = p.rounding_carry_out,
        payroll_seq = e.payroll_seq + 1
    from payslips p
    where p.payroll_run_id = p_run and p.employee_id = e.id;
  perform adjust_run_deduction_balances(p_run, -1);
  perform set_config('payroll.lifecycle', '', true);
  return v_run;
end
$$;

-- Reopen: reverses the loan decrements and the rounding carry — but only
-- if no later finalized payroll has already consumed this run's carry.
create or replace function public.reopen_payroll_run(p_run uuid)
returns public.payroll_runs
language plpgsql security definer set search_path = public
as $$
declare
  v_run payroll_runs;
  v_used text;
begin
  select * into v_run from payroll_runs where id = p_run for update;
  if v_run.id is null or not can_manage_entity(v_run.entity_id) then
    raise exception 'Payroll run not found.';
  end if;
  if v_run.status not in ('finalized','paid') then
    raise exception 'This run is not finalized — nothing to reopen.';
  end if;
  perform 1 from employees e
    where e.id in (select employee_id from payslips where payroll_run_id = p_run)
    order by e.id
    for update;

  select string_agg(e.first_name || ' ' || e.last_name, ', ') into v_used
    from payslips p join employees e on e.id = p.employee_id
    where p.payroll_run_id = p_run and e.rounding_balance <> p.rounding_carry_out;
  if v_used is not null then
    raise exception 'A later finalized payroll already carried forward this run''s rounding for: %. Reopen that later run first.', v_used;
  end if;

  perform set_config('payroll.lifecycle', 'on', true);
  update payroll_runs
    set status = 'draft', finalized_at = null, finalized_by = null
    where id = p_run
    returning * into v_run;
  update employees e
    set rounding_balance = p.rounding_carry_in,
        payroll_seq = e.payroll_seq + 1
    from payslips p
    where p.payroll_run_id = p_run and p.employee_id = e.id;
  perform adjust_run_deduction_balances(p_run, 1);
  perform set_config('payroll.lifecycle', '', true);
  return v_run;
end
$$;

-- Approve/reject an employee's correction request; approval applies it.
create or replace function public.review_time_correction(
  p_request_id uuid,
  p_approve boolean,
  p_notes text default null
)
returns public.time_correction_requests
language plpgsql security definer set search_path = public
as $$
declare
  v_req time_correction_requests;
  v_updated int;
begin
  select * into v_req from time_correction_requests where id = p_request_id for update;
  if v_req.id is null or not can_manage_entity(v_req.entity_id) then
    raise exception 'Correction request not found.';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request has already been reviewed.';
  end if;

  if p_approve then
    if v_req.time_entry_id is not null then
      update time_entries set
        clock_in = coalesce(v_req.requested_clock_in, clock_in),
        clock_out = coalesce(v_req.requested_clock_out, clock_out),
        manually_edited = true,
        flags = (
          select coalesce(array_agg(distinct f), '{}')
          from unnest(time_entries.flags || array['corrected']) as f
        )
      where id = v_req.time_entry_id
        and employee_id = v_req.employee_id;
      get diagnostics v_updated = row_count;
      if v_updated = 0 then
        raise exception 'The referenced time entry does not belong to the requesting employee.';
      end if;
    else
      if v_req.requested_clock_in is null or v_req.requested_clock_out is null then
        raise exception 'A new-entry correction needs both time in and time out.';
      end if;
      insert into time_entries (
        employee_id, work_date, clock_in, clock_out,
        source, flags, manually_edited, admin_notes
      ) values (
        v_req.employee_id,
        v_req.work_date,
        v_req.requested_clock_in,
        v_req.requested_clock_out,
        'correction', array['corrected'], true,
        'Created from approved correction request'
      );
    end if;
  end if;

  update time_correction_requests set
    status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    review_notes = p_notes
  where id = p_request_id
  returning * into v_req;

  return v_req;
end
$$;

-- Service-role only: sign an employee out everywhere after their login
-- code changes — refresh tokens are deleted, and access tokens issued
-- before now stop passing current_employee_id().
create or replace function public.revoke_user_sessions(p_user uuid)
returns void
language sql security definer set search_path = public
as $$
  update profiles set sessions_revoked_at = now() where id = p_user;
  delete from auth.sessions where user_id = p_user;
$$;

-- ---------- Row Level Security ----------
alter table public.entities enable row level security;
alter table public.entity_admins enable row level security;
alter table public.announcements enable row level security;
alter table public.tax_remittances enable row level security;
alter table public.employee_tax_years enable row level security;
alter table public.payroll_adjustments enable row level security;

-- clients
create policy "entities: read managed or own employer" on public.entities
  for select to authenticated
  using (public.can_manage_entity(id) or id = public.current_employee_entity_id());
create policy "entities: company admin insert" on public.entities
  for insert to authenticated with check (public.is_company_admin());
create policy "entities: admins update" on public.entities
  for update to authenticated
  using (public.can_manage_entity(id)) with check (public.can_manage_entity(id));
create policy "entities: company admin delete" on public.entities
  for delete to authenticated using (public.is_company_admin());

create policy "entity_admins: read own or company admin" on public.entity_admins
  for select to authenticated
  using (public.is_company_admin() or profile_id = (select auth.uid()));
create policy "entity_admins: company admin write" on public.entity_admins
  for all to authenticated
  using (public.is_company_admin()) with check (public.is_company_admin());

-- profiles (writes beyond these go through the admin-users edge function)
create policy "profiles: read" on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or public.is_company_admin()
    or (employee_id is not null and public.can_manage_employee(employee_id))
  );
create policy "profiles: company admin update" on public.profiles
  for update to authenticated
  using (public.is_company_admin()) with check (public.is_company_admin());
create policy "profiles: company admin delete" on public.profiles
  for delete to authenticated using (public.is_company_admin());

-- employees
create policy "employees: admins manage" on public.employees
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "employees: read own" on public.employees
  for select to authenticated using (id = public.current_employee_id());

-- per-employee records
create policy "career_events: admins manage" on public.career_events
  for all to authenticated
  using (public.can_manage_employee(employee_id)) with check (public.can_manage_employee(employee_id));
create policy "career_events: read own" on public.career_events
  for select to authenticated using (employee_id = public.current_employee_id());

create policy "allowances: admins manage" on public.employee_allowances
  for all to authenticated
  using (public.can_manage_employee(employee_id)) with check (public.can_manage_employee(employee_id));
create policy "allowances: read own" on public.employee_allowances
  for select to authenticated using (employee_id = public.current_employee_id());

create policy "recurring_deductions: admins manage" on public.recurring_deductions
  for all to authenticated
  using (public.can_manage_employee(employee_id)) with check (public.can_manage_employee(employee_id));
create policy "recurring_deductions: read own" on public.recurring_deductions
  for select to authenticated using (employee_id = public.current_employee_id());

create policy "leave_entitlements: admins manage" on public.employee_leave_entitlements
  for all to authenticated
  using (public.can_manage_employee(employee_id)) with check (public.can_manage_employee(employee_id));
create policy "leave_entitlements: read own" on public.employee_leave_entitlements
  for select to authenticated using (employee_id = public.current_employee_id());

create policy "employee_tax_years: admins manage" on public.employee_tax_years
  for all to authenticated
  using (public.can_manage_employee(employee_id)) with check (public.can_manage_employee(employee_id));

-- time & attendance: admins enter; employees read own (no writes)
create policy "time_entries: admins manage" on public.time_entries
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "time_entries: read own" on public.time_entries
  for select to authenticated using (employee_id = public.current_employee_id());

create policy "tcr: admins manage" on public.time_correction_requests
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "tcr: read own" on public.time_correction_requests
  for select to authenticated using (employee_id = public.current_employee_id());
create policy "tcr: file own" on public.time_correction_requests
  for insert to authenticated
  with check (employee_id = public.current_employee_id() and status = 'pending');
create policy "tcr: cancel own pending" on public.time_correction_requests
  for update to authenticated
  using (employee_id = public.current_employee_id() and status = 'pending')
  with check (employee_id = public.current_employee_id() and status in ('pending','cancelled'));

-- leaves
create policy "leave_types: read" on public.leave_types
  for select to authenticated
  using (
    (entity_id is null and public.is_company_admin())   -- templates for new clients
    or public.can_manage_entity(entity_id)
    or entity_id = public.current_employee_entity_id()
  );
create policy "leave_types: manage" on public.leave_types
  for all to authenticated
  using ((entity_id is null and public.is_company_admin())
         or (entity_id is not null and public.can_manage_entity(entity_id)))
  with check ((entity_id is null and public.is_company_admin())
         or (entity_id is not null and public.can_manage_entity(entity_id)));

create policy "leave_requests: admins manage" on public.leave_requests
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "leave_requests: read own" on public.leave_requests
  for select to authenticated using (employee_id = public.current_employee_id());
create policy "leave_requests: file own" on public.leave_requests
  for insert to authenticated
  with check (employee_id = public.current_employee_id() and status = 'pending');
create policy "leave_requests: cancel own pending" on public.leave_requests
  for update to authenticated
  using (employee_id = public.current_employee_id() and status = 'pending')
  with check (employee_id = public.current_employee_id() and status in ('pending','cancelled'));

-- statutory tables: everyone reads, only company admins change
create policy "statutory: read all" on public.statutory_versions
  for select to authenticated using (true);
create policy "statutory: company admin insert" on public.statutory_versions
  for insert to authenticated with check (public.is_company_admin());
create policy "statutory: company admin update" on public.statutory_versions
  for update to authenticated
  using (public.is_company_admin()) with check (public.is_company_admin());
create policy "statutory: company admin delete" on public.statutory_versions
  for delete to authenticated using (public.is_company_admin());

-- holidays: national rows by company admins, local rows by the client's admins
create policy "holidays: read" on public.holidays
  for select to authenticated
  using (
    entity_id is null
    or public.can_manage_entity(entity_id)
    or entity_id = public.current_employee_entity_id()
  );
create policy "holidays: manage" on public.holidays
  for all to authenticated
  using ((entity_id is null and public.is_company_admin())
         or (entity_id is not null and public.can_manage_entity(entity_id)))
  with check ((entity_id is null and public.is_company_admin())
         or (entity_id is not null and public.can_manage_entity(entity_id)));

-- payroll
create policy "payroll_runs: admins manage" on public.payroll_runs
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));

create policy "payslips: admins manage" on public.payslips
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "payslips: employee reads own finalized" on public.payslips
  for select to authenticated
  using (employee_id = public.current_employee_id() and public.run_is_finalized(payroll_run_id));

create policy "payroll_adjustments: admins manage" on public.payroll_adjustments
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));

create policy "tax_remittances: admins manage" on public.tax_remittances
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));

-- announcements
create policy "announcements: admins manage" on public.announcements
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "announcements: employees read published" on public.announcements
  for select to authenticated
  using (
    entity_id = public.current_employee_entity_id()
    and published_at <= now()
    and (expires_at is null or expires_at > now())
  );

-- audit log (inserts only via the security-definer trigger)
create policy "audit_logs: read" on public.audit_logs
  for select to authenticated
  using (public.is_company_admin() or (entity_id is not null and public.can_manage_entity(entity_id)));

-- ---------- function privileges ----------
-- RLS helpers: needed by authenticated (policies run as the caller), never anon
revoke execute on function public.is_company_admin() from public, anon;
revoke execute on function public.can_manage_entity(uuid) from public, anon;
revoke execute on function public.can_manage_employee(uuid) from public, anon;
revoke execute on function public.current_employee_id() from public, anon;
revoke execute on function public.current_employee_entity_id() from public, anon;
grant execute on function public.is_company_admin() to authenticated;
grant execute on function public.can_manage_entity(uuid) to authenticated;
grant execute on function public.can_manage_employee(uuid) to authenticated;
grant execute on function public.current_employee_id() to authenticated;
grant execute on function public.current_employee_entity_id() to authenticated;

-- internal: triggers and trigger helpers are never RPC-callable
revoke execute on function public.attendance_locked(uuid, date) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.protect_admin_profiles() from public, anon, authenticated;
revoke execute on function public.audit_trigger() from public, anon, authenticated;
revoke execute on function public.assign_entity_from_employee() from public, anon, authenticated;
revoke execute on function public.guard_employee_entity() from public, anon, authenticated;
revoke execute on function public.guard_employee_rounding_balance() from public, anon, authenticated;
revoke execute on function public.guard_entity_update() from public, anon, authenticated;
revoke execute on function public.seed_entity_defaults() from public, anon, authenticated;
revoke execute on function public.guard_time_entry() from public, anon, authenticated;
revoke execute on function public.guard_correction_request() from public, anon, authenticated;
revoke execute on function public.guard_leave_request() from public, anon, authenticated;
revoke execute on function public.guard_leave_entitlement() from public, anon, authenticated;
revoke execute on function public.fill_payslip_from_run() from public, anon, authenticated;
revoke execute on function public.guard_payroll_adjustment() from public, anon, authenticated;
revoke execute on function public.guard_statutory_delete() from public, anon, authenticated;
revoke execute on function public.guard_own_request_update() from public, anon, authenticated;
revoke execute on function public.guard_payroll_run_update() from public, anon, authenticated;
revoke execute on function public.stale_drafts_on_change() from public, anon, authenticated;
revoke execute on function public.mark_payroll_drafts_stale(uuid, uuid, date, date) from public, anon, authenticated;
revoke execute on function public.adjust_run_deduction_balances(uuid, int) from public, anon, authenticated;

-- payroll/attendance RPCs: signed-in admins (authorization inside)
revoke execute on function public.finalize_payroll_run(uuid) from public, anon;
revoke execute on function public.reopen_payroll_run(uuid) from public, anon;
revoke execute on function public.review_time_correction(uuid, boolean, text) from public, anon;
grant execute on function public.finalize_payroll_run(uuid) to authenticated;
grant execute on function public.reopen_payroll_run(uuid) to authenticated;
grant execute on function public.review_time_correction(uuid, boolean, text) to authenticated;

-- service role only
revoke execute on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;
