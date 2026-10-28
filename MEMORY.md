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

### 2026-10-26 — Owner's compliance spec C1–C10 (branch `claude/affectionate-carson-hyuwes`, restarted from main after PR #6)

**Asked:** the owner (CPA) answered the open accountant items with an
implementation spec (C1–C11, open items O1–O9; chat only, not in the repo):
MWE premiums taxable, withholding on supplementary pay, year-end shortfall
cap and refunds, de minimis ceilings, SSS base, maternity contributions,
PhilHealth NG share, holiday settings, due dates, BIR outputs, NCR wage.

**Did:** one commit per change ID, tests first with the spec's vectors
(`src/payroll/compliance.test.ts`, flows `withholdingMethods`, `maternity`;
SQL suite 17). Seven migrations `20261026000100`–`…0700` (placeholders,
NOT applied live — need the owner's approval). Legal constants moved to
`src/payroll/law.ts` (value, effective date, source); de minimis ceilings
are a new versioned table `legal_parameters`. C11 skipped: the only client
is in CAR. Tests 282 → 340. The official PDFs in the spec's sources
(bir-cdn, lawphil, philhealth) are unreachable from the cloud sandbox
(proxy 403 / DNS), so no label or figure was checked against them.

**Review round (same day):** an independent review found nine defects,
all fixed with flow tests that fail on the old code (tests 340 → 348):
maternity pay is the line marked `benefit`, a semi-monthly payout covers
its own month's other payroll, the tax year to date stops at the payroll's
pay date and counts last year's periods paid in January, a 13th month's
SSS counts in its re-annualization, the final-pay check reads the month's
13th month, the NG share's closing payroll refunds an earlier deduction,
migrations 0200/0500 fix old rows instead of relying on NOT VALID, and a
`legal_parameters` change marks drafts stale.

**Applied live (same day, owner's approval):** the seven migrations
through MCP, files renamed to the recorded versions; fingerprint, advisors
and logs checked (see deployed state). A final independent review of the
whole branch found four more defects, all fixed in code only with tests
that fail on the old code (348 → 352). The year's tax now takes the pay
before loans. Monthly de minimis ceilings count the payroll month. The
payroll holding a separation date closes the month for a later 13th month.
The ₱90,000 exemption left counts only benefits paid by the pay date.

### 2026-10-28 — Pay history, then fixed-salary, output and consultant pay (same branch, restarted from main after PR #7)

**Asked:** see an employee's pay-rate progression, and pay consultants and
executives once or twice a month on output instead of attendance. The
owner's decisions: no-timekeeping is a toggle per employee, their 13th
month and SIL are company policy, consultants are both employees on
retainer and independent contractors, admins approve outputs, employees
don't see their pay history.

**Did (part 1, pay history):** `employee_pay_rates` (migration
`20261028113903`, live), payroll by the rate of each day, the Pay
History tab (step chart, table, payrolls paid at another rate, gross by
month), rates on career events moved into the history, **Reports → Pay
changes**. Tests 352 → 363, SQL suite 18.

**Did (part 2, fixed salary):** `employees.fixed_salary` and
`thirteenth_month_eligible` (migration `20261028113953`, live): a
monthly-rated employee paid without timekeeping (no absence or lateness
docking, no overtime or premiums; leave without pay and days outside the
employment deducted, presumed workdays count for per-day allowances), and
a 13th month run leaves out one whose policy says no. The time report
shows no absences for them. Tests 369, SQL 18.5.

**Did (part 3, output pay):** `employees.output_pay` (basic = paid by
results, or fees / commission / other supplementary on top of the salary)
and `output_thirteenth_month`, `employee_outputs` (admins only, guard,
locks with the finalized payroll) and the private `output-reports` bucket
(migration `20261028114041`, live); the Outputs tab, output lines in
the engine, Pag-IBIG/PhilHealth settled on the month's output pay. Tests
379, SQL suite 19. The local QA gateway emulates Storage (rows under the
caller's RLS, bytes on disk) — `/tmp/claude-0/stack/gateway.mjs`.

**Did (part 4, consultants):** `consultants` (with `fee_kind`),
`consultant_declarations`, `consultant_billings`, `ewt_quarter_filings` and
the read-only `ewt_versions` (migration `20261028114218`, live); the
Consultants page (checklist sign-off before billing, yearly sworn
declaration, billings withheld by the database, the BIR tab: 1601-EQ with
the 0619-E months, QAP CSV, 2307 figures, filing dates, the declarations
list; a filed quarter locks its billings) and the EWT card on Statutory
Tables. Tests 390, SQL suite 20. `supabase/tests/run.sh` now runs suites
10–99 (it globbed `1*` only, so suite 20 never ran at first).

**Did (follow-ups):** EWT filing dates a client can change
(`ewt_due_dates`, in `20261028114218`), shown on Reports → Due dates too;
the unworked regular holiday of a worker paid by results computed (Sec.
8(b)) instead of warned about. Tests 395, SQL suite 20.

**Did (review, walkthrough, live):** a high-effort review of the branch
found 10 items, 9 fixed: mid-period monthly→daily segments, deduction
labels counting daily days, the holiday absence rule docking a fixed
salary that keeps no time, career events recorded without their rate
(now refused up front or removed when the rate fails), the toggle label,
the backfill date, the output preview's rounding, duplicated date helpers
(plus a dead counter); the pg_cron drift needs no change (pg_cron is
live). Added: a warning for output made on a worked holiday or rest day.
Playwright walkthrough on the local stack (pay history, career events,
outputs, a weekly run paying by-results holiday pay from the weeks before,
EWT date overrides, the employee portal and its REST access) found no
further bugs. Migrations applied live (see deployed state). Tests 400.

---

## Current deployed state (update when it changes)

**2026-10-28: the four pay-diversity migrations are live** (owner's
approval), through MCP `apply_migration` as `20261028113903
pay_rate_history`, `20261028113953 fixed_salary`, `20261028114041
output_pay` and `20261028114218 consultants`; repo files renamed to those
versions. `fingerprint.sql` matches the local replica on all eight hashes
(37 tables, 552 columns, 292 constraints, 103 indexes, 68 policies, 72
functions, 117 triggers). pg_cron is installed and `refresh-current-pay-rates`
runs at 16:05 UTC (00:05 Manila). The backfill gave each of the 2 live
employees one `hired` row from its hire event (= its current rate); the
career events' rates were moved off. Security advisors: the 10 intentional
WARNs plus `can_manage_output_report` (executable by `authenticated` by
design: the output-reports storage policies call it as the caller), and
the leaked-password setting. Performance: INFO only (one new unindexed FK,
`consultant_declarations.entity_id`, on a tiny table). PR #8 (this
branch) was merged at the owner's request on 2026-10-28 (merge commit
`45a8d5a`); the Pages workflow deploys main, so the old Pay tab's direct
rate edits (refused by the history guard) were only possible in the few
minutes between the migrations and that deploy.

**2026-10-26: the seven compliance migrations are live** (owner's
approval), as `20261026084112 mwe_premium_pay` … `20261026084508
filing_due_dates`. `fingerprint.sql` matches the local replica on all
eight hashes; constraint validation and table grants match too. Security
advisors are unchanged (same 10 intentional WARNs and the leaked-password
setting), and the Postgres logs show no errors. Live data was untouched:
no old PhilHealth waivers, de minimis rows, payrolls paid before 6 Jan
2026 or draft payrolls existed. The PhilHealth waiver columns were renamed,
not dropped (MCP refuses DROP). PR #7 (this branch) was merged at the
owner's request on 2026-10-28 and the Pages workflow deploys main. Between
the migrations and that deploy the live site couldn't save an employee,
because the old form sent the renamed waiver columns. Payroll compute kept
working (it selects `*`). Apply migrations and merge in one sitting.

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
differential are entered by the admin, not computed. Settled by the owner's
spec of 2026-10-25: an MWE's rest-day and special-day premiums are taxable.
NCR-27 (suspended, in litigation) and its contingent top-up report were
not built: no NCR client.

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
  Secs. 6, 10 — rest days passed over, successive holidays chain) — since
  the owner's spec of 2026-10-25 only when the client turns on
  `holiday_absence_rule` (default off: "may not be paid", O8); special
  days no-work-no-pay; 13th month = YTD basic ÷ 12, due Dec 24; apprentices
  and learners ≥ 75% of the minimum (Arts. 61, 73); final pay within 30
  days, COE within 3 days of request (Labor Advisory 06-20); deductions
  the law doesn't provide for need written authorization (Art. 113; DO
  195-18).
