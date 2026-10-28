-- C4 (compliance update 2026-10-25): de minimis ceilings for payments from
-- 6 January 2026 (RR 2-98 Sec. 2.78.1(A)(3) as amended by RR 29-2025 Sec. 1,
-- effective 15 days after posting on 22 December 2025 per Sec. 3). The list
-- is exclusive (RR 5-2011 Sec. 1): any benefit not on it is taxable.

-- ---------- legal parameters: versioned reference data beside the statutory tables ----------
-- Same rules as statutory_versions: shipped as migrations, read-only for every
-- API role, each version documented, frozen once a finalized payroll may
-- have used it. Unlike the contribution tables, a version may start on any
-- day (RR 29-2025 applies to payments from 6 January).
create table if not exists public.legal_parameters (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key in ('de_minimis')),
  effective_from date not null,
  data jsonb not null,
  description text not null check (length(btrim(description)) > 0),
  legal_basis text not null check (length(btrim(legal_basis)) > 0),
  source_url text not null check (source_url ~ '^https://'),
  verified_on date,
  created_at timestamptz not null default now(),
  unique (key, effective_from)
);

alter table public.legal_parameters enable row level security;
create policy "legal parameters: read all" on public.legal_parameters
  for select to authenticated using (true);
revoke all on public.legal_parameters from anon;
revoke insert, update, delete, truncate on public.legal_parameters from authenticated;

-- every ceiling present, a positive number, on a known basis
create or replace function public.valid_legal_parameter(p_key text, d jsonb)
returns boolean
language plpgsql immutable set search_path = public
as $$
declare
  k text;
  c jsonb;
begin
  if p_key <> 'de_minimis' or d is null or jsonb_typeof(d->'ceilings') is distinct from 'object' then
    return false;
  end if;
  foreach k in array array['monetized_vl','medical_dependents','rice','uniform','medical_assistance','laundry',
                           'achievement_award','christmas_gift','meal_ot','cba_productivity'] loop
    c := d->'ceilings'->k;
    if jsonb_typeof(c->'limit') is distinct from 'number' or (c->>'limit')::numeric <= 0
       or coalesce(c->>'per', '') not in ('month','semester','year','days_year','ot_day_of_minimum_wage') then
      return false;
    end if;
  end loop;
  return true;
end
$$;
alter table public.legal_parameters
  add constraint legal_parameters_data_check check (public.valid_legal_parameter(key, data));

-- a version finalized payrolls may have used (by pay date) is frozen, like the statutory tables
create or replace function public.guard_legal_parameter()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(current_setting('statutory.correction', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.key = old.key and new.effective_from = old.effective_from and new.data = old.data then
    return new;
  end if;
  if exists (select 1 from payroll_runs r where r.status in ('finalized', 'paid') and r.pay_date >= old.effective_from) then
    raise exception 'Finalized payrolls may have used the % parameters effective %, so they are frozen. Ship a new version instead.', old.key, old.effective_from;
  end if;
  return coalesce(new, old);
end
$$;
create trigger legal_parameters_guard_change before update or delete on public.legal_parameters
  for each row execute function public.guard_legal_parameter();
revoke execute on function public.guard_legal_parameter() from public, anon, authenticated;

-- a new or corrected version: drafts paid on or after it compute again
-- (like the statutory tables)
create or replace function public.stale_drafts_on_legal_parameter()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_from date;
begin
  if tg_op = 'INSERT' then
    v_from := new.effective_from;
  elsif tg_op = 'DELETE' then
    v_from := old.effective_from;
  else
    v_from := least(new.effective_from, old.effective_from);
  end if;
  update payroll_runs set totals = '{}'::jsonb
    where status = 'draft' and totals <> '{}'::jsonb and pay_date >= v_from;
  return coalesce(new, old);
end
$$;
create trigger legal_parameters_stale after insert or update or delete on public.legal_parameters
  for each row execute function public.stale_drafts_on_legal_parameter();
revoke execute on function public.stale_drafts_on_legal_parameter() from public, anon, authenticated;
revoke execute on function public.valid_legal_parameter(text, jsonb) from public, anon;

insert into public.legal_parameters (key, effective_from, data, description, legal_basis, source_url)
values (
  'de_minimis', '2026-01-06',
  '{"ceilings": {
     "monetized_vl": {"limit": 12, "per": "days_year"},
     "medical_dependents": {"limit": 2000, "per": "semester"},
     "rice": {"limit": 2500, "per": "month"},
     "uniform": {"limit": 8000, "per": "year"},
     "medical_assistance": {"limit": 12000, "per": "year"},
     "laundry": {"limit": 400, "per": "month"},
     "achievement_award": {"limit": 12000, "per": "year"},
     "christmas_gift": {"limit": 6000, "per": "year"},
     "meal_ot": {"limit": 0.3, "per": "ot_day_of_minimum_wage"},
     "cba_productivity": {"limit": 12000, "per": "year"}}}',
  'De minimis ceilings for payments from 6 Jan 2026: monetized unused VL 12 days a year, medical cash allowance to dependents 2,000 a semester, rice 2,500 a month, uniform 8,000 a year, actual medical assistance 12,000 a year, laundry 400 a month, achievement awards 12,000 a year, Christmas and anniversary gifts 6,000 a year, overtime or night-shift meals 30% of the regional minimum wage a day, CBA benefits and productivity incentives 12,000 a year combined',
  'RR 2-98 Sec. 2.78.1(A)(3) as amended by RR 29-2025 Sec. 1 (effective 15 days after posting on 22 Dec 2025, Sec. 3), RR 5-2011 Sec. 1 (the list is exclusive)',
  'https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%2029-2025.pdf'
)
on conflict (key, effective_from) do nothing;

