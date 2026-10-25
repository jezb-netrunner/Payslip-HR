-- Spec T8 (payroll tax rules spec, 2026-10-25): year-end adjustment
-- additions.
--
-- A shortfall found by the year-end adjustment is withheld only up to the
-- net pay available. The employer pays the rest (RR 2-98 Sec. 2.79(B)(5)(b)
-- Step 4, as amended by RR 11-2018 Sec. 7) and it is an advance to the
-- employee, a matter of settlement between them. The payslip records the
-- amount (tax_paid_by_employer). Finalizing the run records the advance as a
-- paused cash advance without a signed authorization, so payroll never
-- deducts it until an admin records the employee's written authorization
-- and resumes it. Reopening the run removes it, unless part of it was
-- already repaid. The amount and release of such an advance come from its
-- payroll only.

alter table public.payslips
  add column tax_paid_by_employer numeric(12,2) not null default 0
    constraint payslips_tax_paid_by_employer_check
      check (tax_paid_by_employer >= 0 and (tax_paid_by_employer = 0 or wht_method = 'annualized'));

alter table public.recurring_deductions
  add column source_run_id uuid references public.payroll_runs (id);
create index recurring_deductions_source_run_idx on public.recurring_deductions (source_run_id)
  where source_run_id is not null;

-- ---------- finalize records the advance, reopen removes it ----------
create or replace function public.sync_tax_advances()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_names text;
begin
  if old.status = 'draft' and new.status = 'finalized' then
    insert into recurring_deductions
      (employee_id, label, category, amount_per_period, total_amount, balance, active, released_on, notes, source_run_id)
    select p.employee_id,
           'Tax paid by employer (' || extract(year from p.pay_date)::int || ' year-end adjustment)',
           'cash_advance', 0, p.tax_paid_by_employer, p.tax_paid_by_employer, false, p.pay_date,
           'The year-end adjustment found more tax due than this pay could cover. The employer pays the rest with the month''s 1601-C (RR 2-98 Sec. 2.79(B)(5)(b) Step 4) and it is an advance to the employee, settled between employee and employer. It is never withheld as tax from later pay. To deduct it from pay, record the date the employee signed the authorization, then resume deductions.',
           new.id
      from payslips p
      where p.payroll_run_id = new.id and p.tax_paid_by_employer > 0;
  elsif old.status in ('finalized', 'paid') and new.status = 'draft' then
    select string_agg(distinct e.first_name || ' ' || e.last_name, ', ') into v_names
      from recurring_deductions d join employees e on e.id = d.employee_id
      where d.source_run_id = new.id and d.balance is distinct from d.total_amount;
    if v_names is not null then
      raise exception 'Part of the tax the employer paid for % at this run''s year-end adjustment has already been repaid (by payroll or a recorded repayment). Reopen those payrolls or remove those repayments first, then reopen this run.', v_names;
    end if;
    delete from recurring_deductions where source_run_id = new.id;
  end if;
  return null;
end
$$;
revoke execute on function public.sync_tax_advances() from public, anon, authenticated;
create trigger payroll_runs_tax_advances after update of status on public.payroll_runs
  for each row execute function public.sync_tax_advances();

-- ---------- the advance's amount and release come from its payroll ----------
create or replace function public.guard_tax_advance()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_trusted boolean := coalesce(current_setting('payroll.lifecycle', true), '') = 'on'
                       or coalesce(current_setting('payroll.advance_repayment', true), '') = 'on';
begin
  if v_trusted then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    if new.source_run_id is not null then
      raise exception 'Tax the employer paid at a year-end adjustment is recorded by finalizing that payroll.';
    end if;
    return new;
  end if;
  if old.source_run_id is null then
    if tg_op = 'UPDATE' and new.source_run_id is not null then
      raise exception 'Tax the employer paid at a year-end adjustment is recorded by finalizing that payroll.';
    end if;
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'This advance is tax the employer paid at a year-end adjustment: it stays on record (pause it or record repayments). Reopening that payroll removes it.';
  end if;
  if (new.source_run_id, new.employee_id, new.category, new.total_amount, new.released_on)
     is distinct from (old.source_run_id, old.employee_id, old.category, old.total_amount, old.released_on) then
    raise exception 'The amount and release of tax the employer paid at a year-end adjustment come from that payroll. Reopen it to change them.';
  end if;
  return new;
end
$$;
revoke execute on function public.guard_tax_advance() from public, anon, authenticated;
create trigger recurring_deductions_tax_advance before insert or update or delete on public.recurring_deductions
  for each row execute function public.guard_tax_advance();
