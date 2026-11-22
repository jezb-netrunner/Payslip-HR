-- Half-day leave: one date of a leave counted in working days can be taken
-- for the morning or the afternoon only. The request charges half a day of
-- the leave balance, and payroll counts the other half of the day from the
-- time in/out on record.
--
-- 1. leave_requests.half_day: 'am' or 'pm' (null = whole days), on a
--    request for one date only.
-- 2. guard_leave_request: a half-day request charges 0.5 day whatever the
--    caller sent, maternity leave (calendar days) has no half day, and the
--    half of an approved leave inside a finalized payroll cannot change
--    (it would change the attendance that payroll paid).
-- Nothing destructive, no existing row changes, and no semicolon inside a
-- string or comment: the migration applies through the Supabase MCP (see
-- MEMORY.md).

alter table public.leave_requests
  add column if not exists half_day text;
comment on column public.leave_requests.half_day is
  'Half a day of leave on one date: am (the morning) or pm (the afternoon). Null = whole days.';

alter table public.leave_requests
  add constraint leave_requests_half_day_check check (half_day in ('am', 'pm'));
alter table public.leave_requests
  add constraint leave_requests_half_day_one_date check (half_day is null or start_date = end_date);

create or replace function public.guard_leave_request()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_type leave_types;
  v_from date;
begin
  if tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id then
    raise exception 'A leave request cannot move to another employee.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' || new.employee_id::text, 0));
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  select * into v_type from leave_types where id = new.leave_type_id and entity_id = new.entity_id;
  if v_type.id is null then
    raise exception 'Leave type does not belong to this employee''s company.';
  end if;
  -- a half day is half a day of the balance, never what the caller sent
  if new.half_day is not null then
    if v_type.code = 'ML' then
      raise exception 'Maternity leave runs in calendar days: it has no half day.';
    end if;
    new.days := 0.5;
  end if;
  if new.status in ('pending', 'approved') and v_type.min_service_months > 0
     and (tg_op = 'INSERT' or new.status is distinct from old.status
          or new.start_date is distinct from old.start_date
          or new.leave_type_id is distinct from old.leave_type_id) then
    select (hire_date + make_interval(months => v_type.min_service_months))::date into v_from
      from employees where id = new.employee_id;
    if new.start_date < v_from and not exists (
      select 1 from employee_leave_entitlements
       where employee_id = new.employee_id and leave_type_id = new.leave_type_id
         and year = extract(year from new.start_date)::int and days > 0
    ) then
      raise exception '% can be used after % months of service: from % for this employee. To grant it sooner, set the employee''s % leave credits.',
        v_type.name, v_type.min_service_months, to_char(v_from, 'FMMon FMDD, YYYY'),
        extract(year from new.start_date)::int;
    end if;
  end if;
  if (new.status = 'approved' or (tg_op = 'UPDATE' and old.status = 'approved'))
     and (tg_op = 'INSERT' or new.status is distinct from old.status
          or new.start_date is distinct from old.start_date or new.end_date is distinct from old.end_date
          or new.leave_type_id is distinct from old.leave_type_id
          or new.half_day is distinct from old.half_day) then
    if exists (
      select 1 from generate_series(least(new.start_date, coalesce(old.start_date, new.start_date)),
                                    greatest(new.end_date, coalesce(old.end_date, new.end_date)),
                                    interval '1 day') d
      where public.attendance_locked(new.employee_id, d::date)
    ) then
      raise exception 'Part of this leave falls in a finalized payroll run. Void and reissue that run first, or settle the leave as an adjustment in the next payroll.';
    end if;
  end if;
  return new;
end
$function$;
