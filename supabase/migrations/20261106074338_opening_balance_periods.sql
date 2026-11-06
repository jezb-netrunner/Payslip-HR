-- Opening balances, two more figures the year's computations need (review of
-- 2026-11-06):
--  - periods_paid: the payroll periods the old payroll paid in the tax year
--    (a December period released in January included). The cumulative
--    average divides the year's taxable pay by its periods, and counting
--    calendar halves from 1 January is off by one for cutoffs like the 26th
--    to the 10th, or when last December's period was paid in January.
--    Blank = counted from 1 January (or the hire date).
--  - thirteenth_installments: the part of thirteenth_month that is this
--    year's 13th month paid in advance (a June half, say). thirteenth_month
--    is the 2316 figure, all 13th month pay released in the tax year, which
--    can include last year's paid in January: subtracting all of it from
--    this year's 13th month would pay nothing.
-- Additive: two columns with their checks. No row exists yet.

alter table public.employee_opening_balances
  add column periods_paid int check (periods_paid between 0 and 60),
  add column thirteenth_installments numeric(14,2) not null default 0
    check (thirteenth_installments >= 0);
alter table public.employee_opening_balances
  add constraint employee_opening_balances_installments_within
    check (thirteenth_installments <= thirteenth_month);
