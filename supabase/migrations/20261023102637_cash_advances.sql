-- Cash advances ("bale"): an employee asks for part of their pay early and
-- repays it from the next payrolls. Deducting it from wages needs the
-- employee's written authorization, and the employer may not profit from it
-- (Labor Code Art. 113; IRR Book III Rule VIII Sec. 10 as amended by DOLE
-- D.O. 195-2018), so advances carry no interest and record when the
-- authorization was signed.
--
-- An advance is a balance-tracked recurring deduction (category
-- 'cash_advance'): payroll already deducts those, finalize decrements the
-- balance and reopen restores it. This adds the advance's details, the
-- employees' requests, repayments made outside payroll, and a guard so the
-- balance only ever moves through payroll or a recorded repayment:
-- amount released = deducted by finalized payrolls + repaid + balance.

-- ---------- advance details on the deduction ----------
alter table public.recurring_deductions
  add column released_on date,
  add column release_method text
    constraint recurring_deductions_release_method_check check (release_method in ('cash','bank_transfer','e_wallet','check')),
  add column authorized_on date,
  add column notes text not null default '';

create or replace function public.guard_cash_advance()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_trusted boolean := coalesce(current_setting('payroll.lifecycle', true), '') = 'on'
                       or coalesce(current_setting('payroll.advance_repayment', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    if old.category = 'cash_advance' and old.balance is distinct from old.total_amount then
      raise exception 'Part of this cash advance has already been repaid, so it can''t be deleted. Pause it instead.';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and (old.category = 'cash_advance') <> (new.category = 'cash_advance') then
    raise exception 'A deduction can''t be turned into a cash advance or back; record cash advances under Cash Advances.';
  end if;
  if new.category <> 'cash_advance' or v_trusted then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.total_amount is null or new.total_amount <= 0 or new.balance is distinct from new.total_amount then
      raise exception 'A cash advance starts with its balance equal to the amount released.';
    end if;
    if new.released_on is null then
      raise exception 'Enter the date the cash advance was released.';
    end if;
    if new.authorized_on is null then
      raise exception 'Record the date the employee signed the written authorization to deduct the advance from their pay.';
    end if;
  else
    if new.employee_id is distinct from old.employee_id then
      raise exception 'A cash advance cannot move to another employee.';
    end if;
    if (new.balance is distinct from old.balance or new.total_amount is distinct from old.total_amount)
       and (old.balance is distinct from old.total_amount        -- something was already repaid
            or new.balance is distinct from new.total_amount     -- a correction moves both together
            or new.total_amount is null or new.total_amount <= 0) then
      raise exception 'A cash advance''s balance changes only through payroll or a recorded repayment. Before anything is repaid, the amount can be corrected.';
    end if;
  end if;
  if new.amount_per_period is null or new.amount_per_period <= 0 then
    raise exception 'Enter the amount to deduct per payroll.';
  end if;
  return new;
end
$$;
create trigger recurring_deductions_cash_advance before insert or update or delete on public.recurring_deductions
  for each row execute function public.guard_cash_advance();

-- ---------- employees' requests ----------
create table public.advance_requests (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  amount numeric(12,2) not null constraint advance_requests_amount_check check (amount > 0 and amount <= 10000000),
  per_payroll numeric(12,2) not null constraint advance_requests_per_payroll_check check (per_payroll > 0),
  reason text not null default '' constraint advance_requests_reason_check check (length(reason) <= 500),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_notes text,
  advance_id uuid references public.recurring_deductions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint advance_requests_installment_check check (per_payroll <= amount)
);
create index advance_requests_entity_idx on public.advance_requests (entity_id, status);
create index advance_requests_employee_idx on public.advance_requests (employee_id);
create index advance_requests_advance_idx on public.advance_requests (advance_id);
create trigger advance_requests_updated_at before update on public.advance_requests
  for each row execute function public.set_updated_at();

create or replace function public.guard_advance_request()
returns trigger
language plpgsql security definer set search_path = public
as $$
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
  -- approval creates the advance in the same step (approve_advance_request)
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status <> 'approved') and new.advance_id is null then
    raise exception 'Approve a request from Cash Advances, which records the advance with it.';
  end if;
  return new;
end
$$;
create trigger advance_requests_guard before insert or update on public.advance_requests
  for each row execute function public.guard_advance_request();
-- employees may only cancel their own pending request
create trigger advance_requests_own_update before update on public.advance_requests
  for each row execute function public.guard_own_request_update();

alter table public.advance_requests enable row level security;
create policy "advance_requests: admins manage" on public.advance_requests
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "advance_requests: read own" on public.advance_requests
  for select to authenticated using (employee_id = public.current_employee_id());
create policy "advance_requests: file own" on public.advance_requests
  for insert to authenticated
  with check (employee_id = public.current_employee_id() and status = 'pending');
create policy "advance_requests: cancel own pending" on public.advance_requests
  for update to authenticated
  using (employee_id = public.current_employee_id() and status = 'pending')
  with check (employee_id = public.current_employee_id() and status in ('pending','cancelled'));

create trigger audit_advance_requests
  after insert or update or delete on public.advance_requests
  for each row execute function public.audit_trigger();

-- ---------- repayments outside payroll ----------
create table public.advance_repayments (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null references public.recurring_deductions(id) on delete restrict,
  entity_id uuid not null references public.entities(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  paid_on date not null,
  amount numeric(12,2) not null constraint advance_repayments_amount_check check (amount > 0),
  notes text not null default '' constraint advance_repayments_notes_check check (length(notes) <= 500),
  recorded_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index advance_repayments_advance_idx on public.advance_repayments (advance_id);
create index advance_repayments_entity_idx on public.advance_repayments (entity_id);
create index advance_repayments_employee_idx on public.advance_repayments (employee_id);

-- Same writer order as attendance: the employee's payroll lock first (finalize
-- takes it before the advance rows), then the advance row.
create or replace function public.guard_advance_repayment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_adv recurring_deductions;
begin
  if tg_op = 'UPDATE' then
    raise exception 'A recorded repayment can''t be edited; remove it and record it again.';
  end if;
  if tg_op = 'DELETE' then
    perform pg_advisory_xact_lock(hashtextextended('time_entries:' || old.employee_id::text, 0));
    perform set_config('payroll.advance_repayment', 'on', true);
    update recurring_deductions
      set balance = balance + old.amount,
          -- re-activate only what reached zero (a manual pause stays)
          active = active or balance <= 0
      where id = old.advance_id;
    perform set_config('payroll.advance_repayment', '', true);
    return old;
  end if;
  select employee_id into new.employee_id from recurring_deductions where id = new.advance_id;
  if new.employee_id is null then
    raise exception 'Cash advance not found.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' || new.employee_id::text, 0));
  select * into v_adv from recurring_deductions where id = new.advance_id for update;
  if v_adv.category <> 'cash_advance' then
    raise exception 'Repayments are recorded against cash advances only.';
  end if;
  select entity_id into new.entity_id from employees where id = new.employee_id;
  if new.amount > v_adv.balance then
    raise exception 'The repayment (%) is more than what is left of this advance (%).', new.amount, v_adv.balance;
  end if;
  new.recorded_by := coalesce(auth.uid(), new.recorded_by);
  return new;
