-- Leave types can require months of service before they can be used.
-- Service Incentive Leave: "every employee who has rendered at least one
-- year of service" (Labor Code Art. 95); the IRR counts 12 months of
-- service, continuous or broken, from the date the employee started. A
-- client may grant it sooner (a shorter period per policy or contract), so
-- the months are a per-client leave-type setting, and HR can still grant it
-- earlier to one employee by setting that year's leave credits.
alter table public.leave_types
  add column min_service_months smallint not null default 0
  constraint leave_types_min_service_months_check check (min_service_months between 0 and 120);

update public.leave_types set min_service_months = 12 where code = 'SIL';

-- New clients start with the statutory leave types (global template rows).
create or replace function public.seed_entity_defaults()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into leave_types (entity_id, code, name, default_annual_days, paid, active, min_service_months)
  select new.id, code, name, default_annual_days, paid, active, min_service_months
  from leave_types where entity_id is null;
  return new;
end
$$;

-- Same checks as 20261020031639_audit_fixes, plus the service requirement:
-- a leave filed or approved for days before the employee is eligible is
-- refused unless HR set the employee's credits for that year.
create or replace function public.guard_leave_request()
returns trigger
language plpgsql security definer set search_path = public
as $$
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

-- trigger functions are not API endpoints
revoke execute on function public.seed_entity_defaults() from public, anon, authenticated;
revoke execute on function public.guard_leave_request() from public, anon, authenticated;
