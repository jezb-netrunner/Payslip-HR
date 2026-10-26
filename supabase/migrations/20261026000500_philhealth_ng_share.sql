-- C7 (compliance update 2026-10-25): for a solo parent or a person with
-- disability the national government pays the PhilHealth employee half.
-- From ph_ng_from_month through the month before the ID's expiry month the
-- employee's share is 0, the employer pays its usual half, and the other
-- half shows as "NG share - non-collectible", neither deducted nor remitted
-- (PhilHealth Circular 2026-0015 Secs. V.C, V.E.5, V.F.2, effective 26 Sep
-- 2026, Circular 2026-0017 Sec. V.H, effective 9 Oct 2026, RA 11228).
-- A solo parent's first month is the first month PhilHealth billing shows
-- the tag, not earlier than October 2026, and needs a valid Solo Parent ID.
-- The PhilHealth waiver fields of 2026-10-24 become these fields (no
-- employee had one set).
alter table public.employees rename column philhealth_ee_waiver to ph_ng_type;
alter table public.employees rename column philhealth_ee_waiver_from to ph_ng_from_month;
alter table public.employees rename column philhealth_ee_waiver_until to id_valid_until;
alter table public.employees rename constraint employees_philhealth_ee_waiver_check to employees_ph_ng_type_check;
alter table public.employees rename constraint employees_philhealth_ee_waiver_dates to employees_ph_ng_dates;

-- the first month is a month: an old waiver's start date counts from its month
update public.employees
  set ph_ng_from_month = date_trunc('month', ph_ng_from_month)::date
  where ph_ng_from_month is not null and ph_ng_from_month <> date_trunc('month', ph_ng_from_month)::date;

-- the ID is required from now on (NOT VALID: an old waiver without it stays
-- until the record is next saved, and payroll deducts the share until then)
alter table public.employees
  add column if not exists id_number text not null default ''
    constraint employees_id_number_length check (length(id_number) <= 60),
  add constraint employees_ph_ng_from_month_start check (ph_ng_from_month = date_trunc('month', ph_ng_from_month)::date),
  add constraint employees_ph_ng_documented check (
    ph_ng_type is null
    or (length(btrim(id_number)) > 0 and (ph_ng_type <> 'solo_parent' or id_valid_until is not null))) not valid;

-- the government's half on each payslip: shown, not deducted, not remitted
alter table public.payslips
  add column if not exists philhealth_ng numeric(12,2) not null default 0
    constraint payslips_philhealth_ng_check check (philhealth_ng >= 0);
