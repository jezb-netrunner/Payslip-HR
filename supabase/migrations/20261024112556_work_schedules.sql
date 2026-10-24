-- Flexible work schedules (owner, 2026-10-24: "schedules differ; fixed
-- schedule logic will be a problem later"). The industry-standard shape:
--
--   shift_templates     per-client presets ("Day 8–5", "Night 10–6",
--                       "Half day Sat") to pick from;
--   employee_schedules  an employee's weekly pattern (a shift or a rest day
--                       for each weekday) from an effective date, history
--                       kept, so an earlier period always computes with the
--                       schedule that was in force then;
--   schedule_overrides  roster changes for single dates: a swapped shift, a
--                       moved rest day, a one-off schedule.
--
-- For a date the roster change wins, then the latest pattern in force, then
-- the employee's base work_schedule (which still applies before the first
-- change, so nothing changes for anyone until a schedule is edited).
--
-- A shift is stored as a snapshot {start, end, break_minutes, flex_minutes?,
-- compressed?, name?}: editing a template never rewrites the schedules
-- already assigned. Paid days stay as they were paid: a pattern can't start
-- on or before the employee's last paid day, and a paid date's roster entry
-- is locked, like its time in/out. Changes stale the drafts they affect.

-- ---------- shift snapshots ----------
create or replace function public.valid_shift(p jsonb)
returns boolean
language plpgsql immutable set search_path = public
as $$
declare
  v_start int;
  v_end int;
  v_break numeric;
  v_flex numeric;
  v_span int;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  if coalesce(p->>'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or coalesce(p->>'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return false;
  end if;
  if jsonb_typeof(p->'break_minutes') is distinct from 'number' then
    return false;
  end if;
  v_break := (p->>'break_minutes')::numeric;
  if v_break < 0 or v_break > 600 or v_break <> trunc(v_break) then
    return false;
  end if;
  if p ? 'flex_minutes' then
    if jsonb_typeof(p->'flex_minutes') <> 'number' then
      return false;
    end if;
    v_flex := (p->>'flex_minutes')::numeric;
    if v_flex < 0 or v_flex > 480 or v_flex <> trunc(v_flex) then
      return false;
    end if;
  end if;
  if p ? 'compressed' and jsonb_typeof(p->'compressed') <> 'boolean' then
    return false;
  end if;
  if p ? 'name' and (jsonb_typeof(p->'name') <> 'string' or length(p->>'name') > 60) then
    return false;
  end if;
  v_start := split_part(p->>'start', ':', 1)::int * 60 + split_part(p->>'start', ':', 2)::int;
  v_end := split_part(p->>'end', ':', 1)::int * 60 + split_part(p->>'end', ':', 2)::int;
  -- an end at or before the start is the next morning (a 24-hour duty when equal)
  v_span := case when v_end > v_start then v_end - v_start else v_end - v_start + 1440 end;
  if v_span <= v_break then
    return false;
  end if;
  -- a compressed workweek day runs at most 12 hours of work (DOLE Department
  -- Advisory 02-04); a break under an hour is paid time, so it counts
  if coalesce((p->>'compressed')::boolean, false)
     and v_span - (case when v_break >= 60 then v_break else 0 end) > 720 then
    return false;
  end if;
  return true;
end
$$;

-- Monday..Sunday: a shift snapshot, or null for a rest day. A week with a
-- compressed day is a compressed workweek: fewer than six workdays and at
-- most 48 hours of work (DOLE Department Advisory 02-04).
create or replace function public.valid_week_pattern(p jsonb)
returns boolean
language plpgsql immutable set search_path = public
as $$
declare
  i int;
  v_days int := 0;
  v_minutes int := 0;
  v_compressed boolean := false;
  v_start int;
  v_end int;
  v_break int;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) <> 7 then
    return false;
  end if;
  for i in 0..6 loop
    if jsonb_typeof(p->i) <> 'null' then
      if not public.valid_shift(p->i) then
        return false;
      end if;
      v_days := v_days + 1;
      v_compressed := v_compressed or coalesce((p->i->>'compressed')::boolean, false);
      v_start := split_part(p->i->>'start', ':', 1)::int * 60 + split_part(p->i->>'start', ':', 2)::int;
      v_end := split_part(p->i->>'end', ':', 1)::int * 60 + split_part(p->i->>'end', ':', 2)::int;
      v_break := (p->i->>'break_minutes')::int;
      v_minutes := v_minutes + (case when v_end > v_start then v_end - v_start else v_end - v_start + 1440 end)
                             - (case when v_break >= 60 then v_break else 0 end);
    end if;
  end loop;
  return not v_compressed or (v_days <= 5 and v_minutes <= 2880);
