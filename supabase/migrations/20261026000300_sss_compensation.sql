-- C5 (compliance update 2026-10-25): the SSS contribution base is all
-- actual remuneration for employment in the SSS month, mandated COLA
-- included, up to the maximum MSC (RA 11199 Secs. 8(f), 8(h), 18, 19(a),
-- IRR of RA 11199 Rule 12 Secs. 6, 8). Only a pay item typed as the
-- Christmas bonus and an allowance subject to liquidation are left out.

-- the 13th month pay counts in its month unless the client decides otherwise (open item O2)
alter table public.entities
  add column if not exists sss_include_13th_month boolean not null default true;

-- the pay-item types that are not SSS compensation
alter table public.employee_allowances
  add column if not exists pay_item_type text
    constraint employee_allowances_pay_item_type_check check (pay_item_type in ('christmas_bonus', 'liquidated_allowance')),
  add constraint employee_allowances_pay_item_type_category check (
    pay_item_type is null
    or (pay_item_type = 'christmas_bonus' and category = 'other_benefits')
    or (pay_item_type = 'liquidated_allowance'
        and category in ('representation', 'transportation', 'housing', 'other_taxable', 'other_non_taxable')));

alter table public.payroll_adjustments
  add column if not exists pay_item_type text
    constraint payroll_adjustments_pay_item_type_check check (pay_item_type in ('christmas_bonus', 'liquidated_allowance')),
  add constraint payroll_adjustments_pay_item_type_category check (
    pay_item_type is null
    or (kind = 'earning' and pay_item_type = 'christmas_bonus' and category = 'other_benefits')
    or (kind = 'earning' and pay_item_type = 'liquidated_allowance'
        and category in ('representation', 'transportation', 'housing', 'other_taxable', 'other_non_taxable')));
