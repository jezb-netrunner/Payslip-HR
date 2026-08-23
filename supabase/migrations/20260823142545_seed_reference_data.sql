-- ============================================================
-- Seed: statutory tables (verified Aug 2026), 2026 holidays,
-- leave types, and the current NCR minimum wage reference.
-- ============================================================

-- ---------- statutory versions ----------
insert into public.statutory_versions (kind, effective_from, effective_to, description, source_url, data) values
(
  'sss', '2025-01-01', null,
  'SSS contribution schedule under RA 11199: 15% of MSC (10% ER / 5% EE), MSC P5,000–P35,000 in P500 steps. MSC above P20,000 goes to the Mandatory Provident Fund (WISP). EC (employer-paid): P10 for MSC below P15,000, P30 at or above.',
  'https://www.sss.gov.ph/wp-content/uploads/2024/12/Cir-2024-006-Employers.pdf',
  '{"rate_ee":0.05,"rate_er":0.10,"msc_min":5000,"msc_max":35000,"msc_step":500,"mpf_threshold":20000,"ec_er_low":10,"ec_er_high":30,"ec_threshold_msc":15000}'::jsonb
),
(
  'philhealth', '2024-01-01', null,
  'PhilHealth premium under RA 11223 (UHC Act): 5% of monthly basic salary, floor P10,000 / ceiling P100,000, split equally ER/EE. Final scheduled rate — retained for 2025 (PA 2025-0002) and 2026. Odd centavo on the split is carried by the employer.',
  'https://www.philhealth.gov.ph/partners/employers/ContributionTable_v2.pdf',
  '{"rate":0.05,"floor":10000,"ceiling":100000}'::jsonb
),
(
  'pagibig', '2024-02-01', null,
  'Pag-IBIG (HDMF) monthly savings per Circular 460: max fund salary P10,000; EE 1% (comp <= P1,500) or 2%, ER always 2%. Max P200 + P200.',
  'https://www.pagibigfund.gov.ph/document/pdf/circulars/provident/HDMF%20Circular%20No.%20460.pdf',
  '{"max_fund_salary":10000,"ee_rate_low":0.01,"ee_rate_high":0.02,"low_threshold":1500,"er_rate":0.02}'::jsonb
),
(
  'bir_wht', '2023-01-01', null,
  'BIR revised withholding tax on compensation (TRAIN law RA 10963, Annex E of RR 11-2018), effective 01 Jan 2023 and onwards. Verified still in force for CY 2026.',
  'https://www.bir.gov.ph/income-tax',
  '{"daily":[{"over":0,"base":0,"rate":0},{"over":685,"base":0,"rate":0.15},{"over":1096,"base":61.65,"rate":0.20},{"over":2192,"base":280.85,"rate":0.25},{"over":5479,"base":1102.60,"rate":0.30},{"over":21918,"base":6034.30,"rate":0.35}],"weekly":[{"over":0,"base":0,"rate":0},{"over":4808,"base":0,"rate":0.15},{"over":7692,"base":432.60,"rate":0.20},{"over":15385,"base":1971.20,"rate":0.25},{"over":38462,"base":7740.45,"rate":0.30},{"over":153846,"base":42355.65,"rate":0.35}],"semi_monthly":[{"over":0,"base":0,"rate":0},{"over":10417,"base":0,"rate":0.15},{"over":16667,"base":937.50,"rate":0.20},{"over":33333,"base":4270.70,"rate":0.25},{"over":83333,"base":16770.70,"rate":0.30},{"over":333333,"base":91770.70,"rate":0.35}],"monthly":[{"over":0,"base":0,"rate":0},{"over":20833,"base":0,"rate":0.15},{"over":33333,"base":1875.00,"rate":0.20},{"over":66667,"base":8541.80,"rate":0.25},{"over":166667,"base":33541.80,"rate":0.30},{"over":666667,"base":183541.80,"rate":0.35}]}'::jsonb
),
(
  'bir_annual', '2023-01-01', null,
  'Annual graduated income tax table for individuals (2023 onwards, TRAIN). Includes the P90,000 tax-exempt cap for 13th month pay and other benefits (Sec. 32(B)(7)(e) NIRC).',
  'https://www.bir.gov.ph/income-tax',
  '{"brackets":[{"over":0,"base":0,"rate":0},{"over":250000,"base":0,"rate":0.15},{"over":400000,"base":22500,"rate":0.20},{"over":800000,"base":102500,"rate":0.25},{"over":2000000,"base":402500,"rate":0.30},{"over":8000000,"base":2202500,"rate":0.35}],"other_benefits_exemption_cap":90000}'::jsonb
);

-- ---------- 2026 holidays (Proclamations 1006, 1189, 1264) ----------
insert into public.holidays (holiday_date, name, kind) values
('2026-01-01', 'New Year''s Day', 'regular'),
('2026-03-20', 'Eid''l Fitr', 'regular'),
('2026-04-02', 'Maundy Thursday', 'regular'),
('2026-04-03', 'Good Friday', 'regular'),
('2026-04-09', 'Araw ng Kagitingan', 'regular'),
('2026-05-01', 'Labor Day', 'regular'),
('2026-05-27', 'Eid''l Adha', 'regular'),
('2026-06-12', 'Independence Day', 'regular'),
('2026-08-31', 'National Heroes Day', 'regular'),
('2026-11-30', 'Bonifacio Day', 'regular'),
('2026-12-25', 'Christmas Day', 'regular'),
('2026-12-30', 'Rizal Day', 'regular'),
('2026-02-17', 'Chinese New Year', 'special_non_working'),
('2026-04-04', 'Black Saturday', 'special_non_working'),
('2026-08-21', 'Ninoy Aquino Day', 'special_non_working'),
('2026-11-01', 'All Saints'' Day', 'special_non_working'),
('2026-11-02', 'All Souls'' Day', 'special_non_working'),
('2026-12-08', 'Feast of the Immaculate Conception', 'special_non_working'),
('2026-12-24', 'Christmas Eve', 'special_non_working'),
('2026-12-31', 'Last Day of the Year', 'special_non_working'),
('2026-02-25', 'EDSA People Power Revolution Anniversary', 'special_working');

-- ---------- leave types ----------
insert into public.leave_types (code, name, default_annual_days, paid, active) values
('SIL', 'Service Incentive Leave', 5, true, true),
('VL', 'Vacation Leave', 0, true, true),
('SL', 'Sick Leave', 0, true, true),
('ML', 'Maternity Leave (RA 11210)', 105, true, true),
('PL', 'Paternity Leave (RA 8187)', 7, true, true),
('SPL', 'Solo Parent Leave (RA 11861)', 7, true, true),
('VAWC', 'VAWC Leave (RA 9262)', 10, true, true),
('MCW', 'Special Leave for Women (RA 9710)', 60, true, true),
('LWOP', 'Leave Without Pay', 0, false, true);

-- ---------- minimum wage reference (Wage Order NCR-27, eff. 25 Jul 2026) ----------
update public.company_settings
set minimum_wage_daily = 755.00,
    minimum_wage_region = 'NCR non-agriculture (WO NCR-27, eff. 25 Jul 2026)'
where id = 1;
