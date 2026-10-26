-- C6 (compliance update 2026-10-25): maternity leave. Every month of the
-- leave contributes the usual SSS, PhilHealth and Pag-IBIG, and the
-- employee's shares come out of the maternity pay (computed in the app).
-- A client may be exempted by DOLE from the salary differential (RA 11210
-- Sec. 5(c), IRR Rule VI Sec. 5, DOLE DA 01-19): the exemption is recorded
-- with its reference and the date it is valid until, and a leave starting
-- after that date is not exempt. The size test for it is not more than 10
-- workers, kept apart from the less-than-10 test of holiday pay and SIL.
alter table public.entities
  add column if not exists maternity_differential_exempt boolean not null default false,
  add column if not exists dole_exemption_ref text not null default '',
  add column if not exists dole_exemption_valid_until date,
  add constraint entities_dole_exemption_documented check (
    not maternity_differential_exempt
    or (length(btrim(dole_exemption_ref)) > 0 and dole_exemption_valid_until is not null));
