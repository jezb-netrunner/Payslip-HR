-- ============================================================
-- Fixes from the follow-up verification review:
-- 1. Finalize/reopen become ATOMIC database RPCs: the status flip
--    and the recurring-deduction balance adjustments happen in one
--    transaction, exactly once per transition (no double-decrement
--    on double-click, no half-applied state on network failure).
-- 2. Reopen only re-activates loans that were auto-deactivated at
--    zero balance — it never un-pauses a manually paused deduction.
-- 3. Admin profiles protected at the DB level: no admin can change
--    another admin's role/active flag or delete an admin profile,
--    and the last active administrator can never be removed
--    (closes the demote-then-hijack bypass of the edge function).
-- 4. Defensive backfill of the denormalized run columns on payslips.
-- ============================================================

-- ---------- backfill payslip run info (no-op on fresh installs) ----------
alter table public.payslips disable trigger payslips_immutable;
update public.payslips p
  set period_start = r.period_start,
      period_end   = r.period_end,
      pay_date     = r.pay_date,
      run_type     = r.run_type
  from public.payroll_runs r
  where r.id = p.payroll_run_id and p.period_start is null;
alter table public.payslips enable trigger payslips_immutable;

-- ---------- shared balance adjustment ----------
create or replace function public.adjust_run_deduction_balances(p_run uuid, p_direction int)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  r record;
begin
  for r in
    select (line->>'meta')::uuid as ded_id,
           sum((line->>'amount')::numeric) as amt
    from payslips p,
         jsonb_array_elements(p.deductions) as line
    where p.payroll_run_id = p_run
      and line->>'code' like 'other:%'
      and line->>'meta' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    group by 1
  loop
    update recurring_deductions
      set balance = balance + p_direction * r.amt,
          active = case
            -- finalize: auto-deactivate a loan that just reached zero
            when p_direction < 0 then active and (balance + p_direction * r.amt) > 0
            -- reopen: only re-activate what auto-deactivated at zero;
            -- never un-pause a manually paused deduction
            else active or (balance <= 0 and balance + p_direction * r.amt > 0)
          end
      where id = r.ded_id and balance is not null;
  end loop;
end
$$;
revoke execute on function public.adjust_run_deduction_balances(uuid, int) from public, anon, authenticated;

-- ---------- atomic finalize ----------
create or replace function public.finalize_payroll_run(p_run uuid)
returns public.payroll_runs
language plpgsql security definer set search_path = public
as $$
declare
  v_run payroll_runs;
begin
  if not is_admin() then
    raise exception 'Only administrators can finalize payroll runs.';
  end if;
  update payroll_runs
    set status = 'finalized', finalized_at = now(), finalized_by = auth.uid()
    where id = p_run and status = 'draft'
    returning * into v_run;
  if v_run.id is null then
    raise exception 'This run is not a draft — it may already be finalized.';
  end if;
  perform adjust_run_deduction_balances(p_run, -1);
  return v_run;
end
$$;

-- ---------- atomic reopen ----------
create or replace function public.reopen_payroll_run(p_run uuid)
returns public.payroll_runs
language plpgsql security definer set search_path = public
as $$
declare
  v_run payroll_runs;
begin
  if not is_admin() then
    raise exception 'Only administrators can reopen payroll runs.';
  end if;
  update payroll_runs
    set status = 'draft', finalized_at = null, finalized_by = null
    where id = p_run and status in ('finalized','paid')
    returning * into v_run;
  if v_run.id is null then
    raise exception 'This run is not finalized — nothing to reopen.';
  end if;
  perform adjust_run_deduction_balances(p_run, 1);
  return v_run;
end
$$;

revoke execute on function public.finalize_payroll_run(uuid) from public, anon;
revoke execute on function public.reopen_payroll_run(uuid) from public, anon;
grant execute on function public.finalize_payroll_run(uuid) to authenticated;
grant execute on function public.reopen_payroll_run(uuid) to authenticated;

-- ---------- admin profile protection ----------
create or replace function public.protect_admin_profiles()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_other_admins int;
begin
  if tg_op = 'DELETE' then
    if old.role = 'admin' then
      raise exception 'Administrator profiles cannot be deleted. Demote the account first.';
    end if;
    return old;
  end if;

  -- Nobody may change ANOTHER admin's role or active flag (closes the
  -- demote-then-hijack bypass of the edge function's co-admin guard).
  if old.role = 'admin' and old.id is distinct from auth.uid()
     and (new.role is distinct from old.role or new.is_active is distinct from old.is_active) then
    raise exception 'Another administrator''s role or active status cannot be changed.';
  end if;

  -- Never remove the last active administrator (self-demotion included).
  if old.role = 'admin' and (new.role <> 'admin' or new.is_active = false) then
    select count(*) into v_other_admins
      from profiles
      where role = 'admin' and is_active and id <> old.id;
    if v_other_admins = 0 then
      raise exception 'Cannot remove the last active administrator.';
    end if;
  end if;

  return new;
end
$$;
revoke execute on function public.protect_admin_profiles() from public, anon, authenticated;

drop trigger if exists profiles_protect_admins on public.profiles;
create trigger profiles_protect_admins
  before update or delete on public.profiles
  for each row execute function public.protect_admin_profiles();
