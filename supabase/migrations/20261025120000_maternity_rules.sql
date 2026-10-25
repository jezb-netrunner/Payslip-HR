-- Spec T4 (payroll tax rules spec, 2026-10-25): maternity leave.
--
-- MAT_DIFFERENTIAL is taxable supplementary compensation by default until
-- its exemption is confirmed (P1, a setting), in the SSS base, and counts
-- toward the 13th month (P9, a setting). MAT_SSS_BENEFIT stays tax-exempt
-- (RA 11199 Sec. 16), its SSS treatment a setting since T3 (P3). Clients
-- record their DOLE exemption from the differential (RA 11210 Sec. 5(c):
-- category, approval reference, the year it covers): without one for the
-- payroll year the differential is required, and a payslip that lacks it
-- carries an error that blocks finalizing. PhilHealth and Pag-IBIG during
-- the leave keep today's rule (P4, a setting in payroll_rules).

-- ---------- pay codes ----------
alter table public.pay_codes
  add column tax_pending boolean not null default false,
  add column include_in_13th_month_base boolean not null default false,
  add column thirteenth_pending boolean not null default false,
  drop constraint pay_codes_benefit,
  add constraint pay_codes_benefit check (
    benefit is null or (bir_bucket in ('other_non_taxable','other_taxable') and for_one_time and not for_allowances)),
  add constraint pay_codes_tax_setting check (not tax_pending or bir_bucket in ('other_non_taxable','other_taxable'));

update public.pay_codes set include_in_13th_month_base = true where code = 'BASIC_ADJ';
update public.pay_codes set
  bir_bucket = 'other_taxable', income_class = 'supplementary', tax_treatment = 'taxable', tax_pending = true,
  sss_include = true, include_in_13th_month_base = true, thirteenth_pending = true,
  description = 'The salary differential up to full pay during maternity leave (RA 11210). Taxable as supplementary compensation until the tax exemption is confirmed (a setting). In the SSS base. Counts toward the 13th month (a setting).'
  where code = 'MAT_DIFFERENTIAL';

-- a taxable differential keeps its benefit mark (an SSS benefit is never taxable pay)
alter table public.payroll_adjustments
  drop constraint payroll_adjustments_benefit_kind,
  add constraint payroll_adjustments_benefit_kind check (
    benefit is null or (kind = 'earning'
      and (category = 'other_non_taxable' or (benefit = 'maternity_differential' and category = 'other_taxable'))));

-- P1 and P9: company admins, audit-logged (audit_pay_codes), drafts recomputed
create or replace function public.set_pay_code_rule(p_code text, p_rule text, p_value boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_code pay_codes;
begin
  if not is_company_admin() then
    raise exception 'Only a company admin changes pay code settings.';
  end if;
  select * into v_code from pay_codes where code = p_code;
  if p_rule = 'taxable' and v_code.tax_pending then
    update pay_codes set
      bir_bucket = case when p_value then 'other_taxable' else 'other_non_taxable' end,
      tax_treatment = case when p_value then 'taxable' else 'exempt' end,
      income_class = case when p_value then 'supplementary' end
      where code = p_code and tax_treatment is distinct from (case when p_value then 'taxable' else 'exempt' end);
  elsif p_rule = 'include_in_13th_month_base' and v_code.thirteenth_pending then
    update pay_codes set include_in_13th_month_base = p_value
      where code = p_code and include_in_13th_month_base is distinct from p_value;
  else
    raise exception 'Whether pay code % is %: set by law, not a setting.', p_code, p_rule;
  end if;
  if found then
    update payroll_runs set totals = '{}'::jsonb where status = 'draft' and totals <> '{}'::jsonb;
  end if;
end
$$;
revoke execute on function public.set_pay_code_rule(text, text, boolean) from public, anon;
grant execute on function public.set_pay_code_rule(text, text, boolean) to authenticated;

-- ---------- the client's DOLE exemption from the differential ----------
alter table public.entities
  add column maternity_exemption_category text
    check (maternity_exemption_category in ('distressed','small_retail_service','micro_business','equal_or_better')),
  add column maternity_exemption_dole_ref text,
  add column maternity_exemption_year int check (maternity_exemption_year between 2019 and 2100),
  add constraint entities_maternity_exemption check (
    (maternity_exemption_category is null) = (maternity_exemption_year is null)
    and (maternity_exemption_category is null) = (nullif(trim(maternity_exemption_dole_ref), '') is null));

-- ---------- rules the law hasn't settled, for every client ----------
create table public.payroll_rules (
  id boolean primary key default true constraint payroll_rules_one_row check (id),
  -- P4: PhilHealth and Pag-IBIG during maternity leave
  maternity_contributions text not null default 'as_usual'
    constraint payroll_rules_maternity_contributions_check check (maternity_contributions in ('as_usual','pause_full_leave')),
  updated_at timestamptz not null default now()
);
insert into public.payroll_rules default values;
alter table public.payroll_rules enable row level security;
create policy "payroll rules: read all" on public.payroll_rules for select to authenticated using (true);
revoke all on public.payroll_rules from anon;
revoke insert, update, delete, truncate on public.payroll_rules from authenticated;
create trigger audit_payroll_rules after insert or update or delete on public.payroll_rules
  for each row execute function public.audit_trigger();

create or replace function public.set_payroll_rule(p_rule text, p_value text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_company_admin() then
    raise exception 'Only a company admin changes the payroll rules.';
  end if;
  if p_rule = 'maternity_contributions' then
    update payroll_rules set maternity_contributions = p_value, updated_at = now()
      where maternity_contributions is distinct from p_value;
  else
    raise exception 'Unknown payroll rule %.', p_rule;
  end if;
  if found then
    update payroll_runs set totals = '{}'::jsonb where status = 'draft' and totals <> '{}'::jsonb;
  end if;
end
$$;
revoke execute on function public.set_payroll_rule(text, text) from public, anon;
grant execute on function public.set_payroll_rule(text, text) to authenticated;

-- ---------- a run whose payslips carry errors is not finalized ----------
create or replace function public.guard_payslip_errors()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.status = 'draft' and new.status <> 'draft' and exists (
    select 1 from payslips
    where payroll_run_id = new.id
      and jsonb_typeof(computation_trace->'errors') = 'array'
      and jsonb_array_length(computation_trace->'errors') > 0) then
    raise exception 'Fix the errors on this run''s payslips before finalizing (see Review warnings on the run).';
  end if;
  return new;
end
$$;
revoke execute on function public.guard_payslip_errors() from public, anon, authenticated;
create trigger payroll_runs_payslip_errors before update of status on public.payroll_runs
  for each row execute function public.guard_payslip_errors();
