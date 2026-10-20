-- Adjustment guard: lock the run row FOR NO KEY UPDATE, not FOR SHARE. The
-- AFTER staleness trigger updates that same row; with a shared lock two
-- concurrent adjustment inserts on a computed draft each held FOR SHARE and
-- then deadlocked upgrading it. Same checks as 20261020031639_audit_fixes.
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
    for no key update;
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
