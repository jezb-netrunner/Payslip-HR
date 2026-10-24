-- Per-payroll deduction amounts (owner, 2026-10-24: advances are informal in
-- small businesses, so what a cutoff deducts for an earlier advance differs
-- from payroll to payroll). A draft payroll can set the amount it deducts
-- for any of an employee's recurring deductions (a cash advance, a loan,
-- anything with an installment) in place of the usual one; 0 skips it for
-- that payroll. A cash advance may also have no fixed installment at all
-- (amount_per_period = 0): payrolls then deduct only what is set for them,
-- and the payroll that settles a separation still takes the whole balance.
--
-- Finalize needs no change: it moves balances by the payslip lines, which
-- carry what was actually deducted. The signed authorization still comes
-- first (guard_cash_advance); its printed terms say how amounts are agreed.

create table public.payroll_deduction_overrides (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  deduction_id uuid not null references public.recurring_deductions(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  amount numeric(12,2) not null
    constraint payroll_deduction_overrides_amount_check check (amount >= 0 and amount <= 10000000),
  note text not null default '' constraint payroll_deduction_overrides_note_check check (length(note) <= 300),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_deduction_overrides_one unique (payroll_run_id, deduction_id)
);
create index payroll_deduction_overrides_deduction_idx on public.payroll_deduction_overrides (deduction_id);
create index payroll_deduction_overrides_employee_idx on public.payroll_deduction_overrides (employee_id);
create trigger payroll_deduction_overrides_updated_at before update on public.payroll_deduction_overrides
  for each row execute function public.set_updated_at();

-- Same locks and order as one-time adjustments: the employee's payroll lock,
-- then the run row (FOR NO KEY UPDATE, see 20261020040519).
create or replace function public.guard_payroll_deduction_override()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_run payroll_runs;
  v_ded recurring_deductions;
  v_emp uuid;
begin
  if tg_op = 'UPDATE' and (new.payroll_run_id is distinct from old.payroll_run_id
                           or new.deduction_id is distinct from old.deduction_id) then
    raise exception 'A payroll''s deduction amount cannot move to another run or deduction.';
  end if;
  if tg_op = 'DELETE' then
    v_emp := old.employee_id;
  else
    select * into v_ded from recurring_deductions where id = new.deduction_id;
    if v_ded.id is null then
      raise exception 'Deduction not found.';
    end if;
    v_emp := v_ded.employee_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('time_entries:' || v_emp::text, 0));
  select * into v_run from payroll_runs
    where id = case when tg_op = 'DELETE' then old.payroll_run_id else new.payroll_run_id end
    for no key update;
  -- (a run being deleted is already gone: its cascade passes through)
  if v_run.id is not null and v_run.status <> 'draft' then
    raise exception 'Deductions of a finalized payroll run are locked. Reopen the run first.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if v_run.id is null then
    raise exception 'Payroll run not found.';
  end if;
  if v_run.run_type = 'thirteenth_month' then
    raise exception 'A 13th month payroll makes no deductions.';
  end if;
  if not exists (select 1 from employees where id = v_emp and entity_id = v_run.entity_id) then
    raise exception 'Employee does not belong to this payroll run''s client.';
  end if;
  if v_ded.balance is not null and new.amount > v_ded.balance then
    raise exception 'This payroll can deduct at most % for "%" (what is left of it).', v_ded.balance, v_ded.label;
  end if;
  new.employee_id := v_emp;
  new.entity_id := v_run.entity_id;
  new.created_by := case when tg_op = 'INSERT' then coalesce(auth.uid(), new.created_by) else old.created_by end;
  return new;
end
$$;
create trigger payroll_deduction_overrides_guard before insert or update or delete on public.payroll_deduction_overrides
  for each row execute function public.guard_payroll_deduction_override();

alter table public.payroll_deduction_overrides enable row level security;
create policy "payroll_deduction_overrides: admins manage" on public.payroll_deduction_overrides
  for all to authenticated
  using (public.can_manage_entity(entity_id)) with check (public.can_manage_entity(entity_id));

create trigger audit_payroll_deduction_overrides
  after insert or update or delete on public.payroll_deduction_overrides
  for each row execute function public.audit_trigger();

-- the draft must be recomputed after its deduction amounts change
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
      when 'payroll_adjustments', 'payroll_deduction_overrides' then
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
create trigger payroll_deduction_overrides_stale after insert or update or delete on public.payroll_deduction_overrides
  for each row execute function public.stale_drafts_on_change();

-- ---------- cash advances without a fixed installment ----------
-- Same as 20261023105459_cash_advance_hardening except the installment may be 0.
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
  -- 0 = no fixed installment: each payroll deducts what is set for it
  if new.amount_per_period is null or new.amount_per_period < 0 then
    raise exception 'Enter the amount to deduct per payroll (0 = no fixed installment, set in each payroll).';
  end if;
  return new;
end
$$;

-- Same as 20261023102637_cash_advances except the installment may be 0.
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
  if p_amount is null or p_amount <= 0 or p_per_payroll is null or p_per_payroll < 0 then
    raise exception 'Enter the amount released and the deduction per payroll (0 = no fixed installment).';
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

revoke execute on function public.guard_payroll_deduction_override() from public, anon, authenticated;
