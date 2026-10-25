# MEMORY.md — running memory log for Payslip-HR

One markdown log so separate AI/human sessions have self-reinforcing context:
what previous instances **did** (session log), what is **true right now**
(deployed state), and what they **learned** (lessons).

**Maintenance rules**
1. One lesson per entry, with a one-line `> summary` right under its heading.
2. Record corrections and confirmed approaches alike, and always *why it
   mattered* — an entry without consequences teaches nothing.
3. Don't log what the repo or git history already records; entries are for the
   non-obvious: gotchas, corrections, verified external facts, decisions with
   reasons, and live-system state the repo can't prove.
4. Update an existing entry rather than adding a near-duplicate; delete
   entries that turn out to be wrong. Append a dated session-log entry for
   each working session that changed something.

---

## Session log

### 2026-08-23 — Initial build (entire system, one session)

**Did:**
- Researched and verified all PH statutory figures via a parallel research
  workflow (one agent per domain: BIR / SSS / PhilHealth / Pag-IBIG / labor
  standards), each cross-checked by an adversarial verifier agent.
- Built the Supabase backend on project `ruuhpghcgccvezkjhisy`: 7 migrations
  (core tables → functions/triggers → RLS → time-clock RPCs → storage →
  seeds → privilege hardening), deployed the `admin-users` edge function,
  seeded statutory tables / 2026 holidays / leave types / settings.
- Built the React app: payroll engine (+32 unit tests, all passing), admin
  console (dashboard, employees + career history, attendance review, leaves,
  payroll runs, statutory viewer, holidays, settings, audit log), employee
  portal (selfie-verified time clock, attendance, corrections, leaves,
  payslips with PDF).
- Smoke-tested: build/tests/lint green; login page renders (Playwright);
  ran Supabase security advisors and fixed findings.
- Ran a 5-dimension adversarial code-review workflow (statutory math,
  attendance engine, service/data layer, security/RLS, React UI), each
  dimension's findings re-verified by a skeptic agent: **22 confirmed
  findings** (statutory 4, attendance/engine 12, security 6; service and UI
  clean). All fixed the same day — see the "Adversarial review findings"
  lesson; regression tests added (44 total, green); migration
  `security_and_integrity_fixes` applied; edge function redeployed as v2.

**Found (the important discoveries are the Lessons below):** two from-memory
statutory values were wrong before research (NCR wage, PhilHealth centavo
split); two of my own test vectors were wrong, not the code (SSS EC tier);
nested React components caused remount bugs; RLS policies recursed until
refactored to security-definer helpers.

### 2026-08-24 — Verification round (user-requested double-check)

**Did:** systematic verification of everything shipped: live DB probes
confirmed every security fix landed (policies, triggers, function bodies,
privileges); RLS simulated as a signed-in non-admin (all writes blocked, no
payroll_runs/audit rows visible, statutory tables readable); deployed edge
function diffed against the repo copy; tests/build re-run; then an
independent code-review pass over the post-workflow-review commits.

**Found and fixed (8 more real defects, mostly in the *fix* code itself):**
finalize/reopen were non-atomic and non-idempotent → moved into atomic DB
RPCs (`finalize_payroll_run` / `reopen_payroll_run` +
`adjust_run_deduction_balances`); the co-admin guard was bypassable by
demote-then-reset via the unrestricted profiles UPDATE policy → DB trigger
`profiles_protect_admins` (also blocks removing the last active admin);
`periodHalf` classified partial boundary-crossing periods as 'full'
(double pay) → now throws for irregular semi-monthly periods; interior
off-the-clock gaps beyond the break were never docked → charged as
undertime; ND-in-OT was attributed by `min()` instead of chronology →
attendance now computes `ndOtMinutes` from the OT tail; divisor-365 LWOP
over rest days wasn't deducted → unified builtIn-aware unpaid-leave rule;
reopen no longer un-pauses manually paused loans; defensive payslip
run-info backfill added. 47 tests green. Migration
`run_lifecycle_and_admin_protection` applied.

**Lesson reinforced:** the reviewers' fixes needed reviewing too — the
verification round found most of its defects in code written to fix the
previous round's defects.

### 2026-10-19/20 — Multi-client conversion (owner's change list)

**Asked:** admin-entered time in/out (no self-punch); multi-client app with
three tiers (company admin / entity admin / employee); employees log in with
an admin-set code; hire + separation dates and reasons; per-employee pay
frequency (weekly / semi-monthly / monthly); company admins can amend
statutory tables; announcements + employee dashboard with pay breakdown;
whole-peso cash pay for minimum-wage workers; TIN and everything BIR 1604-C
and the alphalist need.

**Did:** migrations `20261019120000_multi_client_schema` +
`20261019120100_multi_client_security` (entities, entity_admins, per-client
RLS, announcements, payroll_adjustments, tax_remittances, employee_tax_years;
clock RPCs / selfie policies / company_settings dropped); `admin-users` edge
function v3 (login codes, admin users); engine rewrite (frequencies, payroll
month slots, allocation, BIR buckets, MWE package, annualization, cash
rounding); new admin pages (Clients, Admin Users, Time In/Out, Announcements,
BIR & Reports, structured statutory editor) and employee dashboard. Tests 47
→ 94. Validated both migrations + an RLS suite on a local PG16 replica (see
lesson). **Live apply blocked** — see deployed state.

