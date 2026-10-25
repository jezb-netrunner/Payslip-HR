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
| T8 YEA | Annualizes in the last December payroll or at separation; a refund is negative withholding. | Shortfall capped at the pay left after contributions and union dues (the tax before loans, owner 2026-10-25), the rest recorded as "tax paid by employer" and an employee advance. Refund by Jan 25, recovered against 1601-C remittances. 2316 at final pay. Previous-employer figures also feed CAM. |
| T9 Due dates | No dates (on purpose). | Client `filing_mode` and `efps_group`; computed 1601-C and annual dates with weekend marks and overrides; SSS, PhilHealth and Pag-IBIG dates as settings with no default (P6). |
| T10 Exports | Alphalist CSV (working data for the BIR module), 2316 figures, 1604-C summary, 1601-C records. | MWE hazard-pay fields in the alphalist. 2316 (September 2021 ENCS, item numbers printed, owner 2026-10-25) with MWE amounts shown separately, the previous employer, and issue at final pay. ₱250,000 and below reported non-taxable. 1601-C lines 15–19 only "if the app outputs them" (it doesn't today). |
| T11 Pag-IBIG | Base = basic + allowances except other benefits; ceiling from the table. | Settings for the base components and the ceiling (defaults = today), P5 badge. Exclude only the compulsory share from taxable pay. |
| T12 SMW and MWE | One minimum wage per client; MWE is a manual checkbox. | Dated minimum-wage table per region and sector with wage-order references. MWE status computed per period (rate ≤ SMW), "Below minimum wage" warning, recompute of open periods after a retroactive wage order, WAGE_ORDER_TOPUP code, client setting for the holiday-pay rule. |

## 3. Conflicts the spec does not cover, and the owner's decisions

**Decided 2026-10-25 (owner):** proposals 1–5 and 7 as written below; item 6
skipped (no 1601-C lines 15–19, no quarterly MWE hazard-pay list).

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
   the app outputs them", and it doesn't. **Skipped** (owner, 2026-10-25).
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

## 5. Readings taken in T2

The spec is silent on these; T2 implements the reading named. The owner
accepted 1, 2, 3 and 5 and changed 4 (2026-10-25).

1. **Trigger (b) needs S above 0.** "S for the period is equal to or more
   than R" would otherwise hold for a payroll with no pay at all (0 ≥ 0)
   and start CAM for an employee on unpaid leave.
2. **A 13th-month payslip is not a period in the 0% row (trigger a).** A
   13th-month run pays no regular compensation of its own (the period's R
   is in its regular payroll), so its R of 0 doesn't count; its taxable
   excess still triggers (b), and CAM already on stays on.
3. **Payrolls paid before T2 count for the triggers.** Their R and S are
   derived from the stored lines (basic pay and allowances less the
   contributions = R, the rest of the taxable pay = S). Their tax is not
   changed (§0 step 7).
4. **`n` counts only the pay periods with employment** (changed by the
   owner, 2026-10-25; basis RR 2-98 §2.79(B)(5)(a) Step 2, "the number of
   payroll period to which the amount relates"): the previous employer's
   from–to and this employer's periods from its first pay of the year, in
   periods of the current payroll frequency, a period both jobs fall in
   counted once, the gap between jobs not counted. Without the previous
   employer's dates it counts straight through from its start (from
   January 1 when the start is missing), with a warning.
5. **Draft payrolls are marked for recomputing** when the T2 migration is
   applied, so no draft computed on the old method is finalized.

## 6. Decisions taken in T3–T12 (owner: "continue with all the edits", 2026-10-25)

The owner asked for T3–T12 without stopping between tasks and will answer
questions at the end. Where the spec or the code left a choice, the choice
below was made and is easy to change.

**T3 (SSS base)**
- New codes: CHRISTMAS_BONUS (one-time only), LIQUIDATED_ALLOWANCE and
  THIRTEENTH_MONTH (the 13th month run's own code, so P2 has a setting for
  it). Owner's answer (2026-10-25): LIQUIDATED_ALLOWANCE ("Business expense
  reimbursement (liquidated)") is non-taxable only when it repays an
  expense the employee paid for the employer's business (travel,
  representation), liquidated with receipts. The employee's own board and
  lodging is BOARD_LODGING: taxable pay (R when paid each period) for
  rank-and-file staff; for managerial or supervisory staff (the employee's
  new job level) a fringe benefit — on the payslip, not withheld on, left
  out of the 2316 compensation, and flagged for the fringe benefit tax
  review (NIRC §32(A)(1); §33(A), (B)(1), (C)(3)). PENDING: the exact
  conditions in RR 2-98 §2.78.1(A) and RR 3-98 §2.33. BOARD_LODGING is in
  the SSS base (taxable pay; not part of the question).
