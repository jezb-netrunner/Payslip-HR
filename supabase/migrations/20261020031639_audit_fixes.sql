-- Audit fixes (2026-10-20 review): draft staleness gaps, finalize/reopen
-- locking, paid-leave guards, audit noise and the actor of service-role
-- writes. Function bodies only (CREATE OR REPLACE) plus new triggers — no
-- table or data changes.

-- ---------- draft staleness ----------
-- computeRun also reads the statutory tables, leave-type pay flags and the
-- employee's tax-year (previous employer) data: changing any of them now
-- marks affected drafts stale. A draft that is still computing has no
-- payslips yet, so any change in its client/period wipes its token.
-- Finalize/reopen don't cascade into other drafts (their payroll_seq bump
-- already makes those drafts stale), which also removes a lock-order
-- deadlock between two finalizes sharing an employee with a loan.
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
          or r.totals ? 'computing'
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
create trigger statutory_versions_stale after insert or update or delete on public.statutory_versions
  for each row execute function public.stale_drafts_on_change();
create trigger leave_types_stale after update on public.leave_types
  for each row execute function public.stale_drafts_on_change();
create trigger employee_tax_years_stale after insert or update or delete on public.employee_tax_years
  for each row execute function public.stale_drafts_on_change();

-- ---------- paid-attendance lock ----------
-- Take the per-employee lock BEFORE checking attendance_locked (finalize
-- and reopen take the same locks first), so an entry saved while a
-- finalize is in flight can't slip into the period it pays.
create or replace function public.guard_time_entry()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_emp uuid;
begin
  for v_emp in
    select distinct x from unnest(array[case when tg_op <> 'INSERT' then old.employee_id end,
                                        case when tg_op <> 'DELETE' then new.employee_id end]) x
    where x is not null order by x
  loop
    perform pg_advisory_xact_lock(hashtextextended('time_entries:' || v_emp::text, 0));
  end loop;

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

-- An approved leave changes pay for its dates: it can't be approved, moved,
-- re-pointed to another employee or deleted on days a finalized payroll
-- already paid.
create or replace function public.guard_leave_request()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id then
    raise exception 'A leave request cannot move to another employee.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' || new.employee_id::text, 0));
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  if not exists (select 1 from leave_types where id = new.leave_type_id and entity_id = new.entity_id) then
    raise exception 'Leave type does not belong to this employee''s company.';
  end if;
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

create or replace function public.guard_leave_request_delete()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.status = 'approved' then
    perform pg_advisory_xact_lock(hashtextextended('time_entries:' || old.employee_id::text, 0));
    if exists (select 1 from generate_series(old.start_date, old.end_date, interval '1 day') d
               where public.attendance_locked(old.employee_id, d::date)) then
      raise exception 'Part of this leave falls in a finalized payroll run. Reopen that run first.';
    end if;
  end if;
  return old;
end
$$;
create trigger leave_requests_guard_delete before delete on public.leave_requests
  for each row execute function public.guard_leave_request_delete();

