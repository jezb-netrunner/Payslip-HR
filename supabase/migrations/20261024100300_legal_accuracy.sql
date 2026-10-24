-- Legal-accuracy review of the payroll and HR rules (owner, 2026-10-24:
-- "payroll is legally sensitive"). Sources are in MEMORY.md, Verified 2026
-- PH statutory figures.

-- ---------- the year-end tax adjustment ----------
-- The year's tax is trued up on the last payroll PAID in December (RR 2-98
-- as amended by RR 11-2018); the tax year follows the pay date, so a run
-- paid in another month annualizing would settle the wrong year. An
-- employee who separates is annualized on the payroll with the last day,
-- whatever the month, without this flag.
alter table public.payroll_runs
  add constraint payroll_runs_annualize_december check (not annualize or extract(month from pay_date) = 12);

-- ---------- normal hours of work: eight a day at most (Labor Code Art. 83) ----------
-- (a longer day is a compressed-workweek shift, valid_shift / valid_week_pattern)
alter table public.entities
  add constraint entities_standard_hours_max8 check (standard_hours_per_day <= 8);

-- ---------- service requirements ----------
-- Solo Parent Leave: six months of service, continuous or broken (RA 11861
-- Sec. 8). Special Leave for Women: six months of aggregate service in the
-- last twelve (RA 9710 Sec. 18). A client may still grant either sooner.
update public.leave_types set min_service_months = 6
  where code in ('SPL', 'MCW') and min_service_months = 0;

-- ---------- holiday pay reads the days before the period ----------
-- A regular holiday is paid after work or paid leave on the workday before
-- it (IRR Book III, Rule IV, Sec. 6), so a payroll whose period holds a
-- regular holiday reads attendance up to ten days before the period: a
-- change there stales that draft too.
create or replace function public.mark_payroll_drafts_stale(
  p_entity uuid, p_employee uuid, p_from date, p_to date)
returns void
language sql security definer set search_path = public
as $$
  update payroll_runs r
     set totals = '{}'::jsonb
   where r.status = 'draft' and r.totals <> '{}'::jsonb
     and (p_entity is null or r.entity_id = p_entity)
     and (p_from is null or (r.run_type <> 'thirteenth_month' and r.period_end >= p_from))
     and (p_to is null or r.period_start <= p_to
          or (r.period_start <= p_to + 10 and exists (
                select 1 from holidays h
                 where h.kind = 'regular' and h.holiday_date between r.period_start and r.period_end
                   and (h.entity_id is null or h.entity_id = r.entity_id))))
     and (p_employee is null
          or r.totals ? 'computing'
          or exists (select 1 from payslips p where p.payroll_run_id = r.id and p.employee_id = p_employee))
$$;
revoke execute on function public.mark_payroll_drafts_stale(uuid, uuid, date, date) from public, anon, authenticated;

-- ---------- maternity pay is its own earnings (RA 11210) ----------
-- The 105 days of full pay are the SSS maternity benefit the employer
-- advances (within 30 days of the leave application, SSS Circular 2019-009)
-- plus any salary differential up to full pay — not salary for the leave
-- days, which payroll no longer pays. Both are tax-exempt (RMC 105-2019);
-- the differential counts toward the 13th month and the SSS benefit does
-- not (DOLE Labor Advisory 25-2023). They are one-time earnings classified
-- other non-taxable, marked with which one they are.
alter table public.payroll_adjustments
  add column if not exists benefit text
    constraint payroll_adjustments_benefit_check check (benefit in ('sss_maternity', 'maternity_differential')),
  add constraint payroll_adjustments_benefit_kind check (
    benefit is null or (kind = 'earning' and category = 'other_non_taxable'));

