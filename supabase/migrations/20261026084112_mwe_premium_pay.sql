-- C1 (compliance update 2026-10-25): a minimum wage earner is exempt only on
-- the statutory minimum wage, holiday pay, overtime, night shift
-- differential and qualifying hazard pay. Rest-day and special-day premiums
-- are taxable additional compensation (NIRC Sec. 24(A)(2)(a) last proviso,
-- RR 2-98 Secs. 2.78.1(B)(13) and 2.79(A) as amended by RR 11-2018).

-- the extra 30% for a regular holiday worked on the rest day: taxable unless
-- the client decides otherwise (open item O1)
alter table public.entities
  add column if not exists mwe_rh_restday_premium_taxable boolean not null default true;

-- hazard pay of an MWE is exempt only for an actual assignment to a danger,
-- strife-torn or disease-infested area, or a distressed or isolated station,
-- certified by DOLE or an allied agency: the certification reference
alter table public.employees
  add column if not exists hazard_certification_ref text not null default ''
    constraint employees_hazard_certification_ref_length check (length(hazard_certification_ref) <= 200);