end
$$;

-- The employee's last day paid by a finalized payroll (time in/out locks up to it)
create or replace function public.last_paid_date(p_employee uuid)
returns date
language sql stable security definer set search_path = public
as $$
  select max(r.period_end)
  from payslips p join payroll_runs r on r.id = p.payroll_run_id
  where p.employee_id = p_employee
    and r.status in ('finalized','paid')
    and r.run_type in ('regular','special','final_pay')
$$;

-- ---------- shift templates ----------
create table public.shift_templates (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  name text not null constraint shift_templates_name_check check (length(btrim(name)) between 1 and 60),
  shift jsonb not null constraint shift_templates_shift_check check (public.valid_shift(shift)),
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_templates_name_unique unique (entity_id, name)
);
create trigger shift_templates_updated_at before update on public.shift_templates
  for each row execute function public.set_updated_at();

alter table public.shift_templates enable row level security;
create policy "shift_templates: admins manage" on public.shift_templates
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));

create trigger audit_shift_templates
  after insert or update or delete on public.shift_templates
  for each row execute function public.audit_trigger();

-- ---------- weekly patterns, effective-dated ----------
create table public.employee_schedules (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  effective_from date not null,
  pattern jsonb not null constraint employee_schedules_pattern_check check (public.valid_week_pattern(pattern)),
  note text not null default '' constraint employee_schedules_note_check check (length(note) <= 300),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_schedules_one_per_date unique (employee_id, effective_from)
);
create index employee_schedules_entity_idx on public.employee_schedules (entity_id, effective_from);
create trigger employee_schedules_updated_at before update on public.employee_schedules
  for each row execute function public.set_updated_at();

create or replace function public.guard_employee_schedule()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_emp uuid := case when tg_op = 'DELETE' then old.employee_id else new.employee_id end;
  v_paid date;
begin
  if tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id then
    raise exception 'A schedule cannot move to another employee.';
  end if;
  -- RLS checks a new row only after this trigger: refuse another client's
  -- employee before saying anything about their pay
  if tg_op <> 'DELETE' and auth.uid() is not null and not public.can_manage_employee(new.employee_id) then
    raise exception 'Employee not found.';
  end if;
  -- same writer order as attendance and finalize: the employee's payroll lock first
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' || v_emp::text, 0));
  v_paid := public.last_paid_date(v_emp);
  -- a note on a schedule already paid can still be corrected
  if tg_op = 'UPDATE' and new.effective_from = old.effective_from and new.pattern = old.pattern then
    v_paid := null;
  end if;
  if v_paid is not null then
    if tg_op in ('UPDATE','DELETE') and old.effective_from <= v_paid then
      raise exception 'This schedule covers days already paid (through %). Reopen that payroll to change it, or start a new schedule after %.', v_paid, v_paid;
    end if;
    if tg_op in ('INSERT','UPDATE') and new.effective_from <= v_paid then
      raise exception 'Pay through % is final: a schedule change can start on % at the earliest.', v_paid, v_paid + 1;
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$$;
create trigger employee_schedules_guard before insert or update or delete on public.employee_schedules
  for each row execute function public.guard_employee_schedule();

alter table public.employee_schedules enable row level security;
create policy "employee_schedules: admins manage" on public.employee_schedules
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "employee_schedules: read own" on public.employee_schedules
  for select to authenticated using (employee_id = public.current_employee_id());

create trigger audit_employee_schedules
  after insert or update or delete on public.employee_schedules
  for each row execute function public.audit_trigger();