-- ---------- PhilHealth: the government pays some employees' share ----------
-- Employed PWDs (RA 11228) and, from Sep 26, 2026, solo parents (RA 11861;
-- PhilHealth Circular 2026-0015): the national government pays the
-- employee share, the employer pays its own.
alter table public.employees
  add column if not exists philhealth_ee_waiver text
    constraint employees_philhealth_ee_waiver_check check (philhealth_ee_waiver in ('pwd', 'solo_parent')),
  add column if not exists philhealth_ee_waiver_from date,
  add column if not exists philhealth_ee_waiver_until date,
  add constraint employees_philhealth_ee_waiver_dates check (
    (philhealth_ee_waiver is null) = (philhealth_ee_waiver_from is null)
    and (philhealth_ee_waiver_until is null or philhealth_ee_waiver_until >= philhealth_ee_waiver_from));

-- ---------- deductions the law doesn't provide for need the employee's written authorization ----------
-- (Labor Code Art. 113; IRR Book III, Rule VIII, Sec. 10 as amended by DOLE
-- D.O. 195-18): company loans, HMO and insurance premiums, and any other
-- deduction — recurring, or one-time in a payroll. Government loans, union
-- dues and cash advances (their own authorization date) are outside this.
-- Rows recorded before this rule keep working until they are re-classified.
alter table public.payroll_adjustments add column if not exists authorized_on date;

create or replace function public.guard_deduction_authorization()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_needs boolean;
  v_needed boolean;
begin
  if tg_table_name = 'recurring_deductions' then
    v_needs := new.category in ('company_loan', 'hmo', 'other');
    v_needed := tg_op = 'UPDATE' and old.category in ('company_loan', 'hmo', 'other');
  else
    v_needs := new.kind = 'deduction' and new.category = 'other';
    v_needed := tg_op = 'UPDATE' and old.kind = 'deduction' and old.category = 'other';
  end if;
  if v_needs and new.authorized_on is null
     and (not v_needed or (tg_op = 'UPDATE' and old.authorized_on is not null)) then
    raise exception 'Record the date the employee signed the written authorization for this deduction (Labor Code Art. 113).';
  end if;
  return new;
end
$$;
create trigger recurring_deductions_authorization before insert or update on public.recurring_deductions
  for each row execute function public.guard_deduction_authorization();
create trigger payroll_adjustments_authorization before insert or update on public.payroll_adjustments
  for each row execute function public.guard_deduction_authorization();
revoke execute on function public.guard_deduction_authorization() from public, anon, authenticated;

-- ---------- 2027 national holidays (Proclamation 1427, Sep 8, 2026) ----------
-- Eid'l Fitr and Eid'l Adha are proclaimed separately, weeks ahead (add them
-- then). Local special days — e.g. NCR's Nov 16–18, 2026 (Proclamation
-- 1447) — are each client's own holidays.
insert into public.holidays (holiday_date, name, kind) values
('2027-01-01', 'New Year''s Day', 'regular'),
('2027-03-25', 'Maundy Thursday', 'regular'),
('2027-03-26', 'Good Friday', 'regular'),
('2027-04-09', 'Araw ng Kagitingan', 'regular'),
('2027-05-01', 'Labor Day', 'regular'),
('2027-06-12', 'Independence Day', 'regular'),
('2027-08-30', 'National Heroes Day', 'regular'),
('2027-11-30', 'Bonifacio Day', 'regular'),
('2027-12-25', 'Christmas Day', 'regular'),
('2027-12-30', 'Rizal Day', 'regular'),
('2027-02-06', 'Chinese New Year', 'special_non_working'),
('2027-03-27', 'Black Saturday', 'special_non_working'),
('2027-08-21', 'Ninoy Aquino Day', 'special_non_working'),
('2027-11-01', 'All Saints'' Day', 'special_non_working'),
('2027-11-02', 'All Souls'' Day', 'special_non_working'),
('2027-12-08', 'Feast of the Immaculate Conception', 'special_non_working'),
('2027-12-24', 'Christmas Eve', 'special_non_working'),
('2027-12-31', 'Last Day of the Year', 'special_non_working'),
('2027-02-25', 'EDSA People Power Revolution Anniversary', 'special_working')
on conflict on constraint holidays_entity_date_name_key do nothing;