**Review round (same session):** five parallel reviewers (DB security,
payroll math, admin UI, schema↔query, auth/portal) reported ~45 verified
defects; all fixed with regression tests (109 unit tests; RLS suite grew to
cover each DB finding). The worst: a forged payslip deduction line could
zero another client's loan; finalized runs were writable outside the RPCs;
finalize accepted stale/partial drafts; final pay double-paid days or
skipped the separated employee; moved paydays broke weekly payroll-month
slots; employees could rewrite pending requests that approval then
applied; login codes were recoverable offline from the admin-readable
email hash. Every DB/RPC error message was hidden behind generic "Failed"
toasts (supabase-js error objects aren't `Error`s). See the lessons below.

**Go-live (2026-10-20):** owner ran both migrations in the SQL editor;
recorded them in the migration history, verified the live schema against
the local replica, deployed `admin-users` v3, ran the security advisors.
The `main` merge (front end) awaits the owner.

### 2026-10-20 — Comprehensive audit (owner: "check everything works, patch holes")

**Did:** browser walkthrough of every role and page on a local Supabase
stack (see lesson), desktop + 390/360 px; four parallel reviewers
(requirements trace, payroll math, DB concurrency, front end/security);
every verified finding fixed and regression-tested. Owner said **not** to
merge to `main` yet.

- Payroll: contributions over-collected when a month's runs were finalized
  out of order; a 13th month paid after the year's annualization never
  reconciled (and used the payroll year's ₱90k cap); tax tables were picked
  by period end instead of pay date; extras-only final pay applied loans
  and hid its warnings; employees left out of a run were never shown.
  `src/payroll/flows/` now runs computeRun end to end on an in-memory
  Supabase (fake mirrors the finalize RPC — keep it in sync).
- DB (`20261020031639_audit_fixes`, `20261020033538_alphalist_prev_employer_and_audit`):
  statutory / leave-type / tax-year changes now stale drafts; finalize and
  reopen lock in writer order (no deadlock, no entry slipping into a paid
  period); reopen resets totals (must recompute); finalize refuses
  adjustments for employees without a payslip; approved paid leave can't be
  deleted or re-pointed; audit log skips bookkeeping writes and records the
  admin behind edge-function writes; more tables audited; previous
  employer's status/reason columns.
- Front end: CSV formula injection; timesheet grid could save one day's rows
  under another date (stale response) and couldn't edit split shifts; Fill
  turned leave/holiday days into worked days; double-click duplicated
  allowances/loans; BIR tab could save blanks over data it failed to load;
  load failures spun forever or read as "no data"; label-wrapped control
  groups; widths and overflow on phones; weak login codes accepted.
- Added: admin "File leave", revoke approved leave, per-employee leave
  credits, allowance/loan edit with start/end dates, previous-employer
  section in the alphalist, year-end SMW for Schedule 2, Add Client asks
  for whole-peso cash pay (round up by default).
- Tests 109 → 147 unit/flow; SQL suite + `11_audit_fixes_tests.sql`.
  Both migrations applied live through MCP (non-destructive), `admin-users`
  v4 deployed, live fingerprint = replica, advisors unchanged.
- Final diff review: adjustment guard took `FOR SHARE` on the run, which
  deadlocked against finalize's row lock under concurrency →
  `20261020040519_adjustment_lock_mode` (`FOR NO KEY UPDATE`, two-session
  probe clean); timesheet next-day flags for post-midnight split pairs;
  leave/entitlement double-submit guards; login codes also refuse all
  letters and the employee's own names (`admin-users` v5).

### 2026-10-23 — UI revamp to the owner's reference video

**Asked:** make the app look like a screen recording of a "tiimi" HR/payroll
concept (dark top bar with section pills, white icon rail, lavender canvas,
flat white cards, dark-green primary, lemon-yellow accent, stepper-style
"Run Payroll" flow, attendance timeline bars); transitions not needed.

**Did (front end only, no schema/RPC change):** new tokens in
`src/index.css` (Figtree; `brand` = teal green, `accent` = lemon, `ink`,
`canvas`, `leaf`, timeline colours; Tailwind's `slate` overridden to the
design's lavender greys); `ui.tsx` primitives restyled plus `Avatar`,
`StatGroup`, `StatusCounts`, `Segmented`, `IconButton`, `Donut`, `Logo`;
dark toast; new `Shell` (top bar: section title + section pills with red
pending counts, client switcher, yellow quick-add menu, account menu; icon
rail; phone drawer). Pages: employee card grid/list, employee header with
prev/next and icon tabs + new read-only **Attendance** tab (timeline),
payroll runs table, pay-run page as a "Run payroll" workspace (stepper,
hours & pay rows with per-employee adjustment shortcuts, hour summary and
employer-cost donut, sticky Compute/Finalize bar), dashboards, split-screen
login, My Attendance timeline. Quick-add links open create forms through
`?new=<key>` (`src/lib/quickAction.ts`). Timeline geometry in
`src/lib/timeline.ts` (+5 tests, 152 total).

### 2026-10-23 — Revamp bug hunt (owner: "check for errors from the revamp, fix them all")

**Did:** two independent code reviews (shell/components, pages) and a browser
QA pass over every route × 3 roles × 1440/1024/768/390 px on the local stack;
every verified finding fixed and re-checked in the browser. Worst: employee
prev/next kept the previous employee's forms mounted — Save wrote one
person's pay/profile onto the next and a fresh login code showed (and
printed) under the next name (see lesson). Others: pay-run rows unreadable
at 768–1279 px (now container-query layouts), warnings below the payslips on
smaller screens, per-employee deductions dropped from pay-run rows, timeline
late/overtime/hours disagreeing with payroll, toasts and the archived note
covering top-bar controls, hidden section pills / rail items, stale pending
counts, record pages not following the client switcher, contrast (secondary
grey, "Active" badge, focus ring, disabled buttons), focus handling in
dialogs/drawer/menus, 13th-month runs shown with hours. Older bugs fixed on
the way: the timesheet's unsaved-change highlight never showed; a cleared
month field on My Attendance sent invalid queries. Tests 153 → 156.

### 2026-10-23 — Owner's test round + product/UX review (branch `claude/cool-cannon-jmj2oz`)

**Asked:** new hire could use SIL; Request Leave field overflowed on phones;
icon-only side tabs confusing; "Not authenticated" creating an entity admin;
bulk payslip PDFs; "is this the best form/workflow? brainstorm the optimal app
to the highest industry standards" (paying client).

**Did:** SIL gated on 12 months of service — `leave_types.min_service_months`
+ DB guard (migration `20261023080941`, applied live via MCP) + eligibility in
portal/admin screens (see lessons); root-caused "Not authenticated" from the
live auth logs (global sign-out, see lesson) → local sign-out + refresh-and-
retry in `callAdminUsers`; phone-safe form grids; labeled collapsible desktop
sidebar + employee bottom tabs; bulk payslips (tick/Select all → one PDF or
ZIP, `buildPayslipsDoc/Zip`, drafts print DRAFT PAYSLIP, deductions table no
longer drawn on the wrong page when earnings spill); engine warns about
uncovered workdays; corrections tab count + `?tab=corrections`; hint
contrast. Tests 156 → 173; SQL suite `12_leave_service_tests.sql`. An
independent review of the diff found 5 more, all fixed: the app frame used
100vh (phones' toolbars hid the new bottom tabs → `.app-frame` 100dvh),
prior-year credits, an offline refresh read as "signed out", a long payslip
footer note ran off the page, and the absence warning named pre-hire days. Rebuilt
the local stack and QA'd every change in the browser (see lesson). Three
research/audit sub-agents fed a product review, written as the owner's
Claude Docs doc "Payslip HR — Product & UX Review"
(https://claude.ai/artifact/3DbHSdFJgJLhr3yd388fbv) — see *Product direction*.

### 2026-10-23 — Cash advances (owner: "track salary advances per employee")

**Asked:** small PH employers advance part of a salary ("bale") and deduct it
from the next cutoffs — track advances per employee, integrated accurately.

**Did:** migration `20261023102637 cash_advances` (live via MCP after two
false-positive "destructive" timeouts, see the MCP lesson): advance details on
`recurring_deductions`, a balance guard, `advance_requests` (employees file /
cancel, admins approve via `approve_advance_request` or reject),
`advance_repayments` (outside payroll). Engine: advances deduct after
everything else, capped at net pay (`upToNet`), oldest first, label shows the
balance left; service: whole balance on the payroll that settles a
separation and on final pay, never on 13th-month runs, paused = skipped.
UI: admin **Cash Advances** page (Outstanding / Requests / Fully paid, record
or approve with a signed-authorization date + printable agreement
`src/pdf/advanceForm.ts`, per-advance ledger from payslips + repayments,
repay / pause / change installment / delete untouched, CSV), employee
**Cash Advances** page + dashboard tile, nav counter, dashboard action item,
Pay-tab card, register CSV "Cash Adv" column, other deductions on pay-run
rows. Tests 173 → 187, SQL suite `13_cash_advance_tests.sql`; full browser
QA on the local stack (request → approve → draft → finalize → ledger →
repayment → separation settlement → reject/cancel, phone + desktop).

### 2026-10-23 — Audit of this session's work (owner: "comprehensive audit")

**Did:** two independent reviewers (cash advances; the merged test-round
changes) plus a regression sweep: every route for HR / owner / employee at
1440 and 390 px (no page errors, failed calls, error states or overflow),
register CSV / bulk + single PDFs / payslip view / Pay-tab deep links, live
logs since 09:00 (no 4xx/5xx, no Postgres errors), advisors, live data.
Fixed (migration `20261023105459 cash_advance_hardening`, live): compute
token written before inputs are read (a stale draft could be finalized),
advance balance kept within 0…released even in finalize/reopen, repayments
no longer flip `active` (deleting one un-paused an advance), release /
authorization dates can't be cleared and the first deduction can't precede
the release, paused advances flagged (not silently skipped) at separation,
"filed" dates in Manila time, centavo-exact "spread over N payrolls", the
agreement/warnings no longer promise a catch-up the engine doesn't do,
installment stats relabeled "per payroll". Tests 187 → 189 + SQL
regressions (each shown failing on the old code).
Second reviewer (merged test-round changes): nothing on pay, data or
security; fixed its three minor finds — `callAdminUsers` signed out on
refresh errors that don't end a session (see the sign-out lesson), the
employee dashboard showed SIL as usable before its date this year (now
"usable from …" like My Leaves), and Pay Runs hid net pay / status behind
an in-table scroll at 1024–1279 px with the labeled sidebar (secondary
columns hide below xl, status and type move into the first column; the
sidebar stays expanded — the owner disliked the icon rail). Also fixed a
pre-existing PDF quirk: a spilled table printed its total under page 1's
partial list (`showFoot: 'lastPage'`). Tests 189 → 191.

### 2026-10-24 — Time In/Out report; "how do we fix a paid payroll?" (branch `claude/affectionate-carson-hyuwes`)

**Asked:** a report for the Time In/Out; how the user remedies an over/under-
withholding or another error found after the cut-off and the pay run.

**Did (front end only, no schema/RPC change):** Time In/Out → **Report** tab
(`src/pages/admin/TimeReport.tsx`): period presets (current cutoff from
`suggestPeriod`, this/last month, the last 24 pay runs), pay-frequency and
employee filters, a summary per employee and each one's DTR; downloads as
PDF (`src/pdf/timeReportPdf.ts`: a DTR page per employee with certification
and signature lines, or a landscape summary) or CSV (summary, or one row per
employee-day with extra pair columns for split shifts). Figures come from
`src/lib/timeReport.ts` → `computeAttendance`. "Edit" links open the
employee's sheet for the range; each pay run's tip box links to the report
for its period (`/admin/timesheets?tab=report&from&to&frequency`). Quick
Guide: the report and "Fixing a mistake after payday". Tests 191 → 202.
Browser QA on a rebuilt local stack at 1440/1280/1024/768/390/360 px: no page
errors or failed calls, no table or page overflow (the DTR is a list on
phones; secondary columns fold under the hours below xl). Researched the
BIR/DOLE correction rules and answered from the code (see the lesson
*Correcting a payroll after payday*); the gaps found were reported, not built.

### 2026-10-24 — Flexible schedules, informal advance deductions, management reports (same branch)

**Asked:** schedules differ, so fixed-schedule logic will be a problem —
remedy it the industry-standard way; advances are informal in small
businesses, so what a cutoff deducts for an earlier advance differs each
payroll; BIR & Reports should build real reports with insights for the
owner's decisions, not only BIR and mandatory-contribution data.

**Did:** migration `work_schedules` — `shift_templates`, `employee_schedules`
(7-slot weekly pattern from an effective date), `schedule_overrides`
(per-date roster changes; null shift = rest day), guards, RLS, audit, stale
drafts. Engine: each date measured against its own shift
(`src/payroll/schedule.ts` resolver; `attendance.ts`/`engine.ts`). UI:
**Schedules** page (weekly roster + shift templates), employee **Schedule**
tab (dated patterns, history, single-date changes), `ShiftPicker`; the
profile form no longer edits shifts. Migration `payroll_deduction_overrides`
— a draft sets what it deducts per recurring deduction (0 skips), advances
may have no fixed installment (0); pay-run card *Cash advances & loans this
payroll*, Cash Advances toggle, agreement wording for both. **Insights** tab
(first on BIR & Reports): payroll cost, overtime, attendance, headcount &
turnover, leave (unused-SIL cash), cash advances & loans, custom —
`src/lib/insights.ts` (pure, tested) + `insightsData.ts` + `Insights.tsx` +
`InsightChart.tsx` + `pdf/insightsPdf.ts`; settings live in the URL. Tests
220 → 240 plus SQL suite 14. Browser QA on the local stack (Aug–Sep
attendance seeded, four runs computed and finalized through the UI, a
per-payroll advance amount set and finalized, schedule flows, 390 px):
fixed alphabetical chart legends, fractional count ticks, an overflowing
KPI, an over-long schedule modal (compact day rows), ISO dates in findings.

### 2026-10-24 — Legal-accuracy review, maintainer-managed statutory tables, bug check (same branch)

**Asked:** an earlier session had to fix SIL being granted before 12 months
of service — check every payroll/HR concept for current legal accuracy;
replace manual "New version" statutory entry with the industry standard;
comprehensively check this session's work for bugs.

**Did:** statutory tables are now shipped data (migration
`statutory_tables_managed`: read-only for API roles, CHECK validators,
documented legal basis/source, frozen once used — see lesson). Five review
agents (tax, contributions, labor, code review of the session, time report)
plus my own source checks; fixes in migration `legal_accuracy` and the
engine — bonuses over the ₱90k exemption taxed when paid; year-end
annualization December-only; SSS on the month's actual compensation;
Pag-IBIG on basic + allowances; PhilHealth employee share waived for PWDs
and solo parents; regular-holiday pay needs the workday before (look-back
into the previous period); grace minutes paid, short rests and shorter
meal periods credited; CWW ≤ 5 days / 48 h; standard day ≤ 8 h; probation
hire + 180; maternity leave in calendar days and paid as SSS benefit +
salary differential (tax-exempt); SPL/MCW after 6 months; written
authorization date for company loan / HMO / other deductions; salary
deductions capped at the period's salary; MWE/apprentice wage warnings;
2316 order; NCR-28; 2027 holidays seeded. Code-review fixes from the
session's own work (pauses survive reopen, guards don't leak other
clients, insights edge cases, time-report fixes, PDF text). An
independent review of the legal batch found four more (migration aborting
on old off-December annualize flags — now cleared first, standard hours
clamped; grace minutes paid twice on short shifts; the maternity warning
repeating; provisional SSS on zero-pay payrolls) plus a pre-existing one
(regular holidays before the hire date or after the last day were paid) —
all fixed with tests. Tests 247 → 282, SQL suite 16 added; browser QA of
every new control at 1280 and 390 px.

### 2026-10-25 — Payroll tax rules spec, T1 (branch `claude/upbeat-davinci-t7a3uq`)

**Asked:** implement the owner's (CPA) *Payroll Tax and Contribution Rules:
Change Spec* v2026-10-25 — tasks T1–T12 in order, tests written first and
seen failing, one commit per task, a plain-language summary and the owner's
OK after each task; PENDING items become settings with a "Pending legal
confirmation" badge; finalized payrolls never change.

**Did:** `docs/payroll-spec-mapping.md` (where each spec item lives, what each
task changes, conflicts). Owner's decisions on the conflicts: a pay-code list
built from the 14 categories plus the spec's codes; exact-centavo math for new
or changed tax and contribution amounts (no engine-wide decimal conversion);
existing "other benefits" lines become a general SSS-included bonus code;
MWE status computed (checkbox removed); existing PhilHealth waivers migrate
(start month, SPIC expiry, PWD = confirmed); 1601-C lines 15–19 and the
quarterly MWE hazard list skipped; company admins maintain the SMW table.
T1: every Annex E row, the annual table and the ₱90k cap already matched the
spec (DB and `defaults.ts`); the row lookup is now "lower bound ≤ amount"
(`bracketFor`, same results — T2 needs it) and `taxOnRow` computes in exact
centavos (BigInt); de minimis ceilings ship as kind `de_minimis` effective
2026-01-07 (migration `20261025090000_de_minimis_ceilings`, shown on the
Statutory page, not yet used by payroll). Tests 282 → 340 plus SQL suite 17;
suites 10 and 15 counted five versions — now six.

### 2026-10-25 — Spec T2: pay codes and the withholding method (same branch)

**Did:** pay codes (`pay_codes`, 17 codes from the 14 categories plus
COMMISSION, FIXED_ALLOWANCE/OTHER_TAXABLE split, MAT_SSS_BENEFIT,
MAT_DIFFERENTIAL; mirror `src/payroll/payCodes.ts`); `pay_code` on
allowances and earning adjustments (backfilled from the category, a BEFORE
trigger keeps code and category in step); payslips store `taxable_regular`,
`taxable_supplementary`, `wht_method`. The engine splits taxable pay into R
and S (contributions and union dues out of R first; the ₱90k excess is S)
and withholds by the regular method (row from R) or CAM
(`src/payroll/withholding.ts`); 13th-month runs too (the old "marginal
monthly table" method is gone). The service now always loads the tax
year's payslips and previous-employer row. UI: pay-code selects for
allowances and one-time earnings, "(CAM)" next to W/tax in the run, a pay
code card on the Statutory page. Migration
`20261025100000_pay_codes` (not live). Readings the spec doesn't settle are
in `docs/payroll-spec-mapping.md` §5. Tests 340 → 405 plus SQL suite 18;
one engine test (13th-month excess, 16,944.15 on the old method) updated to
CAM; SQL suites 10 and 16 unchanged. Backfill checked on a seeded pre-T2
database (finalized run's adjustments coded, no audit rows, drafts marked).

### 2026-10-25 — Spec T10: BIR exports (same branch)

**Did:** `src/payroll/form2316.ts` builds the 2316 by the form's parts (I
employee with SMW per day/month and the MWE box, II present employer, III
previous employer with address and ZIP, IV-A summary, IV-B non-taxable with
the MWE lines first, IV-B taxable regular and supplementary);
`Form2316Modal` renders and prints it (also at final pay, T8). Alphalist
rows carry `hasPreviousEmployer`, the previous employer's address/ZIP and
`hazardCertRef`; both schedule CSVs gained the MWE hazard pay fields
(period of employment, amount, DOLE certification reference — blank
without exempt hazard pay) and the row is flagged when the reference is
missing. No DAT writer (P7), 1601-C lines 15–19 and the quarterly hazard
list skipped (owner). The 2316 item numbers are left out: the BIR site is
blocked here (403) and secondary sources disagree. No migration. Tests
496 → 502.

### 2026-10-25 — Spec T9: due-date calendar (same branch)

**Did:** `src/payroll/dueDates.ts` — `due1601c` (10th of the next month, or
the eFPS group's day A 15 … E 11; December: January 15 or the group's day),
`annualDueDates` (refunds Jan 25, 2316 and 1604-C Jan 31, scanned 2316
duplicates Feb 28), `contributionDue` (a day of the next month, clamped),
`dueCalendar` (a year's items with overrides, weekends marked, nothing
moved). Client settings `filing_mode` (null until chosen), `efps_group`
(required for eFPS), and the P6 days `sss_due_day`, `philhealth_due_day`,
`pagibig_due_day` (no default, Pending badge) on Client Settings;
`due_date_overrides` (one per obligation and period, note required,
client admins, audit-logged). BIR & Reports → Due dates lists the year,
overrides with a note; the dashboard tiles show the date in force.
Migration `20261025170000_due_dates` (not live). Tests 487 → 496 plus SQL
suite 25 (seen failing without the migration).

### 2026-10-25 — Spec T8: year-end adjustment additions (same branch)

**Did:** an annualizing payroll (December flag, separation, 13th month after
the year was annualized) withholds a shortfall only up to the net pay left
after contributions and other deductions (`capYearEndWithholding`, cash
advances come after); the rest is `payslips.tax_paid_by_employer` (a note on
the payslip, screen and PDF). It counts as paid for the year in
`summarizeYear` (in the month's withholding, `paidByEmployer`) and in later
annualizations and CAM. Finalizing records it as a paused cash advance with
no signed authorization (`recurring_deductions.source_run_id`, trigger
`payroll_runs_tax_advances`); reopen removes it unless part was repaid; its
amount and release can't be edited (`guard_tax_advance`). Cash Advances can
now record the authorization date on an advance that lacks one. The 1601-C
and 1604-C pages use `src/payroll/remittance.ts`: withheld + employer-paid −
refunds recovered, unrecovered refunds carried into later months and into
the next year; recording a month prefills taxes withheld and the
adjustment. The alphalist loader moved to `src/payroll/alphalistData.ts` and
the 2316 modal to `src/components/Form2316Modal.tsx`; a finalized run shows
"BIR 2316 (final pay)" for employees who left. A new hire with no BIR-data
row for the tax year gets a payslip warning. `round2` no longer returns -0.
Migration `20261025160000_year_end_adjustment` (not live). Tests 466 → 487
plus SQL suite 24.

### 2026-10-25 — Spec T7: de minimis ceilings per item (same branch)

**Did:** pay codes per de minimis item (DM_* for c–k, LEAVE_CONVERSION for
item a, `pay_codes.de_minimis_item`); DE_MINIMIS retired (inactive,
unchecked, warns). The engine's `earnDeMinimis` splits a line into the part
within the ceiling (bucket de_minimis) and the excess (bucket
other_benefits, the ₱90k bucket); `deMinimisUsed` comes from the tax-year
payslips by pay-date window (month / half-year / year) and only from pay
dated on or after the ceiling version (`tables.de_minimis_from`, from
`pickStatutoryTables`); item j caps at 30% of the client minimum wage per
day with OT or night work. LEAVE_CONVERSION needs `days`
(`payroll_adjustments.days`, sync trigger); client `leave_policy`
(default sil_only): vl_in_place_of_sil → 12 de minimis days a year,
sil_only → taxable S. Migration `20261025150000_de_minimis_items` (not
live). Tests 451 → 466 plus SQL suite 23 (19.1 now checks its codes by
name).

### 2026-10-25 — Spec T6: PhilHealth NG share by month (same branch)

**Did:** `employees.philhealth_waiver_start_month` (first of month),
`philhealth_spic_expiry` (solo parent), `philhealth_pwd_status`
(for_verification / confirmed) replace the from/until dates (dropped; the
data converts as the owner decided — live had no waivers, checked
read-only). `src/payroll/philhealthWaiver.ts`: the NG share applies to a
payroll month from the start month, for a solo parent only when the SPIC
covers the whole month, for a PWD only when confirmed; payslip warnings
for an SPIC expiring within 30 days, an uncovered month, and a PWD still
for verification. The employee's Pay tab lists finalized payrolls that
deducted the share in months now waived, and holds the six document files
(`employee_documents` + private bucket `employee-documents`, RLS by
`can_manage_employee`). Migration `20261025140000_philhealth_ng_share`
(not live; drops columns → SQL editor). Tests 439 → 451 plus SQL suite 22;
suite 16.6 moved to the new columns. The session's worker restarted once:
restart the local Postgres (CLAUDE.md command) after a restart.

### 2026-10-25 — Spec T5: MWE premium add-ons and hazard pay (same branch)

**Did:** for MWEs the engine splits rest-day / special-day pay into the
exempt part (the day at the SMW rate; up to 200% on a regular holiday) and
an add-on (`premiumAddOnMultiplier`: 30%, 50% special-on-rest, 60% regular
holiday on a rest day) on new taxable S lines `restday_addon`,
`special_addon`, `holiday_addon` (bucket other_taxable). OT and ND stay
exempt. An MWE's hazard pay is taxable S unless `employees.hazard_criteria_met`
and `hazard_dole_cert_ref` (`hazardExempt`). Taxable lines now store
`incomeClass`; `summarizeYear` honours a line's `taxable: true` for MWE
buckets and puts other_taxable S lines in the supplementary "Others" box.
Migration `20261025130000_mwe_hazard_pay` (not live). Tests 427 → 439 plus
SQL suite 21.

### 2026-10-25 — Spec T4: maternity leave rules (same branch)

**Did:** MAT_DIFFERENTIAL is now taxable S by default (P1 setting:
taxable/exempt), in the SSS base, and in the 13th month base (P9 setting);
pay codes gained `tax_pending`, `include_in_13th_month_base`,
`thirteenth_pending`; `set_pay_code_rule` RPC. Clients record a DOLE
exemption (category, approval reference, year): without one for the
payroll year, a payslip with maternity-leave days and no differential (on
it, or paid earlier in the leave) gets the error "Differential required: no
DOLE exemption approval for this year". Payslip traces now have `errors`;
the run page lists them and the DB (`payroll_runs_payslip_errors`) refuses
to finalize. P4 lives in the new one-row `payroll_rules` table
(`set_payroll_rule`): as usual, or no PhilHealth/Pag-IBIG on a payroll that
is all maternity leave. `supabase/tests/run.sh` now runs `NN_*tests.sql`
from 10 up (it only ran `1*`). Migration `20261025120000_maternity_rules`
(not live). Tests 415 → 427 plus SQL suite 20; legal.test's maternity case
updated to the P1 default (taxable) and the exempt setting.

### 2026-10-25 — Spec T3: SSS base by pay code (same branch)

**Asked:** the owner OK'd T2 and asked for T3–T12 without stopping between
tasks (questions collected for the end, `docs/payroll-spec-mapping.md` §6).
**Did:** `pay_codes` gained `sss_include`, `sss_include_pending` (P2/P3),
`is_christmas_bonus`, `subject_to_liquidation`; new codes CHRISTMAS_BONUS,
LIQUIDATED_ALLOWANCE (non-taxable, out of SSS) and THIRTEENTH_MONTH (the
13th month run's own code, P2). Every new earnings line stores `sss`;
`sssCompensation` sums the flags. The month's SSS base now also reads its
13th-month payslips (they count only when that setting is on; a 13th month
paid after the month's last payroll was final warns to recompute it).
`set_pay_code_sss_include` RPC (company admins, pending codes only,
audit-logged, marks drafts stale); toggles with the Pending badge on the
Statutory page. Migration `20261025110000_sss_pay_codes` (not live).
Tests 405 → 415 plus SQL suite 19 (18.1 now checks the T2 codes by name).

---

## Current deployed state (update when it changes)

**2026-10-25: `20261025110000 sss_pay_codes` (T3), `20261025120000
maternity_rules` (T4), `20261025130000 mwe_hazard_pay` (T5),
`20261025140000 philhealth_ng_share` (T6), `20261025150000
de_minimis_items` (T7), `20261025160000 year_end_adjustment` (T8) and
`20261025170000 due_dates` (T9) are in the branch, NOT live** (apply in order after T2's, before the front end;
T4's drops and re-adds a constraint and T6's drops columns, so they need
the SQL editor).

**2026-10-25: `20261025100000 pay_codes` (spec T2) is in the branch, NOT
live.** Apply it BEFORE deploying T2's front end: the new screens and the
payroll service read `pay_codes` and the new payslip columns and fail
without them (the old front end keeps working on the migrated database —
the trigger gives category-only rows their code). It marks every draft
payroll for recomputing. Then run `fingerprint.sql` and the advisors.

**2026-10-25: `20261025090000 de_minimis_ceilings` is in the branch, NOT
live.** It swaps two constraints with DROP CONSTRAINT, so the MCP's
destructive-SQL prompt blocks it: the owner runs it in the SQL editor, then
the session records it in the migration history and re-runs
`fingerprint.sql` and the advisors. The front end works without it (the de
minimis kind is optional).

**Backend and Pages site are both multi-client since 2026-10-20.** PRs #1
(multi-client), #2 (UI revamp), #3 (Quick Guide), #4 (test-round fixes) and
#5 (cash advances + audit fixes, merged and deployed 2026-10-23 11:11 UTC)
and #6 (2026-10-24: Time In/Out report, schedules, per-payroll deductions,
Insights, read-only statutory tables, the legal-accuracy fixes — merged at
the owner's request on 2026-10-24, deployed by the Pages workflow) are in
`main` and live.

**2026-10-24: all four migrations live (owner approved; shipped with PR
#6).** Through MCP
`apply_migration`: `20261024112556 work_schedules`, `20261024221511
payroll_deduction_overrides`, `20261024225035 statutory_tables_managed`,
`20261024225137 legal_accuracy` (repo files renamed to those versions).
`statutory_tables_managed` first timed out on the MCP confirmation — the
`;` inside its legal-basis strings tripped the detector (see the lesson);
reworded with commas, it applied on the retry. `fingerprint.sql` matches
the replica on every kind (27 tables, 399 columns, 171 constraints, 77
indexes, 58 policies, 51 functions, grants, 87 triggers); security
advisors unchanged; live data: 5 documented statutory versions, 19 holidays
for 2027, SPL/MCW at 6 months, no annualized runs. Between the migrations
and the merge (minutes) the old forms couldn't send `authorized_on`; a DB
rule the old front end can't meet should ship together with its front end.

Supabase project `ruuhpghcgccvezkjhisy` (ap-southeast-1, PG 17.6), as of 2026-10-23:
- **All 21 migrations applied** (the four 2026-10-24 ones above; the
  notes below describe the state as of 2026-10-23). The 17th, `20261023105459
  cash_advance_hardening` (CREATE OR REPLACE of the three advance trigger
  functions), went through MCP; fingerprint re-matched (functions hash
  changed on both sides identically). The 16th, `20261023102637 cash_advances`
  (2 tables, guards, RPC), went through MCP `apply_migration`; repo file
  renamed to that version; `fingerprint.sql` matched the local replica on
  every kind (23 tables, 355 columns, 137 constraints, 65 indexes, 52
  policies, 41 functions, 69 triggers). The 15th, `20261023080941
  leave_service_requirement` (ADD COLUMN + UPDATE + CREATE OR REPLACE), went
  through MCP `apply_migration`; repo file renamed to that version; a
  rolled-back dry run confirmed the guard's message; advisors unchanged. The two multi-client ones were run by the
  owner in the SQL editor (MCP could not — see lesson) and then recorded in
  `supabase_migrations.schema_migrations` under the repo versions
  `20261019120000 multi_client_schema` / `20261019120100
  multi_client_security`. The audit ones (`20261020031639 audit_fixes`,
  `20261020033538 alphalist_prev_employer_and_audit`, `20261020040519
  adjustment_lock_mode`) went through MCP
  `apply_migration` (non-destructive) — repo files renamed to the versions
  MCP recorded. Verified with `supabase/tests/fingerprint.sql`: tables,
  columns, constraints, indexes, policies, functions, grants and triggers
  all match the local replica (21 tables, 328 columns, 120 constraints, 57
  indexes, 46 policies, 36 functions, 61 triggers — before the 15th
  migration's extra column). Data: owner = `company_admin`, 5 statutory
  versions, 9 global leave templates, 21 national 2026 holidays; RLS on
  every table. Owner's test data since 2026-10-23: 1 client, 1 employee
  (hired 2026-10-23, has a login code), 1 finalized semi-monthly run.
- Edge function **`admin-users` v5** live (verify_jwt on), deployed
  2026-10-20; deployed source = repo copy (writes carry `x-actor-id`; weak
  login codes refused, incl. all-letter codes and the employee's names).
- Security advisors after the last DDL (2026-10-23, cash advances): 10 intentional WARNs (RLS helpers
  `is_company_admin` / `can_manage_entity` / `can_manage_employee` /
  `current_employee_id` / `current_employee_entity_id` / `run_is_finalized`
  and the RPCs `finalize_payroll_run` / `reopen_payroll_run` /
  `review_time_correction` / `approve_advance_request` are executable by
  `authenticated` by design; each checks the caller's client) and
  "Leaked password protection disabled" (Auth dashboard setting, owner's
  call). Performance advisors: INFO only for unindexed FKs / unused indexes
  (no data yet) and WARN "multiple permissive policies" (admin + own-row
  policies, by design).
- Private storage buckets `punch-selfies` and `employee-photos` exist; after
  the migration nothing uses `punch-selfies` (empty; safe to delete).
- **The owner's account exists** (created 2026-08-24, confirmed; role
  `company_admin` since the migration). Never create additional accounts
  except through the app (Admin Users / employee Login tab).
- To manage a departed co-admin's account the DB owner may need to disable
  the admin-protection trigger temporarily in the SQL editor (deliberate
  escape hatch — document any use in the audit trail).
- **GitHub Pages deployment** is wired via
  `.github/workflows/deploy-pages.yml` (build with `--base=/Payslip-HR/`,
  Router basename from `import.meta.env.BASE_URL`, `404.html` SPA fallback).
  Deploys from `main` ONLY — the auto-created `github-pages` environment
  rejects other branches (2-second no-runner failure), so ship by
  fast-forwarding/merging `main`. Pages source = GitHub Actions (enabled by
  the owner 2026-08-24; the workflow token cannot enable it itself). Site:
  https://jezb-netrunner.github.io/Payslip-HR/

Known-open items (deliberate scope cuts, also in README disclaimers): BIR
DAT file not generated (CSV for the BIR Alphalist module instead); no
tax-only or reversal adjustment for correcting a paid payroll (see
*Correcting a payroll after payday*); the SSS maternity benefit and salary
differential are entered by the admin, not computed; whether an MWE's
rest-day/special-day premiums are tax-exempt is unverified (the app
exempts them — accountant's call).

---

## Lessons

### Verified 2026 PH statutory figures

> As of 2026-08-23 every figure seeded in `statutory_versions` was verified against current law via multi-source research + adversarial cross-check; never seed a statutory figure from memory.

Confirmed current (seeded in DB, mirrored in `src/payroll/defaults.ts`):
- **BIR WHT**: Annex E of RR 11-2018 (TRAIN, RA 10963), "effective Jan 1,
  2023 and onwards" — still in force for 2026, all four period tables +
  annual table. **₱90,000** 13th-month/other-benefits cap unchanged (bills to
  raise it remain unenacted).
- **SSS** (RA 11199, Circular 2024-006): 15% of MSC since Jan 2025 — the
  **final step** (no scheduled future increase). MSC ₱5,000–₱35,000 in ₱500
  steps; EE 5% / ER 10%; MSC above ₱20,000 → MPF/WISP; EC ₱10 (MSC < ₱15,000)
  / ₱30.
- **PhilHealth** (RA 11223): 5% of monthly basic salary, floor ₱10,000 /
  ceiling ₱100,000, 50/50 — **terminal rate**; confirmed retained for 2026.
  HB 11357 (3.5% cut) died with the 19th Congress.
- **Pag-IBIG** (Circular 460): max fund salary ₱10,000 since Feb 2024; EE 1%
  (≤₱1,500) / 2%; ER always 2%. Max ₱200 + ₱200.
- **Service Incentive Leave** (Labor Code Art. 95 + IRR Book III Rule V,
  checked 2026-10-23 via DOLE handbook / Senate extracts): 5 days a year
  after "at least one year of service" = 12 months, continuous or broken,
  from the start date (a shorter period counts if practice/contract says
  so); exempt: firms regularly employing < 10, those already giving ≥ 5 days
  paid VL, managerial/field personnel; unused SIL converts to cash. Bills to
  raise it to 10 days were unenacted as far as search showed.
- **Other leaves** (verified 2026-10-24): Solo Parent Leave 7 working days
  after 6 months of service (RA 11861 Sec. 8); Special Leave for Women 2
  months after 6 months' aggregate service in the last 12 (RA 9710 Sec.
  18); maternity 105 calendar days (+15 solo parent) = SSS maternity benefit
  advanced within 30 days of the application (SSS Circular 2019-009) +
  salary differential (exempt: retail/service ≤ 10 workers, micro
  businesses, distressed firms); both tax-exempt (RMC 105-2019); the
  differential counts for 13th month, the SSS benefit doesn't (DOLE LA
  25-2023).
- **Labor standards**: OT +25% ordinary / day-rate ×1.30 otherwise
  (169/195/260/338%); ND +10% (22:00–06:00), stacks multiplicatively;
  premiums 130/150/200/260%; unworked regular holiday 100% if the employee
  worked or was on paid leave on the workday before it (IRR Book III Rule IV
  Secs. 6, 10 — rest days passed over, successive holidays chain); special
  days no-work-no-pay; 13th month = YTD basic ÷ 12, due Dec 24; apprentices
  and learners ≥ 75% of the minimum (Arts. 61, 73); final pay within 30
  days, COE within 3 days of request (Labor Advisory 06-20); deductions
  the law doesn't provide for need written authorization (Art. 113; DO
  195-18).
- **Contributions' bases** (verified 2026-10-24): SSS on actual monthly
  compensation — all remuneration incl. OT, COLA, allowances; not 13th
  month/bonuses/reimbursements (RA 11199 Sec. 8(f)); PhilHealth on monthly
  basic salary; Pag-IBIG on basic + allowances up to ₱10,000 (secondary
  sources only — circular text not reached). PhilHealth employee share is
  paid by the national government for employed PWDs (RA 11228) and, from
  Sep 26, 2026, solo parents (PhilHealth Circular 2026-0015). WISP is now
  "MySSS Pension Booster (Mandatory)".
- **Tax** (verified 2026-10-24): 13th month + other benefits beyond ₱90,000
  are taxable compensation when paid — for MWEs too (Soriano v. Secretary
  of Finance, G.R. 184450, 2017); year-end adjustment on the last payroll
  paid in December, refunds by Jan 25 (RR 2-98 as amended); BIR 2316
  items 26–28 = total withheld as adjusted, PERA credit, total.
  Unverified, flagged to the owner: whether an MWE's rest-day/special-day
  premiums are exempt like holiday pay (the app exempts them).
- **2026 holidays**: Proclamation 1006 (+1189 Eid'l Fitr Mar 20, +1264 Eid'l
  Adha May 27) — 12 regular, 8 special non-working, Feb 25 special *working*.
  NCR only: Nov 16–18, 2026 special non-working (Proclamation 1447) — a
  client-local holiday, not seeded.
- **2027 holidays** (Proclamation 1427, Sep 8, 2026; seeded in
  `legal_accuracy`): 10 regular (Maundy Thursday Mar 25, Good Friday Mar
  26, Heroes Aug 30), 8 special non-working, Feb 25 special working; the
  Eids come by separate proclamations — add them when announced.
- **NCR minimum wage reference** (corrected 2026-10-24): ₱755/day non-agri
  under **WO NCR-28, eff. Sep 26, 2026** (single ₱60 increase from ₱695);
  ₱718 for agriculture, retail/service with ≤15 workers and manufacturing
  with <10. WO NCR-27 (the earlier "₱755 from Jul 25" and its ₱780 Jan 2027
  tranche) was enjoined by a Pasig RTC and never took effect, so NCR pay
  from Jul 25 to Sep 25 stayed ₱695. It's an admin setting, not hardcoded.
- **De minimis** (RR 29-2025): rice ₱2,500/mo, uniform ₱8,000/yr, laundry
  ₱400/mo, medical assistance ₱12,000/yr, dependents' medical cash ₱2,000 a
  semester (₱333/mo), achievement awards ₱12,000/yr, gifts ₱6,000/yr,
  CBA+productivity ₱12,000/yr, OT/night meal 30% of the regional minimum
  wage, monetized VL 12 days. Stored since 2026-10-25 as statutory kind
  `de_minimis` **effective 2026-01-07** — the owner's spec takes the day after
  day 15 from the 2025-12-22 posting as the safe date (secondary sources say
  Jan 6). Payroll doesn't apply them yet (spec T7); until then de minimis is
  admin-flagged non-taxable pay and the ceilings are the admin's job.

Re-verify on these triggers: every January (agency announcements, new BIR
RRs); wage orders per region (NCR-28 has no second tranche; watch the
Supreme Court petitions on NCR-27 — admin must update the setting); each ~Aug–Oct for next year's holiday
proclamation (Eid dates arrive by separate proclamations only weeks ahead);
pending bills (13th-month cap increases, PhilHealth premium cuts).

Why it mattered: the user's explicit requirement was current legal tables;
research corrected two of my from-memory values (NCR wage ₱695→₱755, and the
PhilHealth centavo split direction below).

### PhilHealth odd-centavo split direction (correction)

> When the 50/50 PhilHealth split produces a fractional centavo, the EMPLOYEE share rounds DOWN and the employer carries the extra centavo — my first implementation had it reversed.

Official sample: total ₱618.75 → EE ₱309.37 / ER ₱309.38. In
`src/payroll/statutory.ts`: `ee = Math.floor((total/2)*100)/100;
er = round2(total - ee)`. A plain `round2(total/2)` overcharges the employee
by a centavo. Unit-tested via MBS 12,375 at 5%. Why it mattered: remittances
must tie out to the centavo; consistent misrounding creates reconciliation
discrepancies with PhilHealth's own computations.

### SSS EC threshold applies to the MSC, not raw salary (correction)

> The ₱10/₱30 EC split keys off the *mapped* Monthly Salary Credit; salary ₱14,999 maps to MSC 15,000 (bracket 14,750–15,249.99) and pays EC ₱30 — my test vector was wrong, not the code.

Mapping: `MSC = clamp(500 * floor((salary + 250) / 500), 5000, 35000)`
(bracket bounds are MSC ± 250); *then* every MSC-derived amount (EE/ER, MPF
split, EC tier) uses that MSC. Why it mattered: off-by-one-bracket errors
around ₱14,750–₱15,000 misstate EC by ₱20/month and would shift the whole
contribution row.

### Monthly-paid divisor semantics (261) and holiday premiums

> Under the divisor-261 convention a monthly rate already pays for unworked regular holidays and special days — the engine adds only the *extra* premium for worked ones, or it double-pays.

`src/payroll/engine.ts` encodes this as `BUILT_IN_MULT`: scheduled
regular/holiday/special days have 1.0 built-in (worked regular holiday adds
+100%, worked special adds +30%; unworked adds nothing and deducts nothing);
rest-day types have 0 built-in (full multiplier paid as extra). Daily-paid is
the opposite regime: no work no pay, `DAY_MULT × daily` per worked day,
unworked regular holiday = 100% daily as its own line.
`working_days_divisor` (261/313/365) converts monthly↔daily:
`daily = monthly × 12 / divisor`. Why it mattered: the most common PH payroll
bug is paying holiday pay *on top of* a holiday-inclusive monthly rate (or
deducting an unworked regular holiday).

### Statutory tables ship with the software; the app only reads them (confirmed approach, revised 2026-10-24)

> Every legal rate lives in `statutory_versions` keyed by `(kind, effective_from)`; payroll loads the version in force (contributions by period end, withholding by pay date). Since 2026-10-24 no API role may write the table: a law change ships as a reviewed migration with its legal basis, source and verification date, and the database validates and freezes versions.

`getStatutoryTables(asOf)` picks, per kind, the newest row with
`effective_from <= asOf`; `src/payroll/defaults.ts` mirrors the versions for
unit tests. Migration `statutory_tables_managed`: REVOKE writes from
anon/authenticated and the old company-admin policies set to false (no DROP:
the MCP destructive-SQL prompt can't be answered from cloud sessions);
columns `legal_basis`, `verified_on`; CHECKs `valid_statutory_data(kind, data)`
(shape, rate ranges, MSC steps, tax brackets ascending and each base = the
previous base + rate × step within ₱1 — a mistyped figure fails),
first-of-month `effective_from` for the SSS / PhilHealth / Pag-IBIG kinds
only (since 2026-10-25: BIR kinds and `de_minimis` follow the pay date, and
RR 29-2025 starts mid-month), documented (legal basis, description, https
source); trigger `guard_statutory_version` freezes data/effective date of a
version any finalized run with `greatest(period_end, pay_date) >=
effective_from` may have used, unless the correcting migration sets
`statutory.correction = on`; notes stay editable. The dashboard reminds
company admins when the tables in force were last verified before January 1
of the current year. Process: README → *Updating the statutory tables*.
Why it mattered: the owner pointed out that a hand-typed "New version" could
misapply rates (a 5% typed as 50%, a wrong effective date, an in-place edit of
a table finalized payrolls used) — commercial payroll software keeps tables
vendor-maintained for exactly that reason. The earlier design (company admins
editing in a structured form) is gone.

### RLS policies that reference each other's tables recurse

> Payslips' employee policy checks the run's status while payroll_runs' policy checks for an own payslip — inline subqueries raise "infinite recursion detected in policy"; the fix is SECURITY DEFINER helper functions.

Since the multi-client conversion the helpers are `is_company_admin()`,
`can_manage_entity(uuid)`, `can_manage_employee(uuid)`,
`current_employee_id()`, `current_employee_entity_id()`,
`attendance_locked(uuid, date)` — security-definer (they bypass RLS on the
tables they read) and policies call them instead of inline subqueries. Rules that
came with it: always `set search_path = public` on definer functions; revoke
EXECUTE from `anon` on helpers but KEEP it for `authenticated` (policies
evaluate functions with the calling role's privileges — revoking
authenticated breaks every SELECT); trigger functions get EXECUTE revoked
from everyone (PostgREST exposes any executable function under /rpc).

### Employees never write attendance (confirmed approach)

> Employees have zero INSERT/UPDATE/DELETE on time_entries and payslips; since 2026-10-19 time in/out is entered by admins (owner's requirement), replacing the selfie/device/IP self-punch RPCs, which were dropped.

Employees can only file time-correction and leave requests; an admin
approves them (`review_time_correction` applies the change). Entries inside
a finalized run's period are locked (`attendance_locked`) so paid
attendance can't change under a payslip; reopen the run first. Why it
mattered: the original design enforced punch identity in the database
(server-derived identity, DB clock, selfie evidence); with admin-entered
time the same rule — no employee write path at all — is what keeps
attendance and pay trustworthy.

### Manila time is fixed UTC+8 — but convert deliberately

> PH has no DST so attendance math uses fixed +8h arithmetic (`src/lib/manila.ts`); the trap is datetime-local inputs, which `new Date(value)` interprets in the *browser's* timezone — convert them as Manila wall time explicitly.

Admin-entered times (`work_date` + `"09:30"`) become instants via
`manilaWallToIso` in `src/lib/manila.ts` (= `new Date(value + ":00Z") − 8h`);
display goes back through `manilaHHMM`. Month ranges use `endOfMonth()` —
a hand-built `${month}-31` is an invalid date for 30-day months and
February, which PostgREST rejects (that bug existed in MyAttendance). ND
window 22:00–06:00 overlaps are computed per Manila date; ND minutes are
capped at net worked minutes so unpaid breaks don't earn ND. Why it
mattered: an admin filing from a non-PH browser would silently write shifted
timestamps — the classic way payroll hours drift by a day.

### Run Supabase security advisors after every DDL change

> `get_advisors(type=security)` caught real gaps after the initial migrations (mutable search_path; definer functions executable by anon via /rpc) — fixed in `harden_function_privileges`; re-run the advisors after any future DDL.

Checklist: pin `search_path` on every function; trigger functions →
`revoke execute from public, anon, authenticated` (triggers still fire — they
run as table owner); RLS helpers → revoke `anon` only; intentional RPCs
(`finalize_payroll_run` / `reopen_payroll_run` / `review_time_correction`,
which check the caller's rights inside) keep authenticated EXECUTE by design
and will WARN — leave them, as will the RLS helpers under lint 0029
("Signed-in users can execute SECURITY DEFINER function": they only report
the caller's own access); `revoke_user_sessions` is service-role only.

### Employee logins: code → synthetic email, provisioned by the admin-users edge function

> Employees sign in with one admin-set code `<CLIENT>-<PART>`; Supabase Auth needs an email, so the code maps to `emp-<sha256("payslip-hr/employee-login/v1:"+code)[:32]>@jezb-netrunner.github.io` and the code is the password — the derivation exists twice (browser + edge function) and must stay byte-identical.

Vector: `ACME-7Q4KX9TB` → `emp-bce06882b7902c9f3fdc424817f6a827@jezb-netrunner.github.io`
(pinned in `src/lib/loginCode.test.ts`). The address must be on a real-looking
domain the project owns: Supabase Auth rejects example/test domains. Only a
hint (last characters) is stored; changing or disabling a code revokes the
user's sessions (`revoke_user_sessions`, service-role only). The client
prefix stops code guessing from reaching other clients. `admin-users` v3
actions: `set_employee_code`, `set_employee_login_active` (company admins or
entity admins of that employee's client), `create_admin`, `update_admin`
(company admins only; another company admin is never manageable). The
client must send the **user's access token** as the bearer
(`callAdminUsers`). The very first account ever created becomes
`company_admin` via `handle_new_user` — disable public sign-ups right after.
Why it mattered: employees have no email to give, and the alternatives
(service key in the browser, self-signup) were unacceptable.

### How statutory figures were verified (process lesson)

> Verify via parallel research agents (one per domain) each followed by an adversarial fact-checker told to refute the findings — repeat this whenever tables are due for re-verification.

Sandbox limits hit doing it: the egress proxy blocks ALL direct fetches of
.gov.ph sites AND `*.supabase.co` from local processes (curl/browser get
CONNECT 403) — research relied on server-side WebSearch extraction
cross-checked across independent sources, backend verification must go
through the Supabase MCP tools, and UI smoke tests can only confirm
rendering, not live auth. The adversarial pass is not decoration: it caught
a date nuance (RR 4-2025 effectivity) and confirmed all 24 WHT brackets
digit-by-digit. A human should still eyeball the actual circular PDFs once
before betting the company on a figure.

### Adversarial review findings (2026-08-23) — all fixed, all regression-tested

> A 5-dimension review workflow with skeptic verification confirmed 22 real defects in the "finished" system; the bug classes below are the ones future changes are most likely to reintroduce.

Engine/attendance (fixed in `attendance.ts` / `engine.ts`, each with a test):
- **Holiday × rest-day interactions**: unworked regular holidays falling on
  rest days paid ₱0 for both pay types (Art. 94 grants 100% regardless);
  `BUILT_IN_MULT` also hardcoded divisor-261 semantics — under divisor 365
  rest-day work double-paid the base 100%. Built-in coverage is now
  divisor-aware (`builtInFor`).
- **Leave flags were dayType-gated in attendance**, making the engine's
  unpaid-leave-on-holiday guard dead code. Flags are now set for every
  covered day; the engine decides per day type what they mean.
- **Overnight schedules** (22:00–06:00) never detected lateness/undertime —
  minutes-of-day comparisons need the schedule normalized onto a continuous
  axis (+1440 past midnight).
- **Break double-deduction**: employees who clock out for lunch had the
  scheduled break deducted again; the break is now reduced by off-the-clock
  gaps between same-day entries.
- **Deduction caps**: tardiness/undertime deductions are capped at the
  unworked portion of the day (standard − payable), which also waives them
  when total hours meet the standard and keeps the unpaid break out of the
  tardiness charge.
- **ND must stack on the OT rate** for night hours beyond the standard day
  (overlap attributed to OT first).
- **Centavo discipline**: PhilHealth splits must use integer-centavo
  arithmetic (binary-float flooring dropped centavos on even splits), and
  split-month contribution halves must sum EXACTLY to the monthly table
  amount (`periodShare`: floor-half first, remainder second).
- **13th month**: `basic_pay` now stores EARNED basic (net of
  absence/late/undertime lines) because PD 851 counts basic salary *earned*.
- **Full-month runs under semi-monthly settings** (half='full') now compute
  with monthly semantics end-to-end (basic, allowances, contributions, WHT
  table) instead of half-basic + full contributions.
- **Loan deductions** are capped at the remaining balance, and reopening a
  finalized run restores the balances it decremented.

Security (fixed in migration `security_and_integrity_fixes` + edge fn v2):
- `review_time_correction` could modify ANY time entry by id → now verifies
  the entry belongs to the requesting employee (cross-employee tampering).
- Punch RPCs accepted arbitrary selfie paths → now must be in the caller's
  folder, must exist in storage, and stale (>10 min) uploads are flagged.
- Employees could read whole `payroll_runs` rows (company-wide totals/notes)
  → policy dropped; run info is denormalized onto payslips instead.
- `time_entries` INSERTs are now audit-logged (were update/delete only).
- Edge function: one admin could reset/ban a co-admin → protected targets.
- Residual (documented, not code-fixable here): first-signup-becomes-admin
  bootstrap can be raced while public sign-ups are enabled — README tells the
  owner to sign up immediately and then disable public sign-ups in Supabase
  Auth settings.

Why it mattered: every one of these passed the original 32 tests; only
adversarial review with independent verification caught them. When touching
the engine, re-read this list — these are the semantics most easily broken.

### Supabase Auth Site URL defaults to localhost:3000

> The first confirmation email's link "failed" with Unable to Connect to localhost:3000 — the token was already verified server-side; only the post-verification redirect goes to the project's Site URL, which every new Supabase project defaults to http://localhost:3000.

Fix: Authentication → URL Configuration → Site URL =
`https://jezb-netrunner.github.io/Payslip-HR/` (also added under Redirect
URLs). Affects every auth email (confirmations, password resets, magic
links). The account itself is always fine after clicking such a link — check
`auth.users.email_confirmed_at` before assuming a failed signup. Why it
mattered: it looks like a broken deployment to the user, but nothing is
actually wrong with the app; only the dashboard setting needs updating —
which no migration or API in this project's toolset can set, so it must be
done by hand on any new project.

### React: don't define components inside components

> Tab components defined inside a page component get a new function identity every parent render, so React unmounts/remounts them and their form state resets — hoist them to module scope.

Hit in `EmployeeDetail.tsx` (Profile/Career/Comp/Account tabs); fixed by
hoisting to top level with `useToast()` inside each. Why it mattered: forms
silently losing in-progress edits whenever the parent re-rendered.

### Supabase MCP can't run destructive SQL from cloud sessions — use the SQL editor

> The Supabase MCP asks for a form confirmation ("elicitation") before SQL it detects as destructive (any DROP, even `drop table if exists` on a missing table); that form never reaches the user in a Claude Code cloud session, so `apply_migration` / `execute_sql` time out after 60 s and nothing is applied — approving the tool call itself is not that confirmation.

Seen 2026-10-19/20 (three attempts; documented by Supabase: "SQL
confirmations do not appear in your MCP client"). Reads, INSERTs and
non-destructive DDL work. What worked: the owner pasted the migration files
into the dashboard SQL editor (its "Potential issues" dialog: choose "Run
and enable RLS" when a file creates tables), then the session recorded them
in `supabase_migrations.schema_migrations` (version = repo file prefix, so
no renaming) and verified with `supabase/tests/fingerprint.sql` against the
local replica. Don't evade the confirmation (e.g. dynamic SQL to hide DROP);
`skip_elicitations` in the connector URL exists but removes a safety check.
Why it mattered: a "hung" migration looks like a broken database; it is an
unreachable prompt, and the all-or-nothing timeout leaves nothing behind.
The detector splits the SQL on every `;` — inside string literals and
comments too — and flags a piece that starts like DELETE/UPDATE without a
WHERE: an error message `'…can''t be edited; delete it and…'` and a comment
`-- …reached zero; a manual pause stays` inside an UPDATE both timed out
(2026-10-23). Find the culprit with `execute_sql` probes wrapped in
`begin; … rollback;` (a flagged probe times out, nothing applies), then
reword the text — that's a false positive, not a destructive statement.
Non-destructive migrations (CREATE OR REPLACE FUNCTION, CREATE TRIGGER,
ADD COLUMN, REVOKE) do apply through `apply_migration` — MCP records them
under the apply timestamp, so rename the repo file to that version.

### Test migrations and RLS on a local Postgres replica first

> Postgres 16 is installed in the sandbox; replaying every migration onto a scratch database with a small Supabase stub (API roles, `auth.users`/`auth.sessions`, `auth.uid()` from `request.jwt.claims`, storage schema) plus a psql RLS suite caught real policy bugs before anything touched the live project.

Stub, RLS suite and runner: `supabase/tests/`. Gotchas: postgres refuses
to run as root (initdb/pg_ctl as a separate user); start it with `setsid`
or it dies with the tool's shell; impersonate users with
`set local role authenticated` + `set_config('request.jwt.claim.sub', …)`
inside a transaction. Differences from Supabase (PG17, real GoTrue/storage)
remain, so the security advisors still run after the live apply. Why it
mattered: RLS mistakes are silent — a policy that is too open never errors.

### Year-end tax true-up is a flag on the last run, not a separate run

> Annualization (RR 11-2018 / Form 2316) happens inside the last regular payroll of the year or the final-pay run (`payroll_runs.annualize = true`): that run's withholding becomes annual tax due minus tax already withheld, refunds included.

A separate "year-end" run type would have no earnings to pay out and would
produce a negative net pay whenever the true-up is a refund. Separations
annualize per employee automatically: any payroll whose period includes an
employee's separation date settles their tax (and cash-rounding balance). A
final pay released after the last paid day (`final_pay` run, employee picked,
period after the separation) computes `extrasOnly`: one-time items, the
tax adjustment and the rounding settlement — no attendance pay, allowances
or contributions. The alphalist flags employees whose year is not
reconciled ("Under/Over-withheld … — annualize"). Why it mattered: BIR
expects tax withheld = tax due per employee on the alphalist; the previous
build left this manual, and final pay either double-paid days or skipped
the employee.

Since spec T8 the true-up never takes net pay below zero: what the pay
can't cover is paid by the employer (RR 2-98 §2.79(B)(5)(b) Step 4), stored
as `tax_paid_by_employer`, counted as tax paid for the year (2316 and
alphalist reconcile), remitted with that month's 1601-C, and recorded at
finalize as a paused advance that payroll deducts only after the employee's
signed authorization (Labor Code Art. 113). Refunds are recovered from the
1601-C of the month paid, then later months (`remittance.ts`). Why it
mattered: the old build could push December net pay negative.

### Whole-peso cash pay: round up or carry forward, never down

> Net-pay rounding for cash payroll is per client (`net_pay_rounding`, `rounding_scope`): `round_up` (employer adds the centavos) or `carry_forward` (centavos owed to the employee in `employees.rounding_balance`, added to the next payout and settled on final pay); there is no round-down.

Labor Code Art. 113 forbids deductions from wages beyond the listed
exceptions, so rounding down — even by centavos — is out. The carry chain
is maintained only by `finalize_payroll_run` / `reopen_payroll_run` (a
trigger blocks direct writes by API users); reopening must restore the
balance the run consumed. The payslip shows the rounding as its own line
so gross − deductions + rounding = net still ties to the centavo. Why it
mattered: the owner's minimum-wage workers are paid in cash, and decimals
there are impractical — but the fix must not shave wages.

### Tax year follows the pay date; the payroll month follows the cutoff

> Withholding on compensation is reported when PAID, so the alphalist, 2316, annualization YTD and 1601-C months use `pay_date`; monthly allocation, contributions and the 13th month (PD 851: basic EARNED in the year) use `period_month`, which is derived from the period END (cutoff), never from the pay date.

`slotFor(frequency, periodEnd)`: semi-monthly cutoff ≤ 15th = payroll 1,
else 2; weekly = k-th of the 4–5 cutoffs on that weekday in the month.
Cutoffs don't move when a payday is moved for a holiday, so every month
keeps a complete slot set (pay-date slots left a weekly month with 5 slots
and the next with no slot 1, and a 10th/25th client's Feb 11–25 period paid
Mar 2 collided with March's first). A Dec 16–31 payroll paid Jan 5 is
December for contributions and the next year for BIR. Withholding and
annual tax TABLES are also picked by pay date (contribution tables by
period end); the 13th month's ₱90k cap is measured on the tax year, and a
13th month paid after the year's annualizing payroll re-annualizes (else
the year never reconciles). Why it mattered: mixing the two bases either
breaks contribution months or files compensation in the wrong tax year.

### A draft is finalizable only if it is complete and current

> `totals.employees` must equal the draft's payslip count; computeRun writes a one-time `{computing: token}` BEFORE reading any input, and DB triggers reset totals to `{}` whenever attendance, approved leave, adjustments, allowances, deductions, employee records, holidays or client settings change — so finalize rejects partial, interrupted or stale drafts.

Plus `employees.payroll_seq` (bumped by every finalize/reopen touching the
employee, copied onto each payslip as `employee_payroll_seq`): a draft
computed before another payroll for the same person was finalized or
reopened has stale year-to-date, 13th-month or carry inputs and must be
recomputed. Finalize also refuses paying the same days twice (overlapping
finalized non-13th runs) — computeRun leaves such employees out with a
warning. Status changes only inside the RPCs (`payroll.lifecycle` GUC
checked by the run guard trigger). Why it mattered: reviewers finalized a
bonus that was added after computing (never paid, then locked) and paid a
separated employee's last days twice. Until 2026-10-23 the token was
written after the inputs were read, so a change landing in between was
overwritten and a stale draft could be finalized (the audit found it via a
repayment that took a cash advance below zero).

### supabase-js returns errors as plain objects, not Error instances

> `if (error) throw error` + `err instanceof Error ? err.message : 'Failed'` always shows the fallback: PostgREST/RPC failures are `{ message, code, details, hint }` objects. Use `errorMessage(err, fallback)` from `src/lib/errors.ts`.

Also check `res.ok` on raw `fetch` to edge functions: gateway failures
(expired JWT, function not deployed) carry no `error` key. Why it mattered:
every RPC's own guidance ("Recompute the draft…", "Reopen that later run
first") and every constraint-specific message was invisible.

### Never store a value derived from a credential where admins can read it

> Employee profiles keep `email = null`: the auth email is an unsalted SHA-256 of the login code, and with the 3-character hint an entity admin recovered a code in seconds; the derived address now lives only in `auth.users` (service role).

Replacing a code also stamps `profiles.sessions_revoked_at`;
`current_employee_id()` rejects access tokens whose `iat` is older, so the
old code's live JWT stops working immediately instead of within the hour.
Audit rows name employee actors by full name. Why it mattered: admins
could silently sign in as an employee, and a leaked code kept working for
up to an hour after it was "replaced".

### Browser walkthroughs need a local Supabase stack, not just the SQL replica

> Supabase Auth (GoTrue v2.180.0 binary) + PostgREST 12.2.12 + a tiny Node gateway (routes /auth/v1, /rest/v1, /functions/v1; answers CORS) + the edge function under Deno + Vite, all against the local PG16 with every migration, let Playwright drive the real app as each role.

Gotchas: GoTrue needs an existing `auth` schema and `search_path=auth` in
its DATABASE_URL (quote `&` in env files); kill services by pid file —
`pkill -f` matches its own shell; after a session/worker restart start
Postgres again as its own user (`pg_ctl -D … -o '-p 54329 -k /tmp' start`).
Why it mattered: the walkthrough found what unit tests and SQL tests
couldn't — wrong-date saves, mislabeled controls, phone overflow, a
double-click that duplicated loans.

Rebuilt 2026-10-24 in ~5 minutes for the Time report QA (no edge function
needed for pages that don't manage logins): the Postgres data directory
can't live under `/tmp/claude-0` (root-only 700) — use
`/var/lib/postgresql/phrdata`; seeding through plain SQL as the superuser works
(`guard_time_entry` fills `entity_id`); Playwright's `getByLabel` on a
`<label>`-wrapped `<select>` includes the option text in the name — use
`locator('label', { hasText }).locator('select')`.

Rebuilt again 2026-10-23 (second session, ~10 minutes): binaries from
GitHub releases `postgrest-v12.2.12-linux-static-x86-64.tar.xz` and
`supabase/auth` `auth-v2.180.0-x86.tar.gz` (its `migrations/` dir is
GOTRUE_DB_MIGRATIONS_PATH); create roles `authenticator` / `supabase_auth_admin`
and schema `auth` first, start GoTrue (it migrates), then replace
`auth.uid()`/`auth.jwt()` with the stub's versions, add the storage stub,
replay the repo migrations, sign the owner up through GoTrue (first user =
company admin). The gateway must DROP upstream `access-control-*` headers
before adding its own (duplicates fail CORS); the edge function runs under
`node --experimental-strip-types` with its `npm:` import rewritten to the
repo's supabase-js and a `globalThis.Deno` shim. Earlier rebuild notes:
the edge function also runs in-process in the Node gateway behind a tiny
Deno stand-in; payroll for seeding ran through the app's own
`computeRun`/`finalizeRun` loaded via Vite's server-side module loader;
since the new shell scrolls inside `<main>`, Playwright full-page shots
capture one screen — grow the viewport height instead.

### Audit actor for service-role writes comes from x-actor-id — service role only

> The admin-users function writes with the service role, so `auth.uid()` is null in the audit trigger; it now sends `x-actor-id: <calling admin>` and `audit_trigger()` honours that header only when the JWT role is `service_role` (a signed-in user's header is ignored, a malformed one yields no actor).

Why it mattered: login-code changes — the most security-sensitive admin
action — were logged with no actor. Tested in `11_audit_fixes_tests.sql`.

### A <label> around several controls clicks the first one

> `Field` used to render a `<label>`; around a checkbox list or day buttons, clicking its caption toggled the first item. Multi-control fields use `<Field group>` (div role=group + aria-labelledby).

Why it mattered: an admin clicking "Employees (required)" silently
selected someone for a final-pay run.

### Two Tailwind classes for one property: stylesheet order wins, not class order

> A caller's class can't reliably override a component's base class for the same property (`w-44` vs `w-full`, `px-3` vs `px-4`, `size-8` vs `size-9`, `border-accent-400` vs `border-slate-200`). Components take variants as props (`Button size`, `IconButton size`) and `controlClass()` drops its default width / border colour / background when the caller sets one.

Why it mattered: controls rendered full-width, small buttons rendered large,
and the timesheet's unsaved-change highlight never showed — all silently.

### Monthly contributions: never deduct beyond what the month still owes

> Runs of one payroll month can be finalized out of order (week 2 before week 1, a late special run for days before a finalized closing run). Every share is capped at `monthly − already deducted this month`; the closing run takes exactly the remainder.

Why it mattered: the reviewer's probes showed 1.5–2× the month's SSS/
PhilHealth/Pag-IBIG collected (`src/payroll/flows/contributionOrder.test.ts`).

### Event-based statutory leaves are not yearly balances

> Maternity (105 calendar days), paternity, solo parent, VAWC and special leave for women are granted per event/status; showing them as a default balance for everyone (portal cards, admin credits) was wrong. They show only once HR sets an entitlement (`showsBalance` in `src/lib/leave.ts`).

### The alphalist previous-employer section has its own status, period and reason

> Per the BIR 1604-C alphalist format (RMC 73-2019; read via search extracts of the BIR PDF on 2026-10-20 — the PDF itself was unreachable from the sandbox), the previous-employer block carries TIN, employment status, period of employment and reason of separation, besides the amounts. Stored in `employee_tax_years` and exported itemized.

Re-verify the exact column order against the current BIR Alphalist Data
Entry module before relying on the CSV column positions.

### Remittance due dates are not verified facts — only the owner's BIR rules are shown

> On 2026-10-20 the dashboard's "File 1601-C by the 10th", "SSS by month-end", "Pag-IBIG by the 10th–15th" hints turned out to be unverified and contradicted by current sources (BIR eFPS deadlines go by filing group; Pag-IBIG's window runs to month-end by the first letter of the employer's name; PhilHealth's goes by employer number). The tiles said only "remit next month — check the agency's schedule".

Since spec T9 (2026-10-25) the BIR dates come from the owner's spec (CPA,
with its Basis lines: 1601-C guidelines, RR 26-2002 as applied by RMC
125-2020, RR 11-2018, RMC 55-2026; a 2025 tax calendar confirmed eFPS
groups D and E on the 12th and 11th) and show only once the client's
filing mode is chosen. SSS, PhilHealth and Pag-IBIG stay per-client
settings with no default (P6) until each agency's own issuance is read.
Dates are never moved for weekends or holidays (P8): the user overrides
them with a note. Why it mattered: a wrong deadline shown as fact is worse
than none.


### The look lives in theme tokens and ui.tsx primitives (confirmed approach)

> The 2026-10-23 revamp re-skinned the app mostly through `@theme` tokens in `src/index.css` and the primitives in `src/components/ui.tsx`; new screens should compose those (Card `icon`, StatGroup/StatCard, StatusCounts, Badge tones, Segmented, IconButton, Th/Td/TableShell) instead of hand-written colour classes.

Rules that came with it: `brand-*` is the teal green (primary buttons
`brand-700`), headings and dark buttons use `ink-900` — not brand;
`accent-*` is lemon yellow, so text on it is `ink-900`, never white;
`slate-*` is overridden to the design's lavender greys, so existing
`text-slate-*` classes follow the theme; cards are flat `rounded-xl` with a
light border, no shadow. Why it mattered: the only page edits the re-skin
needed were where pages had hand-written navy/orange classes.

### Chart colours come from the dataviz validator, not the brand swatches

> The brand green #335f5a fails the chroma floor and sits under 15 ΔE from the timeline blue, so charts use the validated order green #3a8a5c → blue #1d6fb1 → yellow #eda100 → violet #6250d6 → orange #d9661a (dashboard bars, pay-run donut, payslip ring).

The attendance timeline palette was validated as the pairs that actually
touch (late | work | break | work | overtime); leave days never sit next to
another segment and carry a stripe texture plus a label. Re-run
`validate_palette.js` (dataviz skill) before adding a series colour. Why it
mattered: eyeballed brand colours gave pairs that colour-blind — and even
full-vision — readers could not tell apart.
recharts 3 sorts a legend alphabetically by default: pass
`itemSorter={null}` so it follows the series (stack) order — the Insights
cost chart listed "13th month" first above a stack that starts with basic pay.

### Work schedules are effective-dated patterns plus per-date roster changes (confirmed approach)

> For a date: a `schedule_overrides` row wins, else the newest `employee_schedules` pattern with `effective_from` ≤ date, else the legacy `employees.work_schedule` — so an earlier period always recomputes with the schedule it had, and nothing changed for anyone until a schedule was edited.

Shifts are stored as snapshots ({start, end, break_minutes, flex_minutes?,
compressed?, name?}); templates are presets, so editing a template never
rewrites schedules already set. Paid days are protected in the database: a
pattern can't start on or before `last_paid_date()` (finalized/paid regular,
special or final-pay runs) and roster rows are locked by
`attendance_locked()`; both take the employee's payroll advisory lock and
stale the drafts. Engine semantics: regular time is capped at the standard
day (or the whole shift on a compressed-workweek day, max 12 h); expected
minutes = the shift's own work minutes, so a half-day shift misses half a
day; monthly-paid hours past a short shift are paid at the regular rate
("extra_hours"); flexible start moves the shift. Why it mattered: the old
single `work_schedule` made every change retroactive — editing it would
have recomputed past drafts with the new hours.

### Hours-of-work rules behind the per-date engine (verified 2026-10-24)

> Researched with sources before building the schedule engine; re-verify if DOLE issues a new advisory on flexible work arrangements.

- Normal hours ≤ 8 a day (Art. 83); overtime beyond 8 hours, +25% on an
  ordinary day (Art. 87).
- Meal period of at least 60 minutes, not compensable (Art. 85); IRR Book
  III Rule I §7: a shorter meal period (not under 20 minutes) is allowed in
  listed cases but is **compensable hours worked**, and short rest periods
  count as hours worked — hence `unpaidBreak()` deducts only breaks ≥ 60.
- Weekly rest day: at least 24 consecutive hours after six consecutive
  normal workdays (Art. 91) — the roster warns on a seven-workday week.
- Compressed workweek (DOLE Department Advisory 02-04): voluntary, agreed
  by a majority of the affected employees, DOLE regional office notified;
  up to 12 hours a day with no overtime premium for hours within the agreed
  schedule; overtime beyond 12 hours a day or 48 hours a week (unless the
  practice is more generous). The app only marks a shift as compressed —
  the agreement and the DOLE notice are the employer's. Flexible work
  arrangements in general: DA 02-09; flexi-time: Labor Advisory 04-10;
  telecommuting rules: DO 237-22 (replaced DO 202-19).
- Probation: at most six months (Art. 296) = **180 days** (Mitsubishi
  Motors v. Chrysler Phils. Labor Union, G.R. 148738, applying Civil Code
  Art. 13); an employee allowed to work past it is regular, and so is one
  whose standards were not made known at engagement.
- Rest periods of 5–20 minutes are hours worked (IRR Book III Rule I §7):
  an off-the-clock gap of ≤ 20 minutes is credited (`REST_PERIOD_MINUTES`),
  and so is a scheduled meal period under 60 minutes taken off the clock;
  a longer gap counts against the unpaid meal break, then as time not
  worked. A grace period is the client's policy: a time in inside it is
  paid as on time (it used to come back as undertime) — credited only up
  to the shift's own hours, so a half day made up at the end isn't paid
  twice.
- A compressed workweek is fewer than six workdays and at most 48 normal
  hours (DA 02-04) — enforced on weekly patterns (`weekPatternProblem` /
  `valid_week_pattern`), not on single-date roster changes.
- Unused SIL converts to cash at the end of the year at the salary rate on
  the date of commutation (DOLE handbook) — the Insights leave report values
  it at the current daily rate.
Why it mattered: two first-draft semantics were wrong against these rules —
30-minute breaks were being deducted as unpaid, and compressed days had no
12-hour ceiling.

### Probation ends on hire date + 180 days, not + 179 (correction)

Mitsubishi Motors v. Chrysler Phils. Labor Union (G.R. 148738) counts the
six months as 180 days with the first day excluded (Civil Code Art. 13):
hired May 27, 1996 → probation ended Nov 23, 1996. My first `probationEnds`
returned hire + 179; the labor review caught it (`insights.ts`, test pins
the case). Why it mattered: a day early tells HR to decide on
regularization before the law's deadline is actually reached.

### An MWE's premium above the minimum wage day is taxable (owner's spec T5)

The MWE exemption covers the SMW, holiday pay, overtime, night differential
and hazard pay only (RR 2-98 Sec. 2.78.1(B)(13), RMC 50-2018 A13): the 30% /
50% rest-day and special-day premium, and pay above 200% on a regular
holiday that is a rest day, are taxable S lines (`*_addon`). Why it
mattered: the app used to exempt the whole premium (an open question in
the README), under-withholding MWEs who work rest days.

### Bonuses past the ₱90,000 exemption are taxed when paid (correction)

Regular payrolls used to classify every 13th-month/other-benefits line as
non-taxable and left any excess to the December annualization. Now each
regular payroll taxes what its benefits exceed of the tax year's remaining
exemption (`benefitsExemptLeft`, from the tax-year payslips the service
loads for every payroll), for MWEs too; since spec T2 the excess is S of
the period it is paid. Why it mattered: a June bonus of ₱150k
under-withheld ~₱16.8k until December, and an employee who left before
December was never trued up on it.

### Withholding: the row comes from R; CAM from a trigger to year end (confirmed approach, spec T2)

Taxable pay splits by pay code into R (basic pay, allowances paid every
period, basic corrections) and S (overtime, premiums, ND, hazard pay,
commission, other one-time pay, the ₱90k excess). Regular method:
`taxOnRow(R + S, bracketFor(R))`. CAM (`periodWithholding`): when R is in
the 0% row and S was paid this year (a), S ≥ R with S > 0 (b), a previous
employer this year (c), or any of these earlier in the year — cum = the
year's R + S + previous employer's taxable, n = pay periods of this
frequency by pay date from the first pay of the year, due = n × base +
rate × (cum − n × lower bound) exact, less everything withheld. Why it
mattered: the old lookup on R + S over-withheld (W1: 11,875.05 instead of
11,208.40), and an R in the 0% row withheld nothing on any S. The readings
the spec leaves open are in `docs/payroll-spec-mapping.md` §5 — don't
change them without the owner.

### round2 must not return -0 (correction)

> `round2` adds `+ 0`: `Math.round(-0.004 * 100) / 100` is -0, and `(-0).toLocaleString()` prints "-0".

Found by the T8 separation test (an alphalist variance of -0). Why it
mattered: reconciled employees could show "-0.00" as their balance, and
`Object.is`-based test assertions fail on it.

### CHECK constraints fire in alphabetical order by name

Postgres tests a row's CHECK constraints in name order (after NOT NULL).
`sync_pay_code` leaves `pay_code` null when a category has no code, so the
older `payroll_adjustments_category_check2` still refuses an earning with a
deduction's category (it sorts before `..._pay_code_kind`), and it keeps a
category-only row's own category so `payroll_adjustments_benefit_kind`
still refuses "maternity benefit, taxable". Why it mattered: the first
version overwrote the category from the code and silently "fixed" a
contradictory row that suite 16 expects refused.

### SSS follows the month's actual compensation; the closing payroll settles it (confirmed approach)

RA 11199 Sec. 8(f): SSS compensation is all remuneration for the month
(OT, COLA, allowances), not the rate. Earlier payrolls of a month deduct a
provisional share on the rate; the month's closing payroll (last slot, a
separation, or any payroll computed after the closing one was final)
deducts what the month's actual pay requires less what was already taken —
a negative line refunds an over-deduction; a month with no compensation
owes none, and a payroll that paid no compensation (a period on maternity
or unpaid leave) takes no provisional share. PhilHealth stays on the basic rate, Pag-IBIG on basic +
allowances. Since spec T3 a line is in the base by its pay code's
`sss_include` (stored on the line as `sss`; lines from before keep the old
bucket rule): bonuses are in except CHRISTMAS_BONUS, LIQUIDATED_ALLOWANCE is
out, and the P2/P3 codes are company-admin settings (off by default). Flow tests that expected a full rate-based month for mid-month
hires/absences were wrong and were changed. Why it mattered: rate-based
SSS under-remits for anyone with OT or allowances (SSS assesses
deficiencies with 2%/month penalties) and over-deducts partial months.

### Maternity leave is paid as the SSS benefit + salary differential, never as salary (confirmed approach)

RA 11210's 105 days of full pay are the SSS maternity benefit (advanced
in full within 30 days of the application, reimbursed by SSS) plus the
salary differential (unless the employer is exempt). Payroll docks leave
days with code `ML` from salary (monthly) or pays nothing for them (daily);
the admin adds the two amounts as adjustments (pay codes MAT_SSS_BENEFIT,
tax-exempt, and MAT_DIFFERENTIAL); the differential counts toward 13th
month (`thirteenthBasis`, P9 setting) and, since spec T4, is taxable S by
default (P1 setting — RMC 105-2019's exemption isn't confirmed) and in the
SSS base; the review warning appears only in the payroll the leave starts
in (`leaveStart`), and without the client's DOLE exemption for the year a
missing differential is an error that blocks finalizing. Why it mattered: paying full salary for the leave
days taxed exempt pay, overpaid exempt small employers who owe only the
reimbursed SSS benefit, and missed the 30-day advance.

### Per-payroll deduction amounts are rows on the draft, not edits to the installment (confirmed approach)

> `payroll_deduction_overrides` (run, deduction, amount ≥ 0; 0 = skip) sets what one draft deducts; the deduction's own `amount_per_period` (0 = no fixed installment) stays the default for every other payroll.

computeRun applies the set amount even to a paused or not-yet-started
deduction, caps it at the balance (the guard refuses more), and the payroll
that settles a separation still takes the whole balance unless an amount is
set (then it warns what is left). Finalize needed no change: it moves
balances by the payslip lines. Overrides lock with the run (reopen to edit)
and stale the draft. Why it mattered: the informal "how much can you pay
this cutoff?" practice needs a per-payroll answer that leaves an audit trail
and doesn't silently change the agreed installment; a larger-than-agreed
amount warns that it needs the employee's written agreement.

### Management reports read finalized payslips only, by payroll month (confirmed approach)

> Insights pay figures come from finalized/paid runs grouped by `period_month` (the cutoff's month, as the 13th month and contributions use); attendance comes from those payslips' own day traces (`computation_trace->days`), deduplicated per employee-day.

Drafts would show numbers that can still change; the day traces are payroll's
own computation, so the attendance report can never disagree with what was
paid (same reason as *Attendance visuals must use payroll's own day
computation*). People-based reports (headcount, leave, advances) read the
current records as of today. Every report returns one model (KPIs, findings,
charts, tables), so the screen, CSV and PDF can't drift apart; the builders
are pure and unit-tested in `src/lib/insights.test.ts`.

### Same route, new id: the page stays mounted — key record pages by id

> React Router keeps `/admin/employees/A` mounted when you go to `/admin/employees/B`; tabs that copy the record into form state keep A's values, and Save writes them onto B. `EmployeeDetail` renders `<EmployeeRecord key={id}>` (the open tab is lifted out so it survives prev/next).

Why it mattered: the revamp's prev/next buttons made this reachable — QA
reproduced A's ₱68,000 rate and bank account saved onto B, and a freshly
issued login code shown and printed under the next employee's name.

### Attendance visuals must use payroll's own day computation

> The timeline's late, overtime and hours come from `computeAttendance` for the day (`src/lib/timeline.ts`): payroll waives lateness when the standard day is completed, counts overtime as net minutes beyond the standard day after the unpaid break, and charges no tardiness on non-working holidays — edge-based "arrived after 9:00 / left after 18:00" bars contradicted all three.

Why it mattered: employees would have seen lateness they weren't docked and
overtime they wouldn't be paid. The Time In/Out report (`src/lib/timeReport.ts`)
follows the same rule for every figure, clips the range to the hire and
separation dates (like the engine's absence warning), and treats days after
today as upcoming — never absences, not counted as workdays.

### Sign out this device only — edge functions see revoked sessions, PostgREST doesn't

> `supabase.auth.signOut()` defaults to scope `global`: it deletes EVERY session of the account. A tab elsewhere keeps a still-valid access token, so database calls (stateless JWT) keep working while `admin-users` (`auth.getUser` → GoTrue checks the session row) answers 401 "Not authenticated".

Found in the live auth logs on 2026-10-23: the owner signed out (testing the
employee portal) at 07:37 UTC; the desktop tab's create-admin calls failed
from 07:50 with `session_not_found`. Fix: `signOut({ scope: 'local' })`, and
`callAdminUsers` refreshes once on 401 — a refresh refused with a
session-ended answer (`refresh_token_not_found` / `_already_used`,
`session_not_found`, 400/401/403) signs this device out with
`SESSION_ENDED`; `AuthRefreshDiscardedError` (another tab rotated the token
at the same moment) re-reads the session and retries; a 5xx / 429 says "try
again" (audit 2026-10-23: the first version signed people out on those).
Note auth-js
2.112 keeps the stored session when a refresh fails while the access token
is still valid, so the explicit local sign-out is required. Why it mattered:
the app looked signed in but could not create admins or set login codes.

### Leave service requirements are leave-type data plus a database guard (confirmed approach)

> `leave_types.min_service_months` (SIL 12, per client, editable) + `guard_leave_request` refuses a pending/approved leave starting before `hire_date + months` unless that year's `employee_leave_entitlements.days > 0`; `src/lib/leave.ts` (`eligibleFrom`, `usableOn`, `addMonths` clamps like Postgres) mirrors it for the screens.

Credits as the override let HR grant it sooner (company policy, rehires with
broken service) without a code change; zero credits don't count. The check
runs on insert and on status/date/type changes, never on reject/cancel. For
event leaves (SPL) a credit is also the eligibility switch, so setting one
bypasses the months — the Entitlements tab shows the opening date. Why it
mattered: SIL showed 5 days to a hire of one day.

### A scheduled day with no time in/out is an absence — the engine says so

> `attendance.ts` marks a scheduled regular day with no complete entry (an entry without a time out is dropped) and no leave `absent` (docked for monthly, unpaid for daily); nothing distinguishes "not entered yet". `computePayslip` now warns with the dates — only dates inside the employment (`hireDate`/`separationDate` on the engine input: days before a mid-period hire are absences in pay, which is how such a period is prorated, but no one's missing time); the planned "ready check" should block computing instead.

Why it mattered: computing before a cutoff ended, or forgetting a day, would
silently underpay — the only clue was a "Days absent" total.

### Cash advances are balance-tracked deductions with a ledger, an authorization and a guard (confirmed approach)

> An advance is a `recurring_deductions` row (category `cash_advance`, `total_amount` = released, `balance` = owed, `released_on`, `release_method`, `authorized_on`); payroll deducts it like a loan line (`other:cash_advance`, meta = id), after tax and only up to net pay; finalize/reopen move the balance; `advance_repayments` cover money repaid outside payroll. Invariant: released = finalized payroll lines + repayments + balance — `advanceLedger` rebuilds the history and flags any gap.

Legal basis (secondary sources, re-verify before advising a client): wage
deductions need the employee's written authorization and the employer may
not profit (Labor Code Art. 113; IRR Book III Rule VIII as amended by DOLE
D.O. 195-2018), so the app refuses an advance without the signed date,
charges no interest, and prints the agreement. Deducting a balance from
final pay rests on that written authorization (the agreement's term 3);
commentators disagree on anything less, and some say deductions shouldn't
push pay below minimum wage — not enforced, the installment is agreed. `guard_cash_advance` lets the balance
move only inside finalize/reopen (`payroll.lifecycle`) or a repayment
trigger (`payroll.advance_repayment`), and even there keeps 0 ≤ balance ≤
released (finalize of an over-deducting draft fails); before anything is
repaid the amount can be corrected or the advance deleted. `active` is
only the admin's pause switch: repayments never touch it (a zero balance
already stops payroll), and a paused advance is not collected at
separation — that payroll warns what is still owed instead. Repayments take the employee's
payroll advisory lock first (same order as finalize). Why it mattered: a
balance edited by hand loses where the money went — the owner asked for
"accurately".

### Approved corrections are marked in `time_entries.flags`, not `source`

> `review_time_correction` appends `'corrected'` to the flags of an entry it changes; only an entry it creates also gets `source = 'correction'`. Detect corrections by the flag.

Why it mattered: the report's first version checked `source` and would have
shown most corrected days (edits of existing entries) as never corrected.

### Correcting a payroll after payday (researched 2026-10-24)

> Finalized runs are corrected by reopening (only sound while nothing later is finalized for those people) or in the next payroll: one-time earnings for underpayments, a balance deduction with written consent for overpayments after reopening, and the year-end annualization for withholding that was off. Tax-only and reversal adjustments do not exist yet.

In the app (written up for admins in `docs/USER_GUIDE.md`): **Reopen as draft**
restores loan/advance balances and rounding carries, but later finalized
payslips are not recomputed (only a carried rounding blocks it), so reopen
latest-first and finalize oldest-first. Underpaid → one-time *Earning* in the
next run, in the original BIR bucket (basic counts for the 13th month).
Overpaid → reopen and correct (so taxable pay is right), then a Pay-tab
deduction with a balance; a one-time *Deduction* is after tax and leaves the
excess in taxable pay. Withholding off but taxable pay right → the
annualizing run (December, or final pay) withholds the shortfall or refunds
the excess; the alphalist flags who is under/over-withheld. Annualization
reads the STORED payslip lines, so a misclassified earning or a wrong MWE
flag is only fixed by recomputing those payrolls.
Verified via search extracts (≥ 2 sources unless noted; .gov.ph unreachable):
- RR 2-98 §2.79(B)(5) as amended by RR 11-2018: a year-end deficiency is
  withheld from the December pay (last pay if separated); an excess is
  refunded by January 25 of the next year. No rule found for or against a
  mid-year correction (unverified either way).
- BIR 1601-C (Jan 2018 ENCS) Item 26 "Adjustment of Taxes Withheld from
  Previous Month/s" (Part IV Schedule 1); an amended return is allowed within
  3 years absent an audit notice; no BIR rule found on adjustment vs
  amendment. Late/short remittance: 25% surcharge (50% willful), 12% a year
  interest, compromise; micro/small taxpayers 10% and half interest (RR 6-2024).
- Overpayment recovery from wages needs the employee's written authorization
  and no pecuniary benefit to the employer (IRR Book III Rule VIII §10 as
  amended by D.O. 195-2018); TSPIC v. TSPIC Employees Union (G.R. 163419, 2008)
  upheld staggered recovery of a payroll-error overpayment (2 digests).
- SSS / PhilHealth / Pag-IBIG corrections after remittance: unverified.
Gaps offered to the owner (not built): a withholding-tax adjustment line for
mid-year corrections, a negative (reversal) earning adjustment, and a guard
or warning on reopening a run that later finalized payslips depend on. Why it
mattered: the honest answer to "how do we fix it" depended on what the code
really does, and the overpayment path silently over-taxed the employee.

### Product direction (owner review 2026-10-23)

> Keep the engine and DB controls; rebuild the experience around the pay cycle. Agreed order: quick wins (ready check before computing, one requests inbox with balances + bulk approve, form safety nets, onboarding checklist, plain-language renames) → big bets (Excel import of employees/attendance, all-clients payroll board, bank + SSS/PhilHealth/Pag-IBIG files) → on client demand (phone clock-in as admin-approved requests, emailed payslips, second approver, alphalist DAT).

Full reasoning, PH must-haves and sources: the owner's doc
https://claude.ai/artifact/3DbHSdFJgJLhr3yd388fbv (Claude Docs). Open
questions there (client's banks, SIL exemption, time capture, approvers,
email) decide the order — ask before building the lower-right items.
