-- Spec T2 (payroll tax rules spec, 2026-10-25, owner's decision 1): pay codes,
-- and the regular / supplementary split of each payslip's taxable pay.
--
-- Every earnings line an admin enters (a recurring allowance, or a one-time
-- earning in a payroll) carries a pay code. The code fixes the line's BIR
-- bucket (how it is taxed and reported) and whether its taxable part is
-- regular (R) or supplementary (S) compensation, which decides the
-- withholding method: the regular method finds the table row from R alone,
-- and the cumulative average method applies from a trigger to the end of the
-- year (RR 2-98 Sec. 2.79(B), as amended by RR 11-2018).
--
-- Pay codes are reference data that ship with the software, like the
-- statutory tables: every signed-in user reads them, no API role writes them.
-- src/payroll/payCodes.ts mirrors them for tests (18_pay_codes_tests.sql
-- checks the two agree). Existing allowances and one-time earnings get the
-- code of their category, and their category then follows the code.
-- Payslips store R, S and the withholding method. Finalized ones keep their results
-- (spec §0 step 7) and have no split stored. Draft payrolls are marked for
-- recomputing, so none is finalized on the old method.

create table public.pay_codes (
  code text primary key constraint pay_codes_code_format check (code ~ '^[A-Z][A-Z0-9_]+$'),
  label text not null check (length(trim(label)) between 1 and 80),
  description text not null default '',
  for_allowances boolean not null default false,
  for_one_time boolean not null default false,
  bir_bucket text not null check (bir_bucket in
    ('basic','holiday','overtime','night_diff','hazard','thirteenth','other_benefits','de_minimis','representation',
     'transportation','cola','housing','other_taxable','other_non_taxable')),
  -- R or S of the taxable part when paid as an allowance every period
  -- (anything paid once is S, except a basic pay correction). Null: never taxable.
  income_class text check (income_class in ('regular','supplementary')),
  tax_treatment text not null check (tax_treatment in ('taxable','mwe_exempt','benefits','de_minimis','exempt')),
  benefit text check (benefit in ('sss_maternity','maternity_differential')),
  sort_order int not null default 0,
  active boolean not null default true,
  constraint pay_codes_used check (for_allowances or for_one_time),
  -- the buckets employee_allowances.category and payroll_adjustments.category allow
  constraint pay_codes_allowance_bucket check (not for_allowances or bir_bucket in
    ('de_minimis','other_benefits','hazard','representation','transportation','cola','housing','other_taxable','other_non_taxable')),
  constraint pay_codes_one_time_bucket check (not for_one_time or bir_bucket <> 'thirteenth'),
  -- how a line is taxed follows its bucket (src/payroll/annual.ts isTaxableBucket)
  constraint pay_codes_tax_treatment check (tax_treatment = case
    when bir_bucket in ('basic','holiday','overtime','night_diff','hazard','cola') then 'mwe_exempt'
    when bir_bucket in ('thirteenth','other_benefits') then 'benefits'
    when bir_bucket = 'de_minimis' then 'de_minimis'
    when bir_bucket = 'other_non_taxable' then 'exempt'
    else 'taxable' end),
  constraint pay_codes_benefit check (benefit is null or (bir_bucket = 'other_non_taxable' and for_one_time and not for_allowances))
);

alter table public.pay_codes enable row level security;
create policy "pay codes: read all" on public.pay_codes for select to authenticated using (true);
revoke all on public.pay_codes from anon;
revoke insert, update, delete, truncate on public.pay_codes from authenticated;

insert into public.pay_codes
  (sort_order, code, label, for_allowances, for_one_time, bir_bucket, income_class, tax_treatment, benefit, description) values
(10, 'BASIC_ADJ', 'Basic pay adjustment', false, true, 'basic', 'regular', 'mwe_exempt', null,
  'A correction of basic pay of an earlier payroll. Counts toward the 13th month.'),
(20, 'HOLIDAY_ADJ', 'Holiday, rest day or special day pay adjustment', false, true, 'holiday', 'supplementary', 'mwe_exempt', null,
  'Holiday, rest-day or special-day pay of an earlier payroll.'),
(30, 'OVERTIME_ADJ', 'Overtime pay adjustment', false, true, 'overtime', 'supplementary', 'mwe_exempt', null,
  'Overtime of an earlier payroll.'),
(40, 'NIGHT_DIFF_ADJ', 'Night differential adjustment', false, true, 'night_diff', 'supplementary', 'mwe_exempt', null,
  'Night shift differential of an earlier payroll.'),
(50, 'REPRESENTATION', 'Representation allowance', true, true, 'representation', 'regular', 'taxable', null,
  'Fixed representation allowance. Regular compensation when paid every period.'),
(60, 'TRANSPORTATION', 'Transportation allowance', true, true, 'transportation', 'regular', 'taxable', null,
  'Fixed transportation allowance. Regular compensation when paid every period.'),
(70, 'COLA', 'Cost of living allowance (COLA)', true, true, 'cola', 'regular', 'mwe_exempt', null,
  'COLA fixed by a wage order. Exempt for minimum wage earners.'),
(80, 'HOUSING', 'Fixed housing allowance', true, true, 'housing', 'regular', 'taxable', null,
  'Fixed housing allowance. Regular compensation when paid every period.'),
(90, 'FIXED_ALLOWANCE', 'Other fixed allowance', true, false, 'other_taxable', 'regular', 'taxable', null,
  'Any other taxable allowance paid every period.'),
(100, 'HAZARD', 'Hazard pay', true, true, 'hazard', 'supplementary', 'mwe_exempt', null,
  'Hazard pay. Supplementary compensation. Exempt for minimum wage earners.'),
(110, 'COMMISSION', 'Commission', false, true, 'other_taxable', 'supplementary', 'taxable', null,
  'Sales or other commission.'),
(120, 'OTHER_TAXABLE', 'Other taxable pay', false, true, 'other_taxable', 'supplementary', 'taxable', null,
  'Any other taxable one-time pay, such as an incentive outside the ₱90k bucket or monetized leave beyond the de minimis ceiling.'),
(130, 'BONUS', 'Bonus or other benefit (₱90k bucket)', true, true, 'other_benefits', 'supplementary', 'benefits', null,
  'Bonuses and other benefits. Exempt together with the 13th month pay up to ₱90,000 a year, the excess is supplementary compensation.'),
(140, 'DE_MINIMIS', 'De minimis benefit', true, true, 'de_minimis', 'supplementary', 'de_minimis', null,
  'A de minimis benefit within its BIR ceiling (RR 29-2025).'),
(150, 'NON_TAXABLE', 'Other non-taxable pay', true, true, 'other_non_taxable', null, 'exempt', null,
  'Pay the law exempts, such as a reimbursement.'),
(160, 'MAT_SSS_BENEFIT', 'SSS maternity benefit', false, true, 'other_non_taxable', null, 'exempt', 'sss_maternity',
  'The SSS maternity benefit the employer advances (RA 11210). Tax-exempt.'),
(170, 'MAT_DIFFERENTIAL', 'Maternity salary differential', false, true, 'other_non_taxable', null, 'exempt', 'maternity_differential',
  'The salary differential up to full pay during maternity leave (RA 11210). Tax-exempt (RMC 105-2019), counts toward the 13th month.');

-- ---------- the code a row saved with only a category gets ----------
-- (rows from before pay codes, and screens that still send a category)
create or replace function public.default_pay_code(p_category text, p_benefit text, p_allowance boolean)
returns text
language sql immutable set search_path = public
as $$
  select case
    when p_benefit = 'sss_maternity' then 'MAT_SSS_BENEFIT'
    when p_benefit = 'maternity_differential' then 'MAT_DIFFERENTIAL'
    else case p_category
      when 'basic' then 'BASIC_ADJ'
      when 'holiday' then 'HOLIDAY_ADJ'
      when 'overtime' then 'OVERTIME_ADJ'
      when 'night_diff' then 'NIGHT_DIFF_ADJ'
      when 'hazard' then 'HAZARD'
      when 'other_benefits' then 'BONUS'
      when 'de_minimis' then 'DE_MINIMIS'
      when 'representation' then 'REPRESENTATION'
      when 'transportation' then 'TRANSPORTATION'
      when 'cola' then 'COLA'
      when 'housing' then 'HOUSING'
      when 'other_taxable' then case when p_allowance then 'FIXED_ALLOWANCE' else 'OTHER_TAXABLE' end
      when 'other_non_taxable' then 'NON_TAXABLE'
    end
  end
$$;

-- ---------- existing rows ----------
-- Bookkeeping, not an admin's change: no audit entry, and the run locks
-- (finalized runs' adjustments) don't apply. Drafts are marked below.
alter table public.employee_allowances add column pay_code text references public.pay_codes (code);
alter table public.payroll_adjustments add column pay_code text references public.pay_codes (code);

alter table public.employee_allowances disable trigger user;
update public.employee_allowances set pay_code = public.default_pay_code(category, null, true) where pay_code is null;
alter table public.employee_allowances enable trigger user;

alter table public.payroll_adjustments disable trigger user;
update public.payroll_adjustments set pay_code = public.default_pay_code(category, benefit, false)
  where kind = 'earning' and pay_code is null;
alter table public.payroll_adjustments enable trigger user;

alter table public.employee_allowances alter column pay_code set not null;
alter table public.payroll_adjustments
  add constraint payroll_adjustments_pay_code_kind check ((kind = 'earning') = (pay_code is not null));

-- ---------- the code decides the category ----------
-- A row saved with a pay code takes the code's bucket (and maternity
-- benefit). A row saved with only a category (and benefit), or whose
-- category alone changes (a screen from before pay codes), gets that
-- category's code and keeps what it sent, so the table's own checks still
-- refuse a contradiction (a maternity benefit classed as taxable pay, an
-- earning with a deduction's category).
create or replace function public.sync_pay_code()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_code pay_codes;
  v_allowance boolean := tg_table_name = 'employee_allowances';
  v_derived boolean := false;
begin
  if not v_allowance then
    if new.kind = 'deduction' then
      if new.pay_code is not null then
        raise exception 'A deduction has no pay code.';
      end if;
      return new;
    end if;
    if new.pay_code is null
       or (tg_op = 'UPDATE' and new.pay_code is not distinct from old.pay_code
           and (new.category is distinct from old.category or new.benefit is distinct from old.benefit)) then
      new.pay_code := default_pay_code(new.category, new.benefit, false);
      v_derived := true;
    end if;
  elsif new.pay_code is null
     or (tg_op = 'UPDATE' and new.pay_code is not distinct from old.pay_code and new.category is distinct from old.category) then
    new.pay_code := default_pay_code(new.category, null, true);
    v_derived := true;
  end if;
  if new.pay_code is null then
    return new; -- no code for that category: the table's checks refuse the row
  end if;

  select * into v_code from pay_codes where code = new.pay_code;
  if v_code.code is null then
    raise exception 'Unknown pay code %.', new.pay_code;
  end if;
  if v_allowance and not v_code.for_allowances then
    raise exception 'Pay code % is not for recurring allowances.', new.pay_code;
  end if;
  if not v_allowance and not v_code.for_one_time then
    raise exception 'Pay code % is not for one-time earnings.', new.pay_code;
  end if;
  if not v_code.active and (tg_op = 'INSERT' or new.pay_code is distinct from old.pay_code) then
    raise exception 'Pay code % is no longer in use.', new.pay_code;
  end if;
  if not v_derived then
    new.category := v_code.bir_bucket;
    if not v_allowance then
      new.benefit := v_code.benefit;
    end if;
  end if;
  return new;
end
$$;
revoke execute on function public.sync_pay_code() from public, anon, authenticated;
revoke execute on function public.default_pay_code(text, text, boolean) from public, anon;

create trigger employee_allowances_pay_code before insert or update on public.employee_allowances
  for each row execute function public.sync_pay_code();
create trigger payroll_adjustments_pay_code before insert or update on public.payroll_adjustments
  for each row execute function public.sync_pay_code();

-- ---------- payslips: R, S and the method ----------
alter table public.payslips
  add column taxable_regular numeric(14,2),
  add column taxable_supplementary numeric(14,2),
  add column wht_method text constraint payslips_wht_method_check check (wht_method in ('regular','cam','annualized')),
  add constraint payslips_taxable_split check (
    (taxable_regular is null) = (taxable_supplementary is null)
    and (taxable_regular is null
         or (taxable_regular >= 0 and taxable_supplementary >= 0 and taxable_regular + taxable_supplementary = taxable_income)));

-- ---------- recompute drafts on the new method ----------
update public.payroll_runs set totals = '{}'::jsonb where status = 'draft' and totals <> '{}'::jsonb;
