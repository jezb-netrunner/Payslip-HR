# Payroll spec mapping

Maps *Payroll Tax and Contribution Rules: Change Spec* (version 2026-10-25,
owner Jez, CPA) onto the existing code, as the spec's §0 step 2 requires.
Written before any code change. Section 3 lists the conflicts the spec does
not cover; per §0 step 8 they need the owner's decision before the tasks that
depend on them.

## 1. Where each spec concept lives today

| Spec concept | Existing code and data |
|---|---|
| Pay codes | **There is no pay-code list.** Every earnings line has a `BirBucket` (`src/payroll/types.ts`): `basic`, `holiday`, `overtime`, `night_diff`, `hazard`, `thirteenth`, `other_benefits`, `de_minimis`, `representation`, `transportation`, `cola`, `housing`, `other_taxable`, `other_non_taxable`. Admins pick one on recurring allowances (`employee_allowances.category`) and on one-time earnings (`payroll_adjustments.category`, plus `benefit` = `sss_maternity` / `maternity_differential`). The engine's own lines carry a `code`: `basic`, `absence`, `late`, `undertime`, `extra_hours`, `maternity`, `holiday_unpaid`, `outside_employment`, `ot`, `nd`, `restday`, `special`, `holiday`, `allowance`, `adjustment`, `thirteenth`. |
| Tax tables | `statutory_versions` rows (`bir_wht`, `bir_annual`). They ship by migration, are read-only for API roles, are checked by `valid_statutory_data` / `valid_tax_brackets`, and are frozen once a finalized payroll may have used them (`guard_statutory_version`). Mirrored for tests in `src/payroll/defaults.ts`. Loaded by `getStatutoryTables(asOf)` (`src/lib/api.ts`): withholding and annual tables by pay date, contribution tables by period end (`computeRun`, `src/payroll/service.ts`). |
| Tax computation | `taxFromBrackets`, `computeWithholdingTax` (`src/payroll/statutory.ts`). Taxable pay per period: the "withholding tax" block of `computePayslip` (`src/payroll/engine.ts`). 13th-month runs: `computeThirteenthMonth`. |
| ₱90k bucket | Per payroll: `benefitsExemptLeft` (service) → `benefitsExcess` (engine). Per year: `summarizeYear` (`src/payroll/annual.ts`). |
| De minimis | Category `de_minimis`, always non-taxable. No ceilings are stored; the admin is responsible for them. |
| MWE | Manual checkbox `employees.is_minimum_wage_earner`. One current minimum wage per client (`entities.minimum_wage_daily`, `minimum_wage_region`, `minimum_wage_reference`). Exempt buckets in `isTaxableBucket` (`annual.ts`); warnings in `computePayslip`. |
| SSS | `computeSss` (`statutory.ts`). Base: earnings in `SSS_COMPENSATION_BUCKETS` (`sssCompensation`, `engine.ts`). Earlier payrolls of a month deduct a share on the rate; the month's closing payroll settles on actual pay, with a refund line when too much was taken (`monthContributions`). |
| PhilHealth | `computePhilHealth`. Employee-share waiver: `employees.philhealth_ee_waiver` (`pwd` / `solo_parent`) with `philhealth_ee_waiver_from` / `_until` dates, checked against the period end (`philhealthWaiverFor`, `service.ts`). |
| Pag-IBIG | `computePagibig`. Base: monthly basic plus allowances except `other_benefits` (`engine.ts`). Ceiling: the table's `max_fund_salary` (₱10,000). |
| Maternity | Leave code `ML` (not paid as salary). Adjustments with `benefit` `sss_maternity` / `maternity_differential`, both `other_non_taxable`; the differential counts for the 13th month (`thirteenthBasis`). Neither is SSS compensation. |
| YEA | `payroll_runs.annualize` (December pay dates only) and separations call `annualizedWithholding` (`annual.ts`). A refund is a negative withholding line. There is no net-pay cap, no employer-paid shortfall, no Jan 25 refund date and no 1601-C recovery. |
| Previous employer | `employee_tax_years` (`prev_*` amounts, `prev_employment_from` / `_to`, `prev_tax_withheld`) → `priorFromTaxYear` (`src/payroll/alphalist.ts`). Used by annualization and the alphalist only. |
| Closed periods | Finalized and paid runs (`finalize_payroll_run`). Their payslips are stored and never recomputed; their attendance is locked (`attendance_locked`). |
| Client settings | `entities` columns, created in `src/pages/admin/Clients.tsx` and edited in `src/pages/admin/Settings.tsx`. There is no settings table for all clients. |
| Exports | BIR & Reports (`src/pages/admin/Reports.tsx`): alphalist CSV per schedule (`alphalistCsv`), BIR 2316 working figures (`Form2316Modal`), 1604-C summary, 1601-C remittance records (`tax_remittances`). No 1601-C line 15–19 figures. |
| Due dates | Dashboard tiles say "remit next month — check the agency's schedule". No dates, on purpose (MEMORY.md, *Remittance due dates are not verified facts*). |
| Holiday pay after an absence | `unworkedHolidaysPaid` (`engine.ts`), always applied. |
| Employee documents | None. Only the `employee-photos` storage bucket exists. |
| Leave cash conversion | Not a payroll item. Insights only estimates unused SIL. |
| Hazard pay | Allowance category `hazard`. Exempt for every MWE; no criteria or DOLE certification fields. |