- The P2/P3 settings apply to all clients (the codes are shared); only
  company admins change them, on the Statutory Tables page, and a change
  marks every client's draft payrolls for recomputing.
- With 13th month pay switched into the SSS base, the month's last regular
  payroll settles it; a 13th month paid after that payroll was finalized
  shows a warning to reopen and recompute it.

**T4 (maternity)**
- P1, P9 and P4 are global settings (all clients), changed by company
  admins on the Statutory Tables page ("Rules pending legal confirmation").
- P1's default "taxable" changes today's result: new payrolls tax the
  differential as S (finalized ones are unchanged).
- P4 needed an alternative to today's rule; the one built is "no PhilHealth
  or Pag-IBIG (employee and employer) on a payroll whose scheduled days are
  all maternity leave". Owner's answer (2026-10-25): keep the default
  "deduct and remit as usual" and leave the alternative off. PENDING: the
  PhilHealth and Pag-IBIG rules for members on leave (not read yet).
- The spec's "show the error" is a new kind of message: it blocks
  finalizing (the database refuses too) until the differential is added or
  the client's DOLE exemption for the payroll year is recorded. A
  differential paid earlier in the same leave (a lump sum) satisfies later
  payrolls of the leave.
- The exemption record is per client (category, DOLE approval reference,
  the year it covers), on Client Settings.

**T5 (MWE premiums, hazard pay)**
- The split applies to MWEs only; a non-MWE's premium lines are unchanged
  (all taxable anyway). For an MWE paid monthly (divisor 261), the exempt
  part of rest-day pay stays on the "Rest Day Pay" line, reported with
  holiday pay in the MWE boxes; for a daily-paid MWE the day at the SMW is
  basic pay, as before.
- The hazard pay criteria and the DOLE certification reference are one flag
  and one reference per employee (Employee → Pay), not per allowance.
- Since T5 taxable lines say R or S; in the year summary (2316 figures)
  other taxable S pay (commission, other one-time pay, the MWE add-ons) now
  goes to the supplementary "Others" box instead of the regular one.

**T6 (PhilHealth NG share)**
- The waiver month is the payroll month (contributions follow it). A
  month the SPIC covers only in part is no longer waived — for an existing
  solo parent whose end date fell mid-month, that month's employee share is
  now deducted (the spec's rule).
- A solo parent without an SPIC expiry on file gets no NG share (payroll
  warns), so the expiry is required on the form.
- The "past periods" warning is on the employee's Pay tab (it lists the
  finalized months that deducted the share while the NG share now covers
  them), not repeated on every payslip.
- The spec's five slots hold six files: the SPIC (or PWD ID) has a front and
  a back slot. Files are private to the admins of the employee's client.

**T7 (de minimis)**
- The spec gives no default `leave_policy`; existing clients start on "SIL
  only" (the Labor Code minimum), which taxes leave conversion. Owner's
  answer (2026-10-25): keep that default, and when an admin changes a
  client's policy during the year the year-end adjustment reclassifies
  that year's leave conversions under the policy in force (de minimis up to
  the item (a) days in pay-date order, the rest to the ₱90k bucket; or all
  taxable S). The 2316 and alphalist classify them the same way; the
  payslips themselves keep their lines.
