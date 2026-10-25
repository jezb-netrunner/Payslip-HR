-- Spec T3 (payroll tax rules spec, 2026-10-25): the SSS base by pay code.
--
-- The SSS compensation of a month is the pay lines whose pay code is in the
-- SSS base, in the payrolls of that month (RA 11199 Sec. 8(f), SSS IRR Rule
-- 12 Sec. 6: "Bonuses (except Christmas bonus)", transportation, board and
-- lodging "if not subject to liquidation"). New codes: the Christmas bonus
-- (out of the base), liquidated transportation, board or lodging (not
-- compensation at all), and the 13th month run's own code. Whether 13th
-- month pay, de minimis benefits, other non-taxable pay and the advanced
-- SSS maternity benefit are in the base is not settled (spec P2, P3): each
-- is a setting company admins change, excluded by default (today's rule).
-- Existing "other benefits" lines stay on BONUS, now in the base (owner's
-- decision 3): switch a Christmas bonus to CHRISTMAS_BONUS.

alter table public.pay_codes
  add column sss_include boolean not null default false,
  add column sss_include_pending boolean not null default false,
  add column is_christmas_bonus boolean not null default false,
  add column subject_to_liquidation boolean not null default false,
  drop constraint pay_codes_used,
  add constraint pay_codes_sss_exclusions check (not (sss_include and (is_christmas_bonus or subject_to_liquidation))),
  add constraint pay_codes_christmas_bonus check (not is_christmas_bonus or bir_bucket = 'other_benefits'),
  add constraint pay_codes_engine_only check ((for_allowances or for_one_time) or code = 'THIRTEENTH_MONTH');

update public.pay_codes set sss_include = true
  where code in ('BASIC_ADJ','HOLIDAY_ADJ','OVERTIME_ADJ','NIGHT_DIFF_ADJ','REPRESENTATION','TRANSPORTATION','COLA','HOUSING',
                 'FIXED_ALLOWANCE','HAZARD','COMMISSION','OTHER_TAXABLE','BONUS');
update public.pay_codes set sss_include_pending = true where code in ('DE_MINIMIS','NON_TAXABLE','MAT_SSS_BENEFIT');

update public.pay_codes set
  label = 'Other bonus or benefit (₱90k bucket)',
  description = 'Bonuses and other benefits other than the Christmas bonus. Exempt together with the 13th month pay up to ₱90,000 a year, the excess is supplementary compensation. In the SSS base.'
  where code = 'BONUS';
update public.pay_codes set description = 'Fixed transportation allowance, not liquidated. Regular compensation when paid every period.'
  where code = 'TRANSPORTATION';
update public.pay_codes set description = 'Fixed housing, board or lodging allowance, not liquidated. Regular compensation when paid every period.'
  where code = 'HOUSING';
update public.pay_codes set description = 'Sales or other commission, commission advances included.'
  where code = 'COMMISSION';
update public.pay_codes set description = 'Any other taxable one-time pay, such as an incentive outside the ₱90k bucket or the cash value of non-cash pay.'
  where code = 'OTHER_TAXABLE';
update public.pay_codes set description = 'Other pay the law exempts from tax.'
  where code = 'NON_TAXABLE';

insert into public.pay_codes
  (sort_order, code, label, for_allowances, for_one_time, bir_bucket, income_class, tax_treatment, sss_include, sss_include_pending,
   is_christmas_bonus, subject_to_liquidation, description) values
(95, 'LIQUIDATED_ALLOWANCE', 'Transportation, board or lodging (liquidated)', true, true, 'other_non_taxable', null, 'exempt', false, false,
  false, true, 'An allowance or reimbursement the employee liquidates with receipts. Not compensation, so not taxed and not in the SSS base.'),
(135, 'CHRISTMAS_BONUS', 'Christmas bonus (₱90k bucket)', false, true, 'other_benefits', 'supplementary', 'benefits', false, false,
  true, false, 'The Christmas bonus. In the ₱90k bucket for tax, and out of the SSS base.'),
(900, 'THIRTEENTH_MONTH', '13th month pay', false, false, 'thirteenth', 'supplementary', 'benefits', false, true,
  false, false, '13th month pay (PD 851), paid by a 13th month run. Exempt together with other benefits up to ₱90,000 a year.');

-- ---------- the PENDING SSS settings ----------
-- Company admins switch sss_include on the codes the law hasn't settled,
-- audit-logged. Draft payrolls are marked for recomputing (every client:
-- the codes are shared).
create or replace function public.set_pay_code_sss_include(p_code text, p_include boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_company_admin() then
    raise exception 'Only a company admin changes pay code settings.';
  end if;
  if not exists (select 1 from pay_codes where code = p_code and sss_include_pending) then
    raise exception 'The SSS base of pay code % is set by law, not a setting.', p_code;
  end if;
  update pay_codes set sss_include = p_include where code = p_code and sss_include is distinct from p_include;
  if found then
    update payroll_runs set totals = '{}'::jsonb where status = 'draft' and totals <> '{}'::jsonb;
  end if;
end
$$;
revoke execute on function public.set_pay_code_sss_include(text, boolean) from public, anon;
grant execute on function public.set_pay_code_sss_include(text, boolean) to authenticated;

create trigger audit_pay_codes after insert or update or delete on public.pay_codes
  for each row execute function public.audit_trigger();
