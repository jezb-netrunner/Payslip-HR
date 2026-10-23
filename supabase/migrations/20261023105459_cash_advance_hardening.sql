-- Cash advance hardening (audit 2026-10-23).
--
-- 1. The balance stays between zero and the amount released even inside
--    finalize and reopen. A draft computed from an older balance (a
--    repayment recorded while it was being computed) is refused at finalize
--    instead of deducting more than the employee owes.
-- 2. Repayments no longer touch "active". It is the admin's pause switch,
--    and payroll already skips an advance with nothing left to pay. Removing
--    a repayment so never resumes a paused advance.
-- 3. The release and signed-authorization dates can't be cleared once
--    recorded, and the first deduction can't come before the release.

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
    raise exception 'A deduction can''t be turned into a cash advance or back. Record cash advances under Cash Advances.';
  end if;
  if new.category <> 'cash_advance' then
    return new;
  end if;

  -- payroll and repayments included: never below zero, never above the amount released
  if new.balance < 0 or new.balance > new.total_amount then
    raise exception 'This would leave "%" with a balance of % (it must stay between 0 and %). Recompute the draft payroll, then try again.',
      new.label, new.balance, new.total_amount;
  end if;
  if v_trusted then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.total_amount is null or new.total_amount <= 0 or new.balance is distinct from new.total_amount then
      raise exception 'A cash advance starts with its balance equal to the amount released.';
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
  -- the record of the release and of the signed authorization stays complete
  if new.released_on is null then
    raise exception 'Enter the date the cash advance was released.';
  end if;
  if new.authorized_on is null then
    raise exception 'Record the date the employee signed the written authorization to deduct the advance from their pay.';
  end if;
  if new.start_date is not null and new.start_date < new.released_on then
    raise exception 'The first deduction can''t come before the release.';
  end if;
  if new.amount_per_period is null or new.amount_per_period <= 0 then
    raise exception 'Enter the amount to deduct per payroll.';
  end if;
  return new;
end
$$;

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
    raise exception 'A recorded repayment can''t be edited. Remove it and record it again.';
  end if;
  if tg_op = 'DELETE' then
    perform pg_advisory_xact_lock(hashtextextended('time_entries:' || old.employee_id::text, 0));
    perform set_config('payroll.advance_repayment', 'on', true);
    update recurring_deductions
      set balance = balance + old.amount
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

-- the balance moves only once the insert passed row-level security
create or replace function public.apply_advance_repayment()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform set_config('payroll.advance_repayment', 'on', true);
  update recurring_deductions
    set balance = balance - new.amount
    where id = new.advance_id;
  perform set_config('payroll.advance_repayment', '', true);
  return new;
end
$$;
