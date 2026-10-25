-- Spec T5 (payroll tax rules spec, 2026-10-25): a minimum wage earner's
-- hazard pay is exempt only when the hazard pay criteria are met and a DOLE
-- certification reference is on file (RR 2-98 Sec. 2.78.1(B)(13), as
-- amended by RR 11-2018). Otherwise it is taxable supplementary pay. The
-- premium split (rest-day and special-day pay above the minimum wage day)
-- is computed by payroll and needs no schema change.

alter table public.employees
  add column hazard_criteria_met boolean not null default false,
  add column hazard_dole_cert_ref text;
