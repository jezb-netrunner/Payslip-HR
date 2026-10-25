-- Spec T1 (payroll tax rules spec, 2026-10-25): the de minimis ceilings
-- become a dated statutory table version, like the tax tables.
--
--   * kind de_minimis joins the statutory kinds
--   * the first-of-month rule now covers the contribution tables only. They
--     follow the payroll month, while BIR tables follow the pay date, and
--     RR 29-2025 applies to pay dated 2026-01-07 and later
--   * the database checks the ceilings: items a and c to k once each, every
--     ceiling positive, the meal-allowance share of the minimum wage at most 1
--
-- The withholding and annual tables on file were checked row for row against
-- the spec and match it, so they don't change (supabase/tests/17).
--
-- Applying it live: the constraint swaps below use DROP CONSTRAINT, which the
-- Supabase MCP treats as destructive (see MEMORY.md), so the owner runs this
-- file in the dashboard SQL editor and the session records it in the
-- migration history.

alter table public.statutory_versions drop constraint if exists statutory_versions_kind_check;
alter table public.statutory_versions add constraint statutory_versions_kind_check
  check (kind in ('sss', 'philhealth', 'pagibig', 'bir_wht', 'bir_annual', 'de_minimis'));

alter table public.statutory_versions drop constraint if exists statutory_versions_month_start;
alter table public.statutory_versions add constraint statutory_versions_month_start
  check (kind not in ('sss', 'philhealth', 'pagibig') or extract(day from effective_from) = 1);

-- Basis: RR 2-98 Sec. 2.78.1(A)(3), as amended by RR 29-2025 Sec. 1
create or replace function public.valid_de_minimis(d jsonb)
returns boolean
language plpgsql immutable set search_path = public
as $$
declare
  r jsonb;
  v_items text[] := '{}';