- **Contributions' bases** (verified 2026-10-24, SSS revised by the owner's
  spec 2026-10-25): SSS on all remuneration of the SSS month — OT, COLA,
  allowances, de minimis, bonuses and the 13th month (client setting,
  default on, O2); only a Christmas bonus and allowances subject to
  liquidation are out (RA 11199 Secs. 8(f), 8(h); IRR Rule 12 Secs. 6,
  8); maternity leave months at the usual amounts; PhilHealth on monthly
  basic salary; Pag-IBIG on basic + allowances up to ₱10,000 (secondary
  sources only — circular text not reached). PhilHealth employee half is
  paid by the national government ("NG share – non-collectible", neither
  deducted nor remitted) for PWDs from the month the requirements were
  submitted (Circular 2026-0017) and solo parents from the first month
  billing shows the tag, not before October 2026 (Circular 2026-0015),
  through the month before the ID's expiry month. WISP is now
  "MySSS Pension Booster (Mandatory)".
- **Tax** (verified 2026-10-24): 13th month + other benefits beyond ₱90,000
  are taxable compensation when paid — for MWEs too (Soriano v. Secretary
  of Finance, G.R. 184450, 2017); year-end adjustment on the last payroll
  paid in December, refunds by Jan 25 (RR 2-98 as amended); BIR 2316
  items 26–28 = total withheld as adjusted, PERA credit, total. Per the
  owner's spec (2026-10-25): an MWE's rest-day/special-day premiums are
  taxable (item 51 "Premium pay (MWE)"), the extra 30% of a regular
  holiday on the rest day taxable by default (O1); hazard pay exempt only
  with a hazardous-assignment certification; supplementary pay withheld at
  the regular pay's bracket or on the cumulative average method (RR 2-98
  Sec. 2.79(B)(3), (5)(a)); the year-end shortfall capped at the last pay
  after contributions (before loans and other deductions, which take what
  is left), the employer advancing the rest; de minimis ceilings of RR 29-2025 from
  6 Jan 2026 (in `legal_parameters`, `verified_on` null: from the spec, the
  PDF unreachable); alphalist per RMC 160-2022.
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
- **De minimis** (RR 29-2025, eff. Jan 6, 2026): rice ₱2,500/mo, uniform
  ₱8,000/yr, laundry ₱400/mo, medical assistance ₱12,000/yr, gifts ₱6,000/yr,
  CBA+productivity ₱12,000/yr, OT meal 30% of regional minimum wage,
  monetized VL 12 days. The app treats de minimis as admin-flagged
  non-taxable allowances — ceilings are the admin's responsibility.

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
first-of-month `effective_from`, documented (legal basis, description, https
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

The Claude built-in browser can't open this container's localhost (and a
cloud session has no link to it): drive the stack with the pre-installed
Playwright. After the QA DB falls behind the migrations, compare
`fingerprint.sql` (and a per-object listing) with `phr_test` and apply the
missing pieces rather than rebuilding (the auth users and seed survive).

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

> Per the BIR 1604-C alphalist format (RMC 73-2019 then; the owner's spec of 2026-10-25 says to follow the revision of RMC 160-2022, with PERA data — read via search extracts on 2026-10-20, the PDFs themselves unreachable from the sandbox), the previous-employer block carries TIN, employment status, period of employment and reason of separation, besides the amounts. Stored in `employee_tax_years` and exported itemized.

Re-verify the exact column order against the current BIR Alphalist Data
Entry module before relying on the CSV column positions.

### Due dates come from the owner's sourced table, each editable per year (revised 2026-10-26)

> The dashboard tiles still say only "remit next month". Exact dates now live in BIR & Reports → Due dates, from the owner's spec (C9) with a source per rule in `law.ts` DEADLINES: 1601-C 10th (December 15 Jan) or eFPS group A–E, SSS last day of the next month, PhilHealth by the employer number's last digit, Pag-IBIG entered by the client (O4, HDMF circular unread). Weekend/holiday dates get a note, never moved; extensions are per-year rows in `filing_due_dates`.

Why: on 2026-10-20 dates written from memory were wrong; dates are data
from a named source, and agencies extend them.


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

### Supplementary pay is withheld at the regular pay's bracket, or on the cumulative average (owner's spec, 2026-10-25)

> Taxable pay splits into regular (basic, fixed allowances: 2316 items 39–44) and supplementary (items 45–51); the bracket comes from the regular part only. The cumulative average method takes over (and stays for the year) when regular pay is in the zero bracket with supplementary pay, when supplementary ≥ regular, or with an earlier employer this year.

Every payroll now reads the tax year's payslips (taxable income, tax
withheld, `computation_trace.tax.method` for the sticky method). Why it
mattered: running regular + bonus through the table taxed the bonus at the
next bracket (WHT-1: 11,875.05 vs 11,208.40), and zero-bracket employees'
bonuses were never withheld at all until December.

The year to date is the tax year's payslips paid by this payroll's pay
date, so a reopened March ignores June's commission and keeps its method.
The same goes for the ₱90,000 exemption left.
The period count n adds last year's periods paid this tax year: a Dec 16–31
payroll released on Jan 5 is period 1, and Jan 1–15 is period 2. Why it
mattered: one period short withheld ₱4,631 instead of ₱623 on a ₱18,525
semi-monthly pay.

### Bonuses past the ₱90,000 exemption are taxed when paid (correction)

Regular payrolls used to classify every 13th-month/other-benefits line as
non-taxable and left any excess to the December annualization. Now each
regular payroll taxes what its benefits exceed of the tax year's remaining
exemption (`benefitsExemptLeft`, from the tax-year payslips the service
loads whenever a payroll pays a benefit), for MWEs too. Why it mattered: a
June bonus of ₱150k under-withheld ~₱16.8k until December, and an
employee who left before December was never trued up on it.

### SSS follows the month's actual compensation; the closing payroll settles it (confirmed approach, base widened 2026-10-25)

Since the owner's spec (C5): the base is every pay item of the SSS month —
13th month (client setting), bonuses, de minimis, leave conversions —
except a Christmas bonus and an allowance subject to liquidation
(`pay_item_type`); a 13th month run paid after the month's closing payroll
trues SSS up itself. Maternity leave months contribute the usual amounts
(next lesson), not the actual pay.

RA 11199 Sec. 8(f): SSS compensation is all remuneration for the month
(OT, COLA, allowances), not the rate. Earlier payrolls of a month deduct a
provisional share on the rate; the month's closing payroll (last slot, a
separation, or any payroll computed after the closing one was final)
deducts what the month's actual pay requires less what was already taken —
a negative line refunds an over-deduction; a month with no compensation
owes none, and a payroll that paid no compensation (a period on unpaid
leave) takes no provisional share — maternity leave months excepted. PhilHealth stays on the basic rate, Pag-IBIG on basic +
allowances. Flow tests that expected a full rate-based month for mid-month
hires/absences were wrong and were changed. Why it mattered: rate-based
SSS under-remits for anyone with OT or allowances (SSS assesses
deficiencies with 2%/month penalties) and over-deducts partial months.
A 13th month that trues SSS up passes that SSS to its own
re-annualization (the alphalist was ₱37.50 off), and the separation-month
check reads the month's 13th-month payslip too (it reported a false
over-deduction). The payroll holding the separation date closes the month
like its last slot. Otherwise a 13th month paid after it took no SSS on
itself (₱1,125 + ₱2,270 short on a ₱25,000 salary).

