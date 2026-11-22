-- Request limits and table privileges (final review, 2026-11-21).
--
-- 1. A leave request charges more than 0 and at most its calendar span of
--    days. The days were the caller's own count: an employee could file a
--    five-day leave charging -30 or 0 days, and approval kept it (the
--    balances read days, payroll reads the dates). Approval in the app now
--    counts the days again from the schedule, the database bounds them.
-- 2. Reasons are at most 500 characters and review notes 1,000, like the
--    cash-advance requests, and an employee has at most 20 pending leave
--    requests, 31 pending time corrections and 5 pending cash-advance
--    requests (one per day of a month for corrections): an API caller could
--    otherwise fill the review queues without limit.
-- 3. Signed-in users lose TRUNCATE, REFERENCES and TRIGGER on every public
--    table (the Supabase default grants them). The API never issues them,
--    but row-level security does not cover TRUNCATE, so the grant is a
--    standing risk, and later tables don't get them either.
--
-- Live data checked before (2026-11-21): 5 leave requests, none outside the
-- day bounds, longest reason 63 characters, at most 1 pending request of any
-- kind per employee.

-- 1 + 2: leave requests
alter table public.leave_requests
  add constraint leave_requests_days_check check (days > 0 and days <= (end_date - start_date + 1)),
  add constraint leave_requests_reason_check check (length(reason) <= 500),
  add constraint leave_requests_review_notes_check check (review_notes is null or length(review_notes) <= 1000);

alter table public.time_correction_requests
  add constraint time_correction_requests_reason_check check (length(reason) <= 500),
  add constraint time_correction_requests_review_notes_check check (review_notes is null or length(review_notes) <= 1000);

alter table public.advance_requests
  add constraint advance_requests_review_notes_check check (review_notes is null or length(review_notes) <= 1000);

CREATE OR REPLACE FUNCTION public.guard_leave_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- a whole-day leave charges more than nothing and at most its dates
  if new.days <= 0 or new.days > (new.end_date - new.start_date + 1) then
    raise exception 'A leave from % to % charges more than 0 and at most % day/s.',
      to_char(new.start_date, 'FMMon FMDD, YYYY'), to_char(new.end_date, 'FMMon FMDD, YYYY'), new.end_date - new.start_date + 1;
  end if;
  -- the review queue has a limit (the advisory lock above serializes the count)
  if tg_op = 'INSERT' and new.status = 'pending'
     and (select count(*) from leave_requests where employee_id = new.employee_id and status = 'pending') >= 20 then
    raise exception 'There are already 20 pending leave requests for this employee: wait for them to be reviewed, or cancel some.';
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

CREATE OR REPLACE FUNCTION public.guard_correction_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform pg_advisory_xact_lock(hashtextextended('correction_requests:' || new.employee_id::text, 0));
    if (select count(*) from time_correction_requests where employee_id = new.employee_id and status = 'pending') >= 31 then
      raise exception 'There are already 31 pending time corrections for this employee: wait for them to be reviewed, or cancel some.';
    end if;
  end if;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.guard_advance_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sep date;
begin
  if tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id then
    raise exception 'A request cannot move to another employee.';
  end if;
  select entity_id, separation_date into new.entity_id, v_sep from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  if tg_op = 'INSERT' and not public.can_manage_entity(new.entity_id) then
    if v_sep is not null and v_sep < (now() at time zone 'Asia/Manila')::date then
      raise exception 'Separated employees can''t request a cash advance.';
    end if;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.review_notes := null;
    new.advance_id := null;
  end if;
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform pg_advisory_xact_lock(hashtextextended('advance_requests:' || new.employee_id::text, 0));
    if (select count(*) from advance_requests where employee_id = new.employee_id and status = 'pending') >= 5 then
      raise exception 'There are already 5 pending cash-advance requests for this employee: wait for them to be reviewed, or cancel some.';
    end if;
  end if;
  -- approval creates the advance in the same step (approve_advance_request)
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status <> 'approved') and new.advance_id is null then
    raise exception 'Approve a request from Cash Advances, which records the advance with it.';
  end if;
  return new;
end
$function$;

-- 3: table privileges
revoke truncate, references, trigger on all tables in schema public from authenticated, anon;
alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from authenticated;
