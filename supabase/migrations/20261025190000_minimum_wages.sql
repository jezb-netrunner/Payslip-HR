-- Spec T12 (payroll tax rules spec, 2026-10-25): statutory minimum wage
-- history, the MWE re-test and the holiday-pay setting.
--
-- The statutory minimum wage (SMW) is "the rate fixed by the Regional
-- Tripartite Wage and Productivity Board" (RR 2-98 Sec. 2.78.1(B)(13),
-- RMC 50-2018 A14). Company admins keep the rates here, by region and
-- sector ('' = the region's general rate), with each wage order's dates and
-- reference. No rate ships with this migration: none is seeded from memory,
-- and until a region's rates are entered payroll uses the client's own
-- minimum wage setting (and says so). Payroll computes MWE status for each
-- pay period from the rate in force on its last day (the employee checkbox
-- is no longer used). A rate added or changed with a past date marks the
-- region's draft payrolls from that date for recomputing. Finalized
-- payrolls stay as they are and the year-end adjustment re-tests them.
--
-- WAGE_ORDER_TOPUP pays the difference a wage order adds for days already
-- paid at the old rate: basic pay, so statutory minimum wage for an MWE
-- and regular compensation for others. The rule that an unworked regular
-- holiday after an unpaid absence isn't paid becomes a client setting
-- (labor rule, not checked by the spec's author).

create table public.minimum_wages (
  id uuid primary key default gen_random_uuid(),
  region text not null constraint minimum_wages_region_check check (length(trim(region)) between 1 and 20),
  sector text not null default ''
    constraint minimum_wages_sector_check check (length(sector) <= 100 and sector = trim(sector)),
  daily_rate numeric(10,2) not null constraint minimum_wages_daily_rate_check check (daily_rate > 0 and daily_rate < 100000),
  effective_from date not null,
  effective_to date,
  wage_order_ref text not null
    constraint minimum_wages_wage_order_ref_check check (length(trim(wage_order_ref)) between 1 and 200),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint minimum_wages_dates check (effective_to is null or effective_to >= effective_from),
  constraint minimum_wages_once unique (region, sector, effective_from)
);
create trigger minimum_wages_updated_at before update on public.minimum_wages
  for each row execute function public.set_updated_at();
create trigger audit_minimum_wages after insert or update or delete on public.minimum_wages
  for each row execute function public.audit_trigger();
alter table public.minimum_wages enable row level security;
create policy "minimum wages: read all" on public.minimum_wages for select to authenticated using (true);
create policy "minimum wages: company admins add" on public.minimum_wages for insert to authenticated
  with check (public.is_company_admin());
create policy "minimum wages: company admins change" on public.minimum_wages for update to authenticated
  using (public.is_company_admin()) with check (public.is_company_admin());
create policy "minimum wages: company admins remove" on public.minimum_wages for delete to authenticated
  using (public.is_company_admin());
revoke all on public.minimum_wages from anon;

-- a rate added, changed or removed: the region's drafts from its date are recomputed
create or replace function public.stale_drafts_on_minimum_wage()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_entity uuid;
  v_from date;
  v_region text;
begin
  foreach v_region in array array_remove(array[
      case when tg_op <> 'INSERT' then old.region end,
      case when tg_op <> 'DELETE' then new.region end], null) loop
    v_from := least(
      case when tg_op <> 'INSERT' and old.region = v_region then old.effective_from end,
      case when tg_op <> 'DELETE' and new.region = v_region then new.effective_from end);
    for v_entity in select id from entities where minimum_wage_region = v_region loop
      perform mark_payroll_drafts_stale(v_entity, null, v_from, null);
    end loop;
  end loop;
  return null;
end
$$;
revoke execute on function public.stale_drafts_on_minimum_wage() from public, anon, authenticated;
create trigger minimum_wages_stale after insert or update or delete on public.minimum_wages
  for each row execute function public.stale_drafts_on_minimum_wage();

-- ---------- the client's sector and holiday-pay setting ----------
alter table public.entities
  add column minimum_wage_sector text not null default ''
    constraint entities_minimum_wage_sector_check check (length(minimum_wage_sector) <= 100 and minimum_wage_sector = trim(minimum_wage_sector)),
  add column holiday_pay_after_absence text not null default 'apply_rule'
    constraint entities_holiday_pay_after_absence_check check (holiday_pay_after_absence in ('apply_rule', 'pay_anyway'));

comment on column public.employees.is_minimum_wage_earner is
  'Unused since spec T12: payroll computes MWE status per pay period from minimum_wages. Drop once the T12 front end is live.';

-- ---------- WAGE_ORDER_TOPUP ----------
insert into public.pay_codes
  (sort_order, code, label, for_allowances, for_one_time, bir_bucket, income_class, tax_treatment, sss_include, sss_include_pending,
   include_in_13th_month_base, description) values
(12, 'WAGE_ORDER_TOPUP', 'Wage order top-up', false, true, 'basic', 'regular', 'mwe_exempt', true, false, true,
  'The difference a new wage order adds to basic pay, for days already paid at the old rate. For a minimum wage earner it is statutory minimum wage (exempt), for others regular compensation.');
