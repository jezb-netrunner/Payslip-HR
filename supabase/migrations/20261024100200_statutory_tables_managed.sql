-- Statutory tables become maintainer-managed reference data (owner,
-- 2026-10-24: "allowing the manual input of a New Version could lead to
-- misapplications and could be incorrect").
--
-- Industry practice for payroll software: tax and contribution tables ship
-- with the software. The maintainer verifies each version against the
-- agency's published table, tests it, and releases it with its effective
-- date; users read the tables but cannot edit them. So:
--   * no API role writes statutory_versions any more; new versions arrive as
--     migrations (the table owner), reviewed and tested like code;
--   * every version records its legal basis, its source and the date it was
--     last verified against that source;
--   * the database checks each version's shape and figures (a mistyped
--     bracket or a 50% rate is refused, whoever writes it);
--   * a version that a finalized payroll may have used is frozen — a real
--     mistake in it is corrected deliberately (set statutory.correction = on
--     in the correcting migration, then reopen the affected payrolls).

alter table public.statutory_versions
  add column if not exists legal_basis text not null default '',
  add column if not exists verified_on date;

-- ---------- reads only, for every API role ----------
revoke insert, update, delete, truncate on public.statutory_versions from anon, authenticated;
alter policy "statutory: company admin insert" on public.statutory_versions with check (false);
alter policy "statutory: company admin update" on public.statutory_versions using (false) with check (false);
alter policy "statutory: company admin delete" on public.statutory_versions using (false);

-- ---------- shape and figures ----------
-- brackets: start at 0 with no tax, ascending, rates 0–50%, and each base
-- equal to the previous base plus the previous rate on the step (within a
-- peso: the published tables round)
create or replace function public.valid_tax_brackets(b jsonb)
returns boolean
language plpgsql immutable set search_path = public
as $$
declare
  i int;
  r jsonb;
  v_over numeric;
  v_base numeric;
  v_rate numeric;
  p_over numeric;
  p_base numeric;
  p_rate numeric;
begin
  if b is null or jsonb_typeof(b) <> 'array' or jsonb_array_length(b) < 2 then
    return false;
  end if;
  for i in 0 .. jsonb_array_length(b) - 1 loop
    r := b->i;
    if jsonb_typeof(r->'over') is distinct from 'number' or jsonb_typeof(r->'base') is distinct from 'number'
       or jsonb_typeof(r->'rate') is distinct from 'number' then
      return false;
    end if;
    v_over := (r->>'over')::numeric;
    v_base := (r->>'base')::numeric;
    v_rate := (r->>'rate')::numeric;
    if v_rate < 0 or v_rate > 0.5 or v_base < 0 then
      return false;
    end if;
    if i = 0 then
      if v_over <> 0 or v_base <> 0 then
        return false;
      end if;
    elsif v_over <= p_over or abs(v_base - (p_base + (v_over - p_over) * p_rate)) > 1 then
      return false;
    end if;
    p_over := v_over;
    p_base := v_base;
    p_rate := v_rate;
  end loop;
  return true;
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
  end if;
  return false;
end
$$;

-- the five versions on file, documented (verified against their sources on
-- 2026-10-24; see MEMORY.md, Verified 2026 PH statutory figures)
update public.statutory_versions
  set legal_basis = 'RA 11199 (Social Security Act of 2018); SSS Circular 2024-006', verified_on = '2026-10-24'
  where kind = 'sss' and effective_from = '2025-01-01';
update public.statutory_versions
  set legal_basis = 'RA 11223 (Universal Health Care Act), Sec. 10; PhilHealth Advisory 2025-0002', verified_on = '2026-10-24'
  where kind = 'philhealth' and effective_from = '2024-01-01';
update public.statutory_versions
  set legal_basis = 'RA 9679 (HDMF Law of 2009); HDMF Circular 460', verified_on = '2026-10-24'
  where kind = 'pagibig' and effective_from = '2024-02-01';
update public.statutory_versions
  set legal_basis = 'RA 10963 (TRAIN), NIRC Sec. 24(A); RR 11-2018 Annex E (2023 onwards)', verified_on = '2026-10-24'
  where kind = 'bir_wht' and effective_from = '2023-01-01';
update public.statutory_versions
  set legal_basis = 'RA 10963 (TRAIN), NIRC Sec. 24(A)(2) and 32(B)(7)(e)', verified_on = '2026-10-24'
  where kind = 'bir_annual' and effective_from = '2023-01-01';

alter table public.statutory_versions
  add constraint statutory_versions_data_check check (public.valid_statutory_data(kind, data)),
  add constraint statutory_versions_month_start check (extract(day from effective_from) = 1),
  add constraint statutory_versions_documented check (
    length(btrim(legal_basis)) > 0 and length(btrim(description)) > 0 and coalesce(source_url, '') ~ '^https://'
  );

-- ---------- a version finalized payrolls may have used is frozen ----------
create or replace function public.guard_statutory_version()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- a deliberate correction of a published mistake (set in that migration)
  if coalesce(current_setting('statutory.correction', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  -- notes on a version (description, source, verification) stay editable
  if tg_op = 'UPDATE' and new.kind = old.kind and new.effective_from = old.effective_from and new.data = old.data then
    return new;
  end if;
  -- contribution tables follow the period, tax tables the pay date
  if exists (
    select 1 from payroll_runs r
    where r.status in ('finalized', 'paid') and greatest(r.period_end, r.pay_date) >= old.effective_from
  ) then
    raise exception 'Finalized payrolls may have used the % table effective %, so it is frozen. Ship a new version instead, or correct a published mistake deliberately (statutory.correction) and reopen the payrolls it affects.', old.kind, old.effective_from;
  end if;
  return coalesce(new, old);
end
$$;
create trigger statutory_versions_guard_change before update on public.statutory_versions
  for each row execute function public.guard_statutory_version();
create trigger statutory_versions_guard_remove before delete on public.statutory_versions
  for each row execute function public.guard_statutory_version();

revoke execute on function public.guard_statutory_version() from public, anon, authenticated;
revoke execute on function public.valid_tax_brackets(jsonb) from public, anon;
revoke execute on function public.valid_statutory_data(text, jsonb) from public, anon;
