-- Fixed salary without timekeeping, a choice per employee (executives,
-- managers, field staff, consultants on an employee retainer): the monthly
-- rate pays each period. No time in/out is needed, nothing is docked for
-- absence or lateness, and no overtime, night differential or holiday
-- premium is computed. Unpaid leave and days outside the employment are
-- still deducted. Whether such an employee gets the 13th month is the
-- client's policy (on by default). Service incentive leave follows the
-- leave entitlements.
alter table public.employees
  add column if not exists fixed_salary boolean not null default false,
  add column if not exists thirteenth_month_eligible boolean not null default true,
  add constraint employees_fixed_salary_monthly check (not fixed_salary or pay_type = 'monthly'),
  add constraint employees_thirteenth_month_policy check (thirteenth_month_eligible or fixed_salary);

-- a fixed salary is a monthly rate: no daily rate in its history
create or replace function public.guard_employee_pay_rate()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id then
    raise exception 'A pay rate cannot move to another employee.';
  end if;
  -- RLS checks a new row only after this trigger: refuse another client's
  -- employee before saying anything about their pay
  if tg_op <> 'DELETE' and auth.uid() is not null and not public.can_manage_employee(new.employee_id) then
    raise exception 'Employee not found.';
  end if;
  if tg_op = 'DELETE' then
    -- an employee keeps a rate (unless the employee itself is removed)
    if exists (select 1 from employees e where e.id = old.employee_id)
       and not exists (select 1 from employee_pay_rates r where r.employee_id = old.employee_id and r.id <> old.id) then
      raise exception 'An employee keeps at least one pay rate: change it instead of removing it.';
    end if;
    return old;
  end if;
  if new.pay_type = 'daily' and exists (select 1 from employees e where e.id = new.employee_id and e.fixed_salary) then
    raise exception 'A fixed-salary employee is monthly-rated: turn off fixed salary first.';
  end if;
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$$;

-- turning fixed salary on: no daily rate ahead in the history either
create or replace function public.guard_employee_rate()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (new.pay_type, new.monthly_rate, new.daily_rate) is distinct from (old.pay_type, old.monthly_rate, old.daily_rate)
     and coalesce(current_setting('pay_rates.refresh', true), '') <> 'on'
     and exists (select 1 from employee_pay_rates r where r.employee_id = new.id) then
    raise exception 'Change a pay rate in the employee''s pay history: the employee''s rate follows it.';
  end if;
  if new.fixed_salary and not old.fixed_salary
     and exists (select 1 from employee_pay_rates r
                 where r.employee_id = new.id and r.pay_type = 'daily'
                   and r.effective_from > (now() at time zone 'Asia/Manila')::date) then
    raise exception 'A daily rate is dated ahead in the pay history: a fixed salary is monthly-rated.';
  end if;
  return new;
end
$$;