- One LEAVE_CONVERSION code whose tax follows the client's leave policy,
  rather than separate VL and SIL codes. It needs the days converted.
- Ceiling windows follow the pay date (the pay month, half-year or year),
  like the tax year, and only pay dated on or after the ceilings' effective
  date counts. A monthly allowance paid semi-monthly therefore meets the
  monthly ceiling by the payments made in each calendar month.
- Item (j), the meal allowance: 30% of the client's daily minimum wage for
  each day of the payroll with overtime or night work (T12's wage table
  supplies the minimum wage).
- The item-less DE_MINIMIS code is retired: existing allowances keep it
  (unchecked, with a warning on each payroll) until an admin picks the item.


**T8 (year-end adjustment)**
- Owner's answer (2026-10-25, replaces "up to the net pay available"):
  the last pay of the year deducts (1) the compulsory contributions and
  union dues, (2) the YEA tax, (3) loans, cash advances and other
  deductions, each from what is left (a loan's balance stays owed for the
  part not taken). The employer pays only the part of the tax that is more
  than the pay left after (1) (RR 2-98 §2.79(B)(5)(b) Step 4, as amended by
  RR 11-2018 §7). Payrolls that don't annualize keep their order.
- The employer-paid part counts as tax withheld for the year: in the 2316
  and alphalist it is part of the December (or final-pay month) withholding,
  with a separate "of which paid by the employer" line on the 2316 figures,
  so the employee's year reconciles. It is remitted with that month's
  1601-C.
- The "employee advance" is a cash advance created when the run is
  finalized, paused and without a signed authorization: payroll never
  deducts it until an admin records the date the employee signed the
  authorization to deduct and resumes it (Labor Code Art. 113). It can't
  be deleted or have its amount changed (reopening the payroll removes it,
  unless part of it was repaid). Owner's answer (2026-10-25): no "forgive":
  the employee repays it. PENDING: the tax treatment of a forgiven advance
  (RR 3-98 not read yet).
- Refunds stay part of the annualizing payslip (paid with it, so always by
  January 25). The 1601-C page shows per month the tax withheld, the
  employer-paid tax, the refunds recovered and what is left to remit;
  refunds a month can't absorb carry into later months, from December into
  the next year. Recording a month prefills "taxes withheld" with withheld +
  employer-paid and "adjustment" with the refunds recovered (negative).
- Separations already annualized on the payroll that holds the last day;
  their 2316 figures are now one click away on that finalized run ("BIR
  2316 (final pay)"). T10 reworks the 2316 layout.
- The previous-employer fields already existed (Employee → BIR data); a
  payslip now warns when an employee hired during the tax year has no BIR
  data row for it (saving the form with "no previous employer" clears it).

**T9 (due dates)**
- Existing clients start with no filing mode, so no 1601-C date is shown
  until an admin chooses "Manual or eBIRForms" or "eFPS" and the group on
  Client Settings (the spec gives no default; a wrong date is worse than
  none).
- The P6 settings are one number per agency: the day of the next month the
  client's remittance is due (blank = not set). The agencies' real rules go
  by employer number or name; a day that doesn't exist in a month (the 31st
  in February) becomes its last day.
- Only Saturdays and Sundays are marked, as the spec says; holidays are not
  (they are on the Holidays page). Overrides need a note, are per client,
  and are audit-logged.
- The calendar is BIR & Reports → Due dates (one year at a time: each
  month's 1601-C and contributions, then the tax year's annual dates); the
  dashboard's obligation tiles show the date in force.

