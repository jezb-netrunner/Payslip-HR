// Canonical statutory table data used to seed `statutory_versions` and as
// fixtures for engine tests. THE DATABASE IS THE SOURCE OF TRUTH at runtime —
// the app always computes from the versioned rows in Supabase. Users never
// edit them: a new version ships as a migration (README, "Updating the
// statutory tables"), checked by the database before it applies.
//
// Figures verified against official sources as of August 2026:
//  - SSS: RA 11199 schedule — 15% total (10% ER / 5% EE) effective Jan 2025,
//    MSC ₱5,000–₱35,000 in ₱500 steps; MSC above ₱20,000 goes to the
//    Mandatory Provident Fund (WISP). EC: ₱10 (MSC < ₱15,000) / ₱30.
//  - PhilHealth: UHC Act (RA 11223) — 5% of basic monthly salary,
//    floor ₱10,000 / ceiling ₱100,000, split equally ER/EE.
//  - Pag-IBIG: HDMF Circular 460 — max fund salary ₱10,000 effective
//    Feb 2024; EE 1% (≤₱1,500) or 2%, ER 2%.
//  - BIR: TRAIN law (RA 10963) revised withholding tax tables effective
//    01 Jan 2023 (RR 11-2018 as amended); ₱90,000 exemption cap for 13th
//    month pay and other benefits (RA 10963, Sec. 32(B)(7)(e) NIRC).
//    Checked row for row against the owner's payroll tax rules spec
//    (2026-10-25, T1), which also gives the de minimis ceilings below.

import type {
  BirAnnualData,
  BirWhtData,
  DeMinimisData,
  PagibigData,
  PayrollRules,
  PhilHealthData,
  SssTableData,
  StatutoryTables,
} from './types'

export const SSS_2025: SssTableData = {
  rate_ee: 0.05,
  rate_er: 0.1,
  msc_min: 5000,
  msc_max: 35000,
  msc_step: 500,
  mpf_threshold: 20000,
  ec_er_low: 10,
  ec_er_high: 30,
  ec_threshold_msc: 15000,
}

export const PHILHEALTH_2024: PhilHealthData = {
  rate: 0.05,
  floor: 10000,
  ceiling: 100000,
}

export const PAGIBIG_2024: PagibigData = {
  max_fund_salary: 10000,
  ee_rate_low: 0.01,
  ee_rate_high: 0.02,
  low_threshold: 1500,
  er_rate: 0.02,
}

// BIR revised withholding tax tables, effective 01 Jan 2023 onward.
export const BIR_WHT_2023: BirWhtData = {
  daily: [
    { over: 0, base: 0, rate: 0 },
    { over: 685, base: 0, rate: 0.15 },
    { over: 1096, base: 61.65, rate: 0.2 },
    { over: 2192, base: 280.85, rate: 0.25 },
    { over: 5479, base: 1102.6, rate: 0.3 },
    { over: 21918, base: 6034.3, rate: 0.35 },
  ],
  weekly: [
    { over: 0, base: 0, rate: 0 },
    { over: 4808, base: 0, rate: 0.15 },
    { over: 7692, base: 432.6, rate: 0.2 },
    { over: 15385, base: 1971.2, rate: 0.25 },
    { over: 38462, base: 7740.45, rate: 0.3 },
    { over: 153846, base: 42355.65, rate: 0.35 },
  ],
  semi_monthly: [
    { over: 0, base: 0, rate: 0 },
    { over: 10417, base: 0, rate: 0.15 },
    { over: 16667, base: 937.5, rate: 0.2 },
    { over: 33333, base: 4270.7, rate: 0.25 },
    { over: 83333, base: 16770.7, rate: 0.3 },
    { over: 333333, base: 91770.7, rate: 0.35 },
  ],
  monthly: [
    { over: 0, base: 0, rate: 0 },
    { over: 20833, base: 0, rate: 0.15 },
    { over: 33333, base: 1875, rate: 0.2 },
    { over: 66667, base: 8541.8, rate: 0.25 },
    { over: 166667, base: 33541.8, rate: 0.3 },
    { over: 666667, base: 183541.8, rate: 0.35 },
  ],
}

// Annual graduated income tax table (2023 onward) — used for annualization
// context and the 13th-month exemption cap.
export const BIR_ANNUAL_2023: BirAnnualData = {
  brackets: [
    { over: 0, base: 0, rate: 0 },
    { over: 250000, base: 0, rate: 0.15 },
    { over: 400000, base: 22500, rate: 0.2 },
    { over: 800000, base: 102500, rate: 0.25 },
    { over: 2000000, base: 402500, rate: 0.3 },
    { over: 8000000, base: 2202500, rate: 0.35 },
  ],
  other_benefits_exemption_cap: 90000,
}

// Basis: RR 2-98 §2.78.1(A)(3), as amended by RR 29-2025 §1 (dated Oct 27, 2025; BIR CDN).
// RR 29-2025 §3: effective "after fifteen (15) days following its publication"; posted
// 2025-12-22, so day 15 is 2026-01-06 and pay dated 2026-01-07 or later uses these
// (the owner's safe date; secondary sources say 2026-01-06). Item (b) is for
// government employees only. Ceilings for pay dated before 2026-01-07 are not on file.
export const DE_MINIMIS_2026_EFFECTIVE = '2026-01-07'

export const DE_MINIMIS_2026: DeMinimisData = {
  items: [
    { item: 'a', label: 'Cash conversion of unused vacation leave credits (private employees)', unit: 'days_per_year', limit: 12 },
    { item: 'c', label: 'Medical cash allowance to dependents of employees', unit: 'per_semester', limit: 2000, per_month: 333 },
    { item: 'd', label: 'Rice subsidy (or one 50-kg sack a month worth up to the ceiling)', unit: 'per_month', limit: 2500 },
    { item: 'e', label: 'Uniform and clothing allowance', unit: 'per_year', limit: 8000 },
    { item: 'f', label: 'Actual medical assistance', unit: 'per_year', limit: 12000 },
    { item: 'g', label: 'Laundry allowance', unit: 'per_month', limit: 400 },
    { item: 'h', label: 'Employee achievement awards under a written plan', unit: 'per_year', limit: 12000 },
    { item: 'i', label: 'Christmas and major anniversary gifts', unit: 'per_year', limit: 6000 },
    { item: 'j', label: 'Daily meal allowance for overtime work and night or graveyard shift', unit: 'share_of_regional_minimum_wage', limit: 0.3 },
    { item: 'k', label: 'CBA benefits and productivity incentives, combined', unit: 'per_year', limit: 12000 },
  ],
}

export const DEFAULT_TABLES: StatutoryTables = {
  sss: SSS_2025,
  philhealth: PHILHEALTH_2024,
  pagibig: PAGIBIG_2024,
  bir_wht: BIR_WHT_2023,
  bir_annual: BIR_ANNUAL_2023,
  de_minimis: DE_MINIMIS_2026,
  de_minimis_from: DE_MINIMIS_2026_EFFECTIVE,
}

/** The PENDING rules' defaults: today's behavior (spec P4). */
export const DEFAULT_PAYROLL_RULES: PayrollRules = {
  maternityContributions: 'as_usual',
  // P5: today's rule — basic pay plus the regular allowances, up to the table's maximum fund salary
  pagibigBase: { basic: true, cola: true, otherAllowances: true },
  pagibigCeiling: null,
  // the apprentice rule, PENDING (owner 2026-10-25): today's behavior
  apprenticeMwe: true,
}