### Maternity leave is paid as the SSS benefit + salary differential, never as salary (confirmed approach)

RA 11210's 105 days of full pay are the SSS maternity benefit (advanced
in full within 30 days of the application, reimbursed by SSS) plus the
salary differential (unless the employer is exempt). Payroll docks leave
days with code `ML` from salary (monthly) or pays nothing for them (daily);
the admin adds the two amounts as adjustments marked `benefit`
(`sss_maternity` / `maternity_differential`, category other non-taxable,
RMC 105-2019); the differential counts toward 13th month
(`thirteenthBasis`); the review warning appears only in the payroll the
leave starts in (`leaveStart`). Why it mattered: paying full salary for the leave
days taxed exempt pay, overpaid exempt small employers who owe only the
reimbursed SSS benefit, and missed the 30-day advance.

Since the owner's spec (C6): every leave month contributes SSS, PhilHealth
and Pag-IBIG at the usual amounts, paid or not; the payroll paying the
maternity pay deducts the employee shares of the other leave months
(`maternity_contributions` line with `covers` per month), and a leave
month uses them (`ee_prepaid`) or waits for them (`ee_pending`). A client
with a DOLE exemption (`maternity_differential_exempt` + reference +
valid-until; a leave starting later isn't exempt) doesn't take them from
the SSS benefit: `ee_collect`, a receivable listed on Cash Advances. A
period wholly on maternity leave pays no salary (a 21-weekday month used
to leave ₱1,034 of a ₱30,000 salary).

Maternity pay is recognized by the line's `benefit`, never by its
category. An allowance subject to liquidation is also other non-taxable
and not SSS compensation, and a ₱500 taxi reimbursement once prepaid four
months of shares. The payout payroll also covers the other payrolls of
its own month (semi-monthly: the second half's share, or the first half's
pending one).

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

### Live CHECK constraints can't widen: add a typed column, or edit only unapplied migrations

> The Supabase MCP refuses any statement with DROP (cloud sessions never see its confirmation), so a CHECK on a live column can't be replaced. New pay-item kinds became new columns (`de_minimis_kind`, `pay_item_type`, `leave_days`) with their own CHECKs; renamed columns use RENAME (the PhilHealth waiver → `ph_ng_*`).

A CHECK in a migration that isn't live yet can still be edited in place
(C10 widened C5's `pay_item_type` that way). Why it mattered: widening
`payroll_adjustments.category` for commissions would have needed a DROP the
tooling can't run.

### Pay rates are a dated history; the employee row is today's copy (confirmed approach, 2026-10-28)

> `employee_pay_rates` (from a date, reason, approver; admins only) is the source of truth. Payroll resolves the period's rates from it (`rateSegments`) and pays each day at its own; the employee row's `pay_type`/`monthly_rate`/`daily_rate` hold today's rate, refreshed by a trigger on the history and nightly by pg_cron, and a direct edit of them is refused.

When the rate changes inside a period and monthly rates cover at least
half of it, the monthly rate in effect longest pays the period's salary
less the other days at its daily rate, and each other day is paid at its
own rate — so a change to an equivalent rate pays the same salary and an
absence after a raise nets to zero. Mostly daily-rated, every day is paid
at its own rate (a monthly rate's days at its daily rate): the salary less
9–11 daily days left the 1–2 monthly days next to nothing, or ₱0 (code
review, 2026-10-28). The deduction lines count only the monthly segments'
days and minutes. Contributions use the rate at the period end (the payslip
snapshot records it). A rate dated back over finalized payrolls doesn't
touch them: the Pay History tab lists payrolls whose snapshot rate differs
from the history's for their period. Why: a single current rate prorated
nothing, recomputing an old draft used today's rate, and the career-event
rates were readable by employees through RLS. The backfill dates a rate
edited directly (not on a career event) from the day after the last
finalized payroll paid at another rate, so drafts and the payrolls paid at
it keep it (it first used the migration day).

### least() and greatest() skip NULLs: coalesce an optional bound first (correction, 2026-10-28)

> `least(NULL, today)` is `today`, not NULL: an optional bound inside `least`/`greatest` silently becomes "no bound" in the wrong direction.

The pay-history backfill computed `least(paid.after_other, today)` where
no payroll paid at another rate gave NULL, so a corrected rate started on
the migration day instead of at the history's last change. Caught by
seeding four scenarios on a replay stopped before the migration.

### Output pay: how each contribution and benefit treats it (verified 2026-10-28)

> Basic (paid by results): BIR basic, 13th month counted, PhilHealth's monthly basic salary not below the minimum wage × days-per-year ÷ 12 and settled on the month's output. On top of the salary: BIR fees/commission/others (supplementary), PhilHealth unchanged, 13th month by client policy (default on). Both: SSS (all remuneration) and Pag-IBIG settled at the month's closing payroll.

Sources (web extraction, official hosts unreachable from the sandbox):
PhilHealth Circular 2018-0001 — MBS is the fixed basic rate without sales
commission, OT, allowances, 13th month, bonuses; workers paid by results
get not less than the minimum wage, monthly on 261 or 313 days ÷ 12 (also
the Supreme Court e-library copy). PD 851 Revised Guidelines — piece-rate
workers are covered, on total earnings; task-basis workers are not.
Philippine Duplicators v. NLRC (G.R. 110068, 1995 resolution) — sales
commissions integral to the pay are basic salary for the 13th month;
Boie-Takeda (G.R. 92174) excluded incentive-type "commissions": hence the
client policy, defaulting to counted. Pag-IBIG's IRR counts earnings
"fixed or ascertained on a time, task, piece or commission basis" (partial
scan only — the weakest source; owner flag). Omnibus Rules Book III Rule IV
Sec. 8(b): holiday pay of a worker paid by results ≥ average daily earnings
of the last 7 working days, never below the minimum wage — computed: the
rate's pay for the 7 days worked before it plus the outputs dated from the
first of them to its eve, less what the rate already pays for the holiday
(the service reads three weeks back, `outputsBefore` / `daysBefore`). Output
made on a worked holiday or rest day carries no premium: a warning asks
for an adjustment when one is due (not computed: outputs are dated when
accepted, not when made). Why it mattered: a 0-rate output worker had
no Pag-IBIG at all and PhilHealth on the ₱10,000 floor.

### EWT on consultants' fees: verified rules and the decisions behind them (verified 2026-10-28)

> `ewt_versions` 2018-05-01 (RR 2-98 Sec. 2.57.2 as amended by RR 11-2018 and RR 14-2018): individuals 5% (gross income for the year ≤ ₱3M, not VAT-registered, sworn declaration on file) else 10%; juridical 10% (≤ ₱720K with its declaration) else 15%. ATCs by kind of fee: licensed professionals WI010/WI011, WC010/WC011; management and technical consultants WI050/WI051, WC050/WC051.

Checked by two research agents with adversarial passes on the BIR digests
of RR 11-2018 and RR 14-2018 (bir-cdn), BIR Form 1601-EQ (January 2019
ENCS) and RMO 38-2018; nothing after RR 14-2018 changes the rates (RR
4-2024 timing, RR 5-2025, RR 24-2025 and RMO 46-2025 touch other items).
WI/WC157-161 are NOT fee codes (government payors, top withholding agents,
deposit interest) — a 2026 calculator site lists them wrongly. Decisions:
the base excludes VAT (RMC 72-2004); the higher rate applies from the
billing that takes the client's payments to the payee past the threshold
(the safe reading of an open question); a billing's month is when it
became payable or booked or invoiced, whichever first (RR 4-2024); dates on
weekends are noted, not moved (as on the filing calendar). Not handled:
the ₱250,000 one-payor exemption (RR 11-2018 Annex B-2, confirmed: a payee
paid under ₱250,000 for the year by one payor) — the year's total is only
known at year-end, over-withholding is creditable and under-withholding is
the payor's liability; the QAP DAT file
(the CSV feeds the BIR alphalist module; its layout is in RMC 15-2025's
annexes, unread). Owner flags: a CPA should read RR 11-2018 Sec. 2.57.2(A)
itself; RR 6-2026 (from Oct 16, 2026) makes the consultant's invoice show
the withheld tax on its own line; the payor's Annex C list of declarations
(by Jan 31) is medium-confidence. A client changes an EWT date in
`ewt_due_dates` (its own table: `filing_due_dates.filing` has a live CHECK
the MCP can't widen). A billing's tax is worked out only when
its fee or date changes or a declaration, VAT flag or kind of fee re-rates
the year's unpaid billings (`consultants.rerate` flag) — a payment or a
note never re-rates what was withheld (code review, 2026-10-28).

### NOT VALID doesn't grandfather a row: fix old rows in the migration (correction)

> Postgres re-checks a NOT VALID constraint on every UPDATE of a row, so an old row that breaks it fails any later update. Finalize and reopen update every employee row. Bring old rows into line in the same migration, then validate: C7 clears an old waiver that has no ID, and C4 turns an unnamed de minimis allowance into "Other taxable allowance".

Keep NOT VALID only where nothing updates the old rows (one-time items of
payrolls already computed). Count the live rows first. Why it mattered: one
old waiver would have blocked every payroll of its client.

### Legal values: `law.ts` for rules, `legal_parameters` for agency ceilings (confirmed approach, 2026-10-26)

> Every legal number the logic uses has a value, effective date and source: Labor Code and other fixed rules in `src/payroll/law.ts` (a test checks each entry), agency figures that change by issuance as versioned rows — `statutory_versions` (month-start dates) or `legal_parameters` (any start date, e.g. RR 29-2025 from 6 Jan 2026), read-only and frozen once used.

Why: the owner's rule "no legal numbers in logic"; `statutory_versions`
can't take a mid-month start or a new kind without DROPping its CHECKs.

A monthly de minimis ceiling counts the payroll month (`period_month`), the
same month a monthly allowance is split over. Semester and year ceilings
count by pay date (the tax year). A weekly payroll paid five days after the
cutoff pays five times in some calendar months, and counting by pay month
taxed a rice subsidy that was exactly at the ceiling.

### The owner's spec is the oracle when the official PDFs are unreachable

> From the cloud sandbox the BIR CDN, lawphil and PhilHealth hosts fail (proxy 403, DNS). Figures loaded from the owner's spec carry `verified_on` null and the report says so.

Where the spec was silent (de minimis excess over a ceiling) the safe
default was taken: taxed as supplementary pay. RR 2-98's last proviso of
Sec. 2.78.1(A)(3) may instead put such excess in the ₱90,000 pool — asked
the owner.

