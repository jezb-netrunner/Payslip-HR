-- Pay-rate history: every rate an employee has had, from a date, with the
-- reason and who approved it. Payroll pays each day at the rate in effect
-- that day. The employee row keeps the rate in effect today: it follows the
-- history when the history changes and nightly (a change dated ahead starts
-- on its date). Admins only: employees don't see their pay history.
create table public.employee_pay_rates (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  effective_from date not null,
  pay_type text not null constraint employee_pay_rates_pay_type_check check (pay_type in ('monthly', 'daily')),
  rate numeric(14,2) not null constraint employee_pay_rates_rate_check check (rate >= 0),
  reason text not null constraint employee_pay_rates_reason_check check (reason in
    ('hired', 'regularized', 'merit_increase', 'promotion', 'wage_order', 'adjustment', 'correction')),
  approved_by text not null default '' constraint employee_pay_rates_approved_by_check check (length(approved_by) <= 120),
  note text not null default '' constraint employee_pay_rates_note_check check (length(note) <= 500),
  career_event_id uuid references public.career_events(id) on delete set null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_pay_rates_one_per_date unique (employee_id, effective_from)
);
create index employee_pay_rates_entity_idx on public.employee_pay_rates (entity_id, effective_from);
create index employee_pay_rates_career_event_idx on public.employee_pay_rates (career_event_id);
create trigger employee_pay_rates_updated_at before update on public.employee_pay_rates
  for each row execute function public.set_updated_at();

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
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.entity_id is null then
    raise exception 'Employee not found.';
  end if;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$$;
create trigger employee_pay_rates_guard before insert or update or delete on public.employee_pay_rates
  for each row execute function public.guard_employee_pay_rate();

alter table public.employee_pay_rates enable row level security;
create policy "employee_pay_rates: admins manage" on public.employee_pay_rates
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
revoke all on public.employee_pay_rates from anon;

-- ---------- the history so far ----------
-- the rates recorded on career events (the latest event of a date wins)
insert into public.employee_pay_rates
  (employee_id, entity_id, effective_from, pay_type, rate, reason, note, career_event_id, created_by, created_at)
select distinct on (ce.employee_id, ce.effective_date)
  ce.employee_id, e.entity_id, ce.effective_date, t.pay_type,
  case when t.pay_type = 'monthly' then coalesce(ce.monthly_rate, 0) else coalesce(ce.daily_rate, 0) end,
  case ce.event_type when 'hired' then 'hired' when 'regularized' then 'regularized' when 'promoted' then 'promotion' else 'adjustment' end,
  left(ce.details, 500), ce.id, ce.created_by, ce.created_at
from public.career_events ce
join public.employees e on e.id = ce.employee_id
cross join lateral (select case
    when ce.monthly_rate is not null and ce.daily_rate is null then 'monthly'
    when ce.daily_rate is not null and ce.monthly_rate is null then 'daily'
    else e.pay_type end as pay_type) t
where ce.monthly_rate is not null or ce.daily_rate is not null
order by ce.employee_id, ce.effective_date, ce.created_at desc;

-- the rate on record today, where the history doesn't already end on it
-- (a rate edited directly, or an employee without a recorded rate)
insert into public.employee_pay_rates (employee_id, entity_id, effective_from, pay_type, rate, reason, note)
select e.id, e.entity_id,
  case when last.employee_id is null then e.hire_date else d.today end,
  e.pay_type,
  case when e.pay_type = 'monthly' then e.monthly_rate else e.daily_rate end,
  case when last.employee_id is null then 'hired' else 'adjustment' end,
  'Rate on record when the pay history started'
from public.employees e
cross join (select (now() at time zone 'Asia/Manila')::date as today) d
left join lateral (
  select r.employee_id, r.pay_type, r.rate from public.employee_pay_rates r
  where r.employee_id = e.id and r.effective_from <= d.today
  order by r.effective_from desc limit 1) last on true
where last.employee_id is null
   or (last.pay_type, last.rate) is distinct from
      (e.pay_type, case when e.pay_type = 'monthly' then e.monthly_rate else e.daily_rate end)
on conflict (employee_id, effective_from) do update
  set pay_type = excluded.pay_type, rate = excluded.rate, note = excluded.note;

-- the rates move off the career events, which employees can read
update public.career_events set monthly_rate = null, daily_rate = null
  where monthly_rate is not null or daily_rate is not null;

-- ---------- the employee row follows the history ----------
create or replace function public.refresh_current_pay_rates(p_employee uuid default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_n integer;
begin
  perform set_config('pay_rates.refresh', 'on', true);
  update employees e
    set pay_type = r.pay_type,
        monthly_rate = case when r.pay_type = 'monthly' then r.rate else 0 end,
        daily_rate = case when r.pay_type = 'daily' then r.rate else 0 end
    from (select distinct on (employee_id) employee_id, pay_type, rate
          from employee_pay_rates
          where effective_from <= (now() at time zone 'Asia/Manila')::date
            and (p_employee is null or employee_id = p_employee)
          order by employee_id, effective_from desc) r
    where e.id = r.employee_id
      and (e.pay_type, e.monthly_rate, e.daily_rate) is distinct from
          (r.pay_type, case when r.pay_type = 'monthly' then r.rate else 0 end, case when r.pay_type = 'daily' then r.rate else 0 end);
  get diagnostics v_n = row_count;
  perform set_config('pay_rates.refresh', 'off', true);
  return v_n;
end
$$;
revoke execute on function public.refresh_current_pay_rates(uuid) from public, anon, authenticated;

create or replace function public.pay_rates_changed()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.refresh_current_pay_rates(case when tg_op = 'DELETE' then old.employee_id else new.employee_id end);
  return null;
end
$$;
create trigger employee_pay_rates_refresh after insert or update or delete on public.employee_pay_rates
  for each row execute function public.pay_rates_changed();
create trigger employee_pay_rates_stale after insert or update or delete on public.employee_pay_rates
  for each row execute function public.stale_drafts_on_change();
create trigger audit_employee_pay_rates after insert or update or delete on public.employee_pay_rates
  for each row execute function public.audit_trigger();

-- a rate changes through the history, never on the employee row directly
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
  return new;
end
$$;
create trigger employees_rate_follows_history before update on public.employees
  for each row execute function public.guard_employee_rate();

-- a new employee's rate starts the history at the hire date
create or replace function public.seed_employee_pay_rate()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into employee_pay_rates (employee_id, entity_id, effective_from, pay_type, rate, reason, note)
  values (new.id, new.entity_id, new.hire_date, new.pay_type,
          case when new.pay_type = 'monthly' then new.monthly_rate else new.daily_rate end, 'hired', 'Rate at hire')
  on conflict (employee_id, effective_from) do nothing;
  return null;
end
$$;
create trigger employees_seed_pay_rate after insert on public.employees
  for each row execute function public.seed_employee_pay_rate();

revoke execute on function public.guard_employee_pay_rate() from public, anon, authenticated;
revoke execute on function public.pay_rates_changed() from public, anon, authenticated;
revoke execute on function public.guard_employee_rate() from public, anon, authenticated;
revoke execute on function public.seed_employee_pay_rate() from public, anon, authenticated;

-- a change dated ahead starts on its date: refresh at 00:05 Manila (16:05 UTC)
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('refresh-current-pay-rates', '5 16 * * *', 'select public.refresh_current_pay_rates()');
  end if;
end
$$;