## 2. Task by task

| Task | Today | What changes |
|---|---|---|
| T1 Tables | All 24 Annex E rows, the annual table and the ₱90k cap match the spec exactly, in the DB seed and in `defaults.ts`. The daily top base is 6,034.30. The row lookup uses "lower bound < amount", which gives the same tax because the tables are continuous. No de minimis ceilings. | Row lookup "lower bound ≤ amount" (T2 needs it). One test per row and a continuity test. De minimis ceilings stored as a dated table version (new kind `de_minimis`, effective 2026-01-07). |
| T2 Method | Table lookup on R + S, plus the benefits excess. | Regular method (row from R only) and CAM with triggers a–c, kept per employee for the rest of the year. Needs every line classed as R or S. |
| T3 SSS base | Buckets basic, holiday, OT, ND, hazard, COLA, representation, transportation, housing, other taxable. Bonuses, 13th month, de minimis and other non-taxable pay are left out. | `sss_include` per pay code. Bonuses other than the Christmas bonus become included; liquidated allowances are left out. New fields `is_christmas_bonus`, `subject_to_liquidation`. |
| T4 Maternity | Two benefit kinds on adjustments, both exempt, neither SSS. | Codes MAT_SSS_BENEFIT and MAT_DIFFERENTIAL with settings P1, P3 and P9. The differential is SSS-included, and S when taxable. Client exemption category, DOLE approval reference and year, and the "Differential required" error. P4 badge. |
| T5 MWE premiums | An MWE's rest-day, special-day and holiday premiums (bucket `holiday`) are fully exempt; hazard pay is always exempt. | The add-on above the SMW day (30% / 50%, and above 200% on a regular holiday that is a rest day) becomes S. Hazard pay is exempt only with the criteria flag and a DOLE reference. Add-ons stay out of the MWE boxes of the 2316 and 1601-C. |
| T6 PhilHealth | Waiver by date range, checked on the period end. No status, SPIC expiry or documents. | Monthly waiver: `waiver_start_month`, `spic_expiry` (the month must be fully covered), PWD `philhealth_status`. 30-day SPIC warning, past-period warning on PWD confirmation, five document slots. The tax exclusion is already 0 in waived months (nothing is deducted). |
| T7 De minimis | No ceilings, no per-item tracking, no leave-conversion pay. | Per-item usage by month, semester or year, with the excess going to the ₱90k bucket. Client `leave_policy`. VL conversion (12 days de minimis) and SIL conversion (S). Meal allowance cap from the SMW table (T12). |
| T8 YEA | Annualizes in the last December payroll or at separation; a refund is negative withholding. | Shortfall capped at net pay, the rest recorded as "tax paid by employer" and an employee advance. Refund by Jan 25, recovered against 1601-C remittances. 2316 at final pay. Previous-employer figures also feed CAM. |
| T9 Due dates | No dates (on purpose). | Client `filing_mode` and `efps_group`; computed 1601-C and annual dates with weekend marks and overrides; SSS, PhilHealth and Pag-IBIG dates as settings with no default (P6). |
| T10 Exports | Alphalist CSV (working data for the BIR module), 2316 figures, 1604-C summary, 1601-C records. | MWE hazard-pay fields in the alphalist. 2316 with MWE amounts shown separately, the previous employer, and issue at final pay. 1601-C lines 15–19 only "if the app outputs them" (it doesn't today). |
| T11 Pag-IBIG | Base = basic + allowances except other benefits; ceiling from the table. | Settings for the base components and the ceiling (defaults = today), P5 badge. Exclude only the compulsory share from taxable pay. |
| T12 SMW and MWE | One minimum wage per client; MWE is a manual checkbox. | Dated minimum-wage table per region and sector with wage-order references. MWE status computed per period (rate ≤ SMW), "Below minimum wage" warning, recompute of open periods after a retroactive wage order, WAGE_ORDER_TOPUP code, client setting for the holiday-pay rule. |

## 3. Conflicts the spec does not cover: owner's decision needed

1. **There are no pay codes** (blocks T2–T7 and T12). The spec keys most rules
   to pay-code fields (`sss_include`, `is_christmas_bonus`,
   `subject_to_liquidation`, `include_in_13th_month_base`, R or S, de minimis
   item). Proposal: add a pay-code list that starts from today's 14 categories
   and adds the codes the spec names (Christmas bonus, liquidated
   reimbursements, MAT_SSS_BENEFIT, MAT_DIFFERENTIAL, WAGE_ORDER_TOPUP, VL and
   SIL conversion, commission, one code per de minimis item a and c–k). Each
   code carries the spec's fields. Allowances and one-time earnings pick a
   code instead of a category, and existing rows move to the matching code.
   R = basic pay and allowances paid every period; S = overtime, premiums and
   night differential (non-MWE), hazard pay (when taxable), one-time taxable
   earnings and the ₱90k excess.
2. **Money is JavaScript numbers, not a decimal type** (spec §0 step 10). The
   engine rounds to centavos at each line. Converting all of it is a large
   change. Proposal: compute every new or changed tax and contribution amount
   in exact whole centavos (no floating-point error), and leave the rest of
   the engine as it is.
3. **Existing "other benefits" lines** (T3). The spec includes bonuses in SSS
   except the Christmas bonus, but today's category doesn't say which kind a
   line is. Proposal: existing lines become a general "other bonus" code (SSS
   included); admins switch any Christmas bonus to the Christmas-bonus code.
4. **MWE checkbox** (T12). The spec computes MWE status from the rate and the
   SMW. Proposal: the checkbox goes away and the status is shown, computed.
5. **Existing PhilHealth waivers** (T6). Proposal: the start date becomes the
   start month; a solo parent's end date becomes the SPIC expiry; an existing
   PWD waiver becomes `confirmed`, so today's results don't change.
6. **1601-C lines 15–19 and the quarterly MWE hazard list** (T10) apply "if
   the app outputs them", and it doesn't. Build them, or skip?
7. **Who maintains the SMW table** (T12). Tax and contribution tables are
   read-only and ship with the software, but the spec has the user adding SMW
   rows (today the minimum wage is a client setting admins edit). Proposal:
   company admins maintain it in the app, with the audit log.

## 4. Settled without asking

- **De minimis effective date 2026-01-07 vs. the first-of-month rule.** The
  database requires table versions to start on the 1st. That rule exists
  because contribution tables follow the payroll month; BIR tables follow the
  pay date, so a mid-month date is valid for them. The rule now applies to
  the SSS, PhilHealth and Pag-IBIG tables only, and the spec's date is used.
- **The live database is not touched.** Migrations ship on the branch and are
  applied when the owner approves (README, *Updating the statutory tables*).