-- ---------- which de minimis benefit a pay item is ----------
alter table public.employee_allowances
  add column if not exists de_minimis_kind text
    constraint employee_allowances_de_minimis_kind_check check (de_minimis_kind in
      ('medical_dependents','rice','uniform','medical_assistance','laundry','achievement_award',
       'christmas_gift','meal_ot','cba_productivity')),
  add constraint employee_allowances_de_minimis_named check (
    (category = 'de_minimis') = (de_minimis_kind is not null)) not valid;
-- A recurring de minimis allowance saved before this rule names no benefit,
-- so it is taxable compensation: it becomes "Other taxable allowance" (none
-- on the live database) and the admin picks the benefit to exempt it again.
-- A check left NOT VALID would still reject every later edit of the row.
update public.employee_allowances
  set category = 'other_taxable'
  where category = 'de_minimis' and de_minimis_kind is null;
alter table public.employee_allowances validate constraint employee_allowances_de_minimis_named;

-- one-time items: the benefit, and for unused leave converted to cash the days
alter table public.payroll_adjustments
  add column if not exists de_minimis_kind text
    constraint payroll_adjustments_de_minimis_kind_check check (de_minimis_kind in
      ('monetized_vl','medical_dependents','rice','uniform','medical_assistance','laundry','achievement_award',
       'christmas_gift','meal_ot','cba_productivity')),
  add column if not exists leave_days numeric(6,2)
    constraint payroll_adjustments_leave_days_check check (leave_days > 0 and leave_days <= 365),
  -- NOT VALID: one-time items of payrolls already computed stay as they are
  -- (no database function updates them, and editing one asks for the benefit)
  add constraint payroll_adjustments_de_minimis_named check (
    kind <> 'earning' or (category = 'de_minimis') = (de_minimis_kind is not null)) not valid,
  add constraint payroll_adjustments_leave_conversion check (
    (de_minimis_kind = 'monetized_vl') = (leave_days is not null));

-- ---------- leave converted to cash ----------
-- A client granting 5 or more days of paid vacation leave a year is outside
-- the service incentive leave (Labor Code Art. 95(b)): its unused VL
-- converted to cash is de minimis up to the yearly ceiling. A client giving
-- only the 5-day SIL: SIL converted to cash is taxable unless it decides
-- otherwise (open item O7).
alter table public.entities
  add column if not exists paid_vl_days_per_year numeric(5,2) not null default 0
    constraint entities_paid_vl_days_check check (paid_vl_days_per_year between 0 and 365),
  add column if not exists sil_conversion_taxable boolean not null default true;