-- Only signed-in callers are limited to cancelling; foreign-key updates run
-- by the service role or the SQL editor (no user) are not employee edits.
create or replace function public.guard_own_request_update()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and auth.uid() is not null and not public.can_manage_entity(old.entity_id)
     and (old.status <> 'pending' or new.status <> 'cancelled'
          or (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at')) then
    raise exception 'You can only cancel a pending request.';
  end if;
  return new;
end
$$;

-- ---------- payroll lifecycle ----------
-- Finalize/reopen lock in the order every writer uses — per-employee
-- advisory lock, employee rows, the loans the payslips move — and only then
-- the run row.
create or replace function public.lock_run_participants(p_run uuid)
returns uuid[]
language plpgsql security definer set search_path = public
as $$
declare
  v_ids uuid[];
  v_emp uuid;
begin
  select coalesce(array_agg(distinct employee_id order by employee_id), '{}') into v_ids
    from payslips where payroll_run_id = p_run;
  foreach v_emp in array v_ids loop
    perform pg_advisory_xact_lock(hashtextextended('time_entries:' || v_emp::text, 0));
  end loop;
  perform 1 from employees e where e.id = any(v_ids) order by e.id for update;
  perform 1 from recurring_deductions d
    where d.employee_id = any(v_ids)
      and d.id in (select (line->>'meta')::uuid
                   from payslips p, jsonb_array_elements(p.deductions) line
                   where p.payroll_run_id = p_run and line->>'code' like 'other:%'
                     and line->>'meta' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
    order by d.id for update;
  return v_ids;
end
$$;

-- Finalize: status flip, loan balance decrements and the cash-rounding
-- carry-forward chain settle in ONE transaction, on a complete, current
-- draft only (see the multi-client migration). Also refuses a draft with an
-- adjustment for someone the run doesn't pay (left out of the run), which
-- would otherwise vanish unpaid.
create or replace function public.finalize_payroll_run(p_run uuid)
returns public.payroll_runs
language plpgsql security definer set search_path = public
as $$
declare
  v_run payroll_runs;
  v_names text;
  v_count int;
  v_locked uuid[];
begin
  select * into v_run from payroll_runs where id = p_run;
  if v_run.id is null or not can_manage_entity(v_run.entity_id) then
    raise exception 'Payroll run not found.';
  end if;
  v_locked := lock_run_participants(p_run);
  select * into v_run from payroll_runs where id = p_run for update;
  if v_run.status <> 'draft' then
    raise exception 'This run is not a draft — it may already be finalized.';
  end if;
  if exists (select 1 from payslips where payroll_run_id = p_run and employee_id <> all(v_locked)) then
    raise exception 'This draft is out of date or its computation did not finish. Recompute the draft, then finalize.';
  end if;

  select count(*) into v_count from payslips where payroll_run_id = p_run;
  if not (v_run.totals ? 'employees') or (v_run.totals->>'employees')::int <> v_count then
    raise exception 'This draft is out of date or its computation did not finish. Recompute the draft, then finalize.';
  end if;
  if v_count = 0 then
    raise exception 'Nothing to finalize: the draft has no payslips.';
  end if;

  select string_agg(distinct e.first_name || ' ' || e.last_name, ', ') into v_names
    from payroll_adjustments a join employees e on e.id = a.employee_id
    where a.payroll_run_id = p_run
      and not exists (select 1 from payslips p where p.payroll_run_id = p_run and p.employee_id = a.employee_id);
  if v_names is not null then
    raise exception 'This run has adjustments for % but no payslip for them (left out of the run). Remove those adjustments or add them to a run that pays them, then finalize.', v_names;
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

-- Reopen: reverses the loan decrements and the rounding carry — only while
-- no later finalized payroll of the same employee sits on this run's carry
-- chain — and returns the run as a draft that must be recomputed (its
-- payslips predate the payroll_seq bump).
create or replace function public.reopen_payroll_run(p_run uuid)
returns public.payroll_runs
language plpgsql security definer set search_path = public
as $$
declare
  v_run payroll_runs;
  v_used text;
begin
  select * into v_run from payroll_runs where id = p_run;
  if v_run.id is null or not can_manage_entity(v_run.entity_id) then
    raise exception 'Payroll run not found.';
  end if;
  perform lock_run_participants(p_run);
  select * into v_run from payroll_runs where id = p_run for update;
  if v_run.status not in ('finalized','paid') then
    raise exception 'This run is not finalized — nothing to reopen.';
  end if;

  select string_agg(e.first_name || ' ' || e.last_name, ', ') into v_used
    from payslips p join employees e on e.id = p.employee_id
    where p.payroll_run_id = p_run
      and (e.rounding_balance <> p.rounding_carry_out
           or ((p.rounding_carry_in <> 0 or p.rounding_carry_out <> 0) and exists (
                 select 1 from payslips q join payroll_runs r on r.id = q.payroll_run_id
                 where q.employee_id = p.employee_id and q.payroll_run_id <> p_run
                   and r.status in ('finalized','paid')
                   and q.employee_payroll_seq > p.employee_payroll_seq)));
  if v_used is not null then
    raise exception 'A later finalized payroll already carried forward this run''s rounding for: %. Reopen that later run first.', v_used;
  end if;

  perform set_config('payroll.lifecycle', 'on', true);
  update payroll_runs
    set status = 'draft', finalized_at = null, finalized_by = null, totals = '{}'::jsonb
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

-- Adjustments: serialize with an in-flight finalize of the run (same
-- per-employee lock, then the run row FOR SHARE) before the status check.
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
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' ||
    (case when tg_op = 'DELETE' then old.employee_id else new.employee_id end)::text, 0));
  select * into v_run from payroll_runs
    where id = case when tg_op = 'DELETE' then old.payroll_run_id else new.payroll_run_id end
    for share;
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

-- ---------- audit log ----------
-- Bookkeeping writes (draft totals and compute tokens, payroll sequence,
-- carried centavos, timestamps) are not changes anyone reviews: skip them.
-- The admin-users edge function writes with the service role and names the
-- signed-in admin it acts for in an x-actor-id header; only a service-role
-- request can set the actor that way.
create or replace function public.audit_trigger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_row jsonb;
  v_entity uuid;
  v_email text;
  v_actor uuid := auth.uid();
  v_header text;
  v_ignore text[] := case tg_table_name
    when 'employees' then array['updated_at','payroll_seq','rounding_balance']
    when 'payroll_runs' then array['updated_at','totals']
    else array['updated_at'] end;
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) - v_ignore) = (to_jsonb(old) - v_ignore) then
    return new;
  end if;
  if v_actor is null
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') = 'service_role' then
    v_header := nullif(current_setting('request.headers', true), '')::jsonb->>'x-actor-id';
    if v_header ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_actor := v_header::uuid;
    end if;
  end if;

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
  select coalesce(email, nullif(full_name, '')) into v_email from profiles where id = v_actor;

  insert into audit_logs (actor_id, actor_email, action, table_name, record_id, entity_id, old_data, new_data)
  values (
    v_actor,
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

-- helpers and trigger functions are not API endpoints
revoke execute on function public.guard_leave_request_delete() from public, anon, authenticated;
revoke execute on function public.lock_run_participants(uuid) from public, anon, authenticated;