-- ---------- roster changes for single dates ----------
create table public.schedule_overrides (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  work_date date not null,
  -- null: a rest day that date
  shift jsonb constraint schedule_overrides_shift_check check (shift is null or public.valid_shift(shift)),
  note text not null default '' constraint schedule_overrides_note_check check (length(note) <= 300),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedule_overrides_one_per_date unique (employee_id, work_date)
);
create index schedule_overrides_entity_idx on public.schedule_overrides (entity_id, work_date);
create trigger schedule_overrides_updated_at before update on public.schedule_overrides
  for each row execute function public.set_updated_at();

create or replace function public.guard_schedule_override()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_emp uuid := case when tg_op = 'DELETE' then old.employee_id else new.employee_id end;
begin
  if tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id then
    raise exception 'A roster entry cannot move to another employee.';
  end if;
  if tg_op <> 'DELETE' and auth.uid() is not null and not public.can_manage_employee(new.employee_id) then
    raise exception 'Employee not found.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' || v_emp::text, 0));
  if tg_op in ('UPDATE','DELETE') and public.attendance_locked(old.employee_id, old.work_date) then
    raise exception 'The schedule on % was paid in a finalized payroll run and is locked. Reopen that run to change it.', old.work_date;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if public.attendance_locked(new.employee_id, new.work_date) then
    raise exception 'The schedule on % was paid in a finalized payroll run and is locked. Reopen that run to change it.', new.work_date;
  end if;
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$$;
create trigger schedule_overrides_guard before insert or update or delete on public.schedule_overrides
  for each row execute function public.guard_schedule_override();

alter table public.schedule_overrides enable row level security;
create policy "schedule_overrides: admins manage" on public.schedule_overrides
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "schedule_overrides: read own" on public.schedule_overrides
  for select to authenticated using (employee_id = public.current_employee_id());

create trigger audit_schedule_overrides
  after insert or update or delete on public.schedule_overrides
  for each row execute function public.audit_trigger();

-- ---------- drafts follow the schedule ----------
-- Same function as 20261020031639_audit_fixes plus the two schedule tables:
-- a pattern affects the employee's drafts from its effective date on, a
-- roster entry the drafts holding its date.
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
  -- finalize/reopen: drafts sharing these employees are already stale
  -- through payroll_seq
  if coalesce(current_setting('payroll.lifecycle', true), '') = 'on' then
    return coalesce(new, old);
  end if;
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
      when 'schedule_overrides' then
        perform mark_payroll_drafts_stale((r->>'entity_id')::uuid, (r->>'employee_id')::uuid,
                                          (r->>'work_date')::date, (r->>'work_date')::date);
      when 'employee_schedules' then
        perform mark_payroll_drafts_stale((r->>'entity_id')::uuid, (r->>'employee_id')::uuid,
                                          (r->>'effective_from')::date, null);
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
      when 'statutory_versions' then
        -- every client; 13th-month drafts included (withholding on the excess)
        update payroll_runs set totals = '{}'::jsonb
          where status = 'draft' and totals <> '{}'::jsonb
            and greatest(period_end, pay_date) >= (r->>'effective_from')::date;
      when 'leave_types' then
        if r->>'entity_id' is not null then
          perform mark_payroll_drafts_stale((r->>'entity_id')::uuid, null, null, null);
        end if;
      else -- employee_allowances, recurring_deductions, employee_tax_years
        select entity_id into v_entity from employees where id = (r->>'employee_id')::uuid;
        perform mark_payroll_drafts_stale(v_entity, (r->>'employee_id')::uuid, null, null);
    end case;
  end loop;
  return coalesce(new, old);
end
$$;
create trigger employee_schedules_stale after insert or update or delete on public.employee_schedules
  for each row execute function public.stale_drafts_on_change();
create trigger schedule_overrides_stale after insert or update or delete on public.schedule_overrides
  for each row execute function public.stale_drafts_on_change();

-- trigger functions and the definer helper are not API endpoints; the
-- validators run inside check constraints as the writing user
revoke execute on function public.guard_employee_schedule() from public, anon, authenticated;
revoke execute on function public.guard_schedule_override() from public, anon, authenticated;
revoke execute on function public.last_paid_date(uuid) from public, anon, authenticated;
revoke execute on function public.valid_shift(jsonb) from public, anon;
revoke execute on function public.valid_week_pattern(jsonb) from public, anon;
