-- C5 (compliance update 2026-10-25): the SSS contribution base is all
-- actual remuneration for employment in the SSS month, mandated COLA
-- included, up to the maximum MSC (RA 11199 Secs. 8(f), 8(h), 18, 19(a),
-- IRR of RA 11199 Rule 12 Secs. 6, 8). Only a pay item typed as the
-- Christmas bonus and an allowance subject to liquidation are left out.

-- the 13th month pay counts in its month unless the client decides otherwise (open item O2)
alter table public.entities
  add column if not exists sss_include_13th_month boolean not null default true;

-- pay-item types that refine a classification: the two that are not SSS
-- compensation, and (C10) commissions, profit sharing and fees, taxable
-- supplementary pay with their own BIR Form 2316 items (45 to 47)
alter table public.employee_allowances
  add column if not exists pay_item_type text
    constraint employee_allowances_pay_item_type_check check (pay_item_type in
      ('christmas_bonus', 'liquidated_allowance', 'commission', 'profit_sharing', 'fees')),
  add constraint employee_allowances_pay_item_type_category check (
    pay_item_type is null
    or (pay_item_type = 'christmas_bonus' and category = 'other_benefits')
    or (pay_item_type = 'liquidated_allowance'
        and category in ('representation', 'transportation', 'housing', 'other_taxable', 'other_non_taxable'))
    or (pay_item_type in ('commission', 'profit_sharing', 'fees') and category = 'other_taxable'));

alter table public.payroll_adjustments
  add column if not exists pay_item_type text
    constraint payroll_adjustments_pay_item_type_check check (pay_item_type in
      ('christmas_bonus', 'liquidated_allowance', 'commission', 'profit_sharing', 'fees')),
  add constraint payroll_adjustments_pay_item_type_category check (
    pay_item_type is null
    or (kind = 'earning' and pay_item_type = 'christmas_bonus' and category = 'other_benefits')
    or (kind = 'earning' and pay_item_type = 'liquidated_allowance'
        and category in ('representation', 'transportation', 'housing', 'other_taxable', 'other_non_taxable'))
    or (kind = 'earning' and pay_item_type in ('commission', 'profit_sharing', 'fees') and category = 'other_taxable'));