**T10 (BIR exports)**
- Owner's answer (2026-10-25; spec updated: the 2316 is September 2021
  (ENCS), RMC 34-2022, Mar 30, 2022, not January 2018): the 2316 figures
  print the form's item numbers. Part I 1–11 (5 RDO code; 6/6A registered
  address and ZIP; 6B/6C local home address and ZIP; 6D foreign address; 7
  birth date; 8 contact number; 9–10 SMW per day and per month; 11 the MWE
  box), Part II 12–15 (15 main or secondary employer), Part III 16–18A,
  Part IV-A 19–28 (25A/25B present and previous employer), IV-B A 29–38,
  IV-B B regular 39–44B, supplementary 45–52 (45 commission, 46 profit
  sharing, 47 fees including director's fees, 48–51B), signatures 53–56
  (55 and 56 for substituted filing). New fields: the employee's RDO code,
  local home address and ZIP and foreign address (Personal info), and the
  employer type per tax year (BIR data, main by default). Items 46 and 47
  are 0: no pay code feeds them; COMMISSION feeds item 45 (the alphalist
  keeps it in "Other supplementary", which has no commission column).
- Owner's answer (2026-10-25): when an employee's taxable pay for the year
  (this employer plus any previous employer, before the move) is within
  the annual table's 0% row (₱250,000, read from the table), the present
  employer's taxable pay is reported as non-taxable: on the 2316 basic
  salary in item 29 and the rest in item 37 (items 21 and 52 become 0;
  item 22 keeps the previous employer's figure as entered); in the
  alphalist all of it in "Salaries (P250,000 & below) & Other Forms of
  Compensation". Tax due stays 0, the 1601-C is not changed. Basis: BIR
  Form 2316 (September 2021 ENCS) item 29; alphalist Schedule 1, revised
  format (RMC 160-2022, Dec 27, 2022). `lowIncomeReport` in
  `src/payroll/annual.ts`.
- The MWE hazard pay fields are four columns in both schedule CSVs (period
  of employment from/to, amount, DOLE certification reference), filled only
  for exempt MWE hazard pay; an MWE's hazard pay taxed for lack of the
  criteria (T5) is in the taxable hazard column, without them.
- No DAT file (P7); 1601-C lines 15–19 and the quarterly hazard list are
  skipped (owner's decision); refunds already reduce the 1601-C (T8).

**T11 (Pag-IBIG, P5)**
- The settings are for every client (like P4), changed by company admins on
  Statutory Tables. The ceiling left blank means the statutory table's
  maximum fund salary (₱10,000 now), so a new table version still applies
  unless a ceiling is typed in.
- "Mandated COLA" is the allowances with the COLA pay code; "other regular
  allowances" is every other allowance except those in the ₱90k bucket (de
  minimis and liquidated allowances included, as before).
- The app has no voluntary Pag-IBIG contribution, so only the computed
  compulsory share is ever excluded from taxable pay; a voluntary amount
  recorded as an ordinary deduction stays taxable.

**T12 (minimum wage, MWE status, holiday pay)**
- The minimum wage table ships empty: no rate is typed in from memory.
  Until company admins enter a region's wage orders, payroll uses the
  client's own daily minimum wage (as today) and says so on the payslips
  whose status depends on it.
- A client's sector is free text matching the table's sector; with no rate
  for its sector, the region's general rate applies.
- MWE status uses the rate in force on the period's last day, and the
  employee's basic daily rate (monthly rate × 12 ÷ the days-per-year
  factor). An apprentice at 75% of the minimum is an MWE; the "Below
  minimum wage" warning for an apprentice starts below 75%.
- The old employee checkbox is no longer used (its column stays until the
  new screens are live, then can be dropped). Employees whose checkbox
  disagreed with their rate change status on their next payroll.
  *Question: confirm, since it changes their tax (an employee paid above
  the minimum loses the exemption; one at it gains it).*
- "The YEA corrects the year": the year-end adjustment re-tests each
  finalized payslip of the year against the table (its period end, the
  rate on its snapshot) and treats it as MWE pay or not accordingly; the
  2316 and alphalist do the same. A finalized non-MWE payslip re-tested as
  MWE exempts its basic, holiday, overtime and night differential lines in
  full (its rest-day premium wasn't split into the exempt day and the
  taxable add-on).
- WAGE_ORDER_TOPUP is a one-time code (the difference for days already
  paid); a recurring top-up would need a new allowance bucket, so raise the
  employee's rate instead.
- Holiday pay after an unpaid absence: "apply the rule" (default) or "pay
  anyway", per client.