end
$$;
create trigger advance_repayments_guard before insert or update or delete on public.advance_repayments
  for each row execute function public.guard_advance_repayment();

-- the balance moves only once the insert passed row-level security
create or replace function public.apply_advance_repayment()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform set_config('payroll.advance_repayment', 'on', true);
  update recurring_deductions
    set balance = balance - new.amount,
        active = active and balance - new.amount > 0
    where id = new.advance_id;
  perform set_config('payroll.advance_repayment', '', true);
  return new;
end
$$;
create trigger advance_repayments_apply after insert on public.advance_repayments
  for each row execute function public.apply_advance_repayment();

alter table public.advance_repayments enable row level security;
create policy "advance_repayments: admins manage" on public.advance_repayments
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));
create policy "advance_repayments: read own" on public.advance_repayments
  for select to authenticated using (employee_id = public.current_employee_id());

create trigger audit_advance_repayments
  after insert or delete on public.advance_repayments
  for each row execute function public.audit_trigger();

-- ---------- approving a request = recording its advance, in one step ----------
create or replace function public.approve_advance_request(
  p_request uuid,
  p_amount numeric,
  p_per_payroll numeric,
  p_released_on date,
  p_first_deduction date,
  p_release_method text,
  p_authorized_on date,
  p_notes text default ''
)
returns public.recurring_deductions
language plpgsql security definer set search_path = public
as $$
declare
  v_req advance_requests;
  v_adv recurring_deductions;
begin
  select * into v_req from advance_requests where id = p_request;
  if v_req.id is null or not public.can_manage_entity(v_req.entity_id) then
    raise exception 'Request not found.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' || v_req.employee_id::text, 0));
  select * into v_req from advance_requests where id = p_request for update;
  if v_req.status <> 'pending' then
    raise exception 'This request is no longer pending (the employee may have cancelled it).';
  end if;
  if p_amount is null or p_amount <= 0 or p_per_payroll is null or p_per_payroll <= 0 then
    raise exception 'Enter the amount released and the deduction per payroll.';
  end if;
  if p_per_payroll > p_amount then
    raise exception 'The deduction per payroll can''t be more than the advance.';
  end if;
  if p_released_on is null then
    raise exception 'Enter the date the cash advance was released.';
  end if;
  insert into recurring_deductions (employee_id, label, category, amount_per_period, total_amount, balance,
                                    start_date, active, released_on, release_method, authorized_on, notes)
  values (v_req.employee_id, 'Cash advance (' || to_char(p_released_on, 'FMMon FMDD, YYYY') || ')', 'cash_advance',
          p_per_payroll, p_amount, p_amount, coalesce(p_first_deduction, p_released_on), true,
          p_released_on, p_release_method, p_authorized_on, coalesce(p_notes, ''))
  returning * into v_adv;
  update advance_requests
    set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
        review_notes = nullif(btrim(coalesce(p_notes, '')), ''), advance_id = v_adv.id
    where id = p_request;
  return v_adv;
end
$$;

-- trigger functions are not API endpoints; the approval is, for signed-in users (it checks the caller's client)
revoke execute on function public.guard_cash_advance() from public, anon, authenticated;
revoke execute on function public.guard_advance_request() from public, anon, authenticated;
revoke execute on function public.guard_advance_repayment() from public, anon, authenticated;
revoke execute on function public.apply_advance_repayment() from public, anon, authenticated;
revoke execute on function public.approve_advance_request(uuid, numeric, numeric, date, date, text, date, text) from public, anon;
grant execute on function public.approve_advance_request(uuid, numeric, numeric, date, date, text, date, text) to authenticated;