begin
  if d is null or jsonb_typeof(d->'items') is distinct from 'array' then
    return false;
  end if;
  for r in select value from jsonb_array_elements(d->'items') loop
    if jsonb_typeof(r->'item') is distinct from 'string' or jsonb_typeof(r->'unit') is distinct from 'string'
       or jsonb_typeof(r->'limit') is distinct from 'number' or jsonb_typeof(r->'label') is distinct from 'string' then
      return false;
    end if;
    if length(btrim(r->>'label')) = 0 or (r->>'limit')::numeric <= 0 then
      return false;
    end if;
    if r->>'unit' not in ('days_per_year', 'per_month', 'per_semester', 'per_year', 'share_of_regional_minimum_wage') then
      return false;
    end if;
    if r->>'unit' = 'share_of_regional_minimum_wage' and (r->>'limit')::numeric > 1 then
      return false;
    end if;
    if r ? 'per_month' and (jsonb_typeof(r->'per_month') is distinct from 'number' or (r->>'per_month')::numeric <= 0) then
      return false;
    end if;
    v_items := v_items || (r->>'item');
  end loop;
  -- (b) is for government employees only
  return cardinality(v_items) = 10
    and (select array_agg(i order by i) from unnest(v_items) i) = array['a', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
end
$$;

create or replace function public.valid_statutory_data(p_kind text, d jsonb)
returns boolean
language plpgsql immutable set search_path = public
as $$
declare
  k text;
begin
  if d is null or jsonb_typeof(d) <> 'object' then
    return false;
  end if;
  if p_kind = 'sss' then
    foreach k in array array['rate_ee','rate_er','msc_min','msc_max','msc_step','mpf_threshold','ec_er_low','ec_er_high','ec_threshold_msc'] loop
      if jsonb_typeof(d->k) is distinct from 'number' then
        return false;
      end if;
    end loop;
    return (d->>'rate_ee')::numeric > 0 and (d->>'rate_ee')::numeric <= 0.2
      and (d->>'rate_er')::numeric > 0 and (d->>'rate_er')::numeric <= 0.2
      and (d->>'msc_min')::numeric > 0 and (d->>'msc_step')::numeric > 0
      and (d->>'msc_max')::numeric > (d->>'msc_min')::numeric
      and mod((d->>'msc_max')::numeric - (d->>'msc_min')::numeric, (d->>'msc_step')::numeric) = 0
      and (d->>'mpf_threshold')::numeric between (d->>'msc_min')::numeric and (d->>'msc_max')::numeric
      and (d->>'ec_threshold_msc')::numeric between (d->>'msc_min')::numeric and (d->>'msc_max')::numeric
      and (d->>'ec_er_low')::numeric between 0 and 100 and (d->>'ec_er_high')::numeric between 0 and 100;
  elsif p_kind = 'philhealth' then
    foreach k in array array['rate','floor','ceiling'] loop
      if jsonb_typeof(d->k) is distinct from 'number' then
        return false;
      end if;
    end loop;
    return (d->>'rate')::numeric > 0 and (d->>'rate')::numeric <= 0.1
      and (d->>'floor')::numeric > 0 and (d->>'ceiling')::numeric > (d->>'floor')::numeric;
  elsif p_kind = 'pagibig' then
    foreach k in array array['max_fund_salary','ee_rate_low','ee_rate_high','low_threshold','er_rate'] loop
      if jsonb_typeof(d->k) is distinct from 'number' then
        return false;
      end if;
    end loop;
    return (d->>'max_fund_salary')::numeric > 0 and (d->>'low_threshold')::numeric > 0
      and (d->>'ee_rate_low')::numeric > 0 and (d->>'ee_rate_low')::numeric <= 0.1
      and (d->>'ee_rate_high')::numeric >= (d->>'ee_rate_low')::numeric and (d->>'ee_rate_high')::numeric <= 0.1
      and (d->>'er_rate')::numeric > 0 and (d->>'er_rate')::numeric <= 0.1;
  elsif p_kind = 'bir_wht' then
    return public.valid_tax_brackets(d->'daily') and public.valid_tax_brackets(d->'weekly')
      and public.valid_tax_brackets(d->'semi_monthly') and public.valid_tax_brackets(d->'monthly');
  elsif p_kind = 'bir_annual' then
    return public.valid_tax_brackets(d->'brackets')
      and jsonb_typeof(d->'other_benefits_exemption_cap') = 'number'
      and (d->>'other_benefits_exemption_cap')::numeric >= 0;
  elsif p_kind = 'de_minimis' then
    return public.valid_de_minimis(d);
  end if;
  return false;
end
$$;

revoke execute on function public.valid_de_minimis(jsonb) from public, anon;

-- the ceilings as the spec gives them (T1), for pay dated 2026-01-07 and later
insert into public.statutory_versions (kind, effective_from, effective_to, description, source_url, legal_basis, verified_on, data)
values (
  'de_minimis', '2026-01-07', null,
  'De minimis benefit ceilings for private employees. An amount above its ceiling counts toward the P90,000 exemption for 13th month pay and other benefits. RR 29-2025 takes effect after fifteen days following its publication (posted on the BIR website 2025-12-22), so it applies to pay dated 2026-01-07 and later. Item (b) is for government employees only.',
  'https://www.bir.gov.ph',
  'RR 2-98 Sec. 2.78.1(A)(3), as amended by RR 29-2025 Sec. 1 (dated Oct 27, 2025)',
  '2026-10-25',
  '{"items":[
    {"item":"a","label":"Cash conversion of unused vacation leave credits (private employees)","unit":"days_per_year","limit":12},
    {"item":"c","label":"Medical cash allowance to dependents of employees","unit":"per_semester","limit":2000,"per_month":333},
    {"item":"d","label":"Rice subsidy (or one 50-kg sack a month worth up to the ceiling)","unit":"per_month","limit":2500},
    {"item":"e","label":"Uniform and clothing allowance","unit":"per_year","limit":8000},
    {"item":"f","label":"Actual medical assistance","unit":"per_year","limit":12000},
    {"item":"g","label":"Laundry allowance","unit":"per_month","limit":400},
    {"item":"h","label":"Employee achievement awards under a written plan","unit":"per_year","limit":12000},
    {"item":"i","label":"Christmas and major anniversary gifts","unit":"per_year","limit":6000},
    {"item":"j","label":"Daily meal allowance for overtime work and night or graveyard shift","unit":"share_of_regional_minimum_wage","limit":0.30},
    {"item":"k","label":"CBA benefits and productivity incentives, combined","unit":"per_year","limit":12000}
  ]}'::jsonb
)
on conflict (kind, effective_from) do nothing;
