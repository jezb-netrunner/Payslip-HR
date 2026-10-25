-- Owner's answer to the spec T3 question (2026-10-25): LIQUIDATED_ALLOWANCE
-- stays non-taxable only for an expense the employee paid for the
-- employer's business (travel, representation), liquidated with receipts.
-- The employee's own board and lodging gets its own code, BOARD_LODGING:
-- taxable pay for rank-and-file staff, and for managerial or supervisory
-- staff a fringe benefit (NIRC Sec. 33(A), (B)(1), (C)(3)) that payroll
-- flags for the fringe benefit tax review and does not withhold on.
-- Employees carry their job level. Pending: the exact conditions in RR 2-98
-- Sec. 2.78.1(A) and RR 3-98 Sec. 2.33 (not read yet).

alter table public.pay_codes
  add column fringe_benefit boolean not null default false;

update public.pay_codes set
  label = 'Business expense reimbursement (liquidated)',
  description = 'Repays an expense the employee paid for the employer''s business (travel, representation), liquidated with receipts. Not compensation, so not taxed and not in the SSS base. Not for the employee''s own board and lodging (use Board and lodging).'
  where code = 'LIQUIDATED_ALLOWANCE';

insert into public.pay_codes
  (sort_order, code, label, for_allowances, for_one_time, bir_bucket, income_class, tax_treatment, sss_include, sss_include_pending,
   fringe_benefit, description) values
(96, 'BOARD_LODGING', 'Board and lodging (employee''s own)', true, true, 'other_taxable', 'regular', 'taxable', true, false, true,
  'The employee''s own board and lodging. Taxable pay for rank-and-file staff. For managerial or supervisory staff it is a fringe benefit: flagged for the fringe benefit tax review and not withheld on (exact conditions pending: RR 2-98 Sec. 2.78.1(A), RR 3-98 Sec. 2.33).');

alter table public.employees
  add column job_level text not null default 'rank_and_file'
    constraint employees_job_level_check check (job_level in ('rank_and_file', 'managerial_supervisory'));
