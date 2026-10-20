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

---

## Current deployed state (update when it changes)

**Live ≠ repo since 2026-10-19.** The repo (branch
`claude/trusting-dirac-fqodu6`) is multi-client; the live backend and the
Pages site are still the single-company version. Ship all three together —
the old front end breaks on the new schema and vice versa:
1. apply `20261019120000_multi_client_schema.sql` then
   `20261019120100_multi_client_security.sql` (MCP `apply_migration` needs
   the owner to approve the destructive-statement prompt — see lesson; or
   paste them into the SQL editor). Precondition re-checked 2026-10-20: no
   employees / time entries / runs / payslips / leave rows exist, one
   profile (the owner, role `admin` → becomes `company_admin`). Afterwards
   rename the repo files to the versions `list_migrations` reports, run the
   security advisors;
2. deploy edge function `admin-users` v3 (verify_jwt on);
3. merge the branch to `main` (Pages deploys from `main` only).

Supabase project `ruuhpghcgccvezkjhisy` (ap-southeast-1), as of 2026-10-20:
- Applied: the first 9 migrations (latest `20260824001426`
  `run_lifecycle_and_admin_protection`). Statutory versions, 2026 holidays,
  leave types and company settings are seeded. The multi-client migration
  keeps statutory versions, turns the holidays into the national list and
  the leave types into global templates (copied into each new client), and
  drops `company_settings` — each client carries its own policy, including
  minimum-wage region/rate (no default; set per client).
- Edge function **`admin-users` v2** live (verify_jwt on); the repo copy is
  v3 and does NOT match until step 2 above.
- Private storage buckets `punch-selfies` and `employee-photos` exist; after
  the migration nothing uses `punch-selfies` (empty; safe to delete).
- **The owner's account exists** (created 2026-08-24, confirmed, role
  `admin`). Never create additional accounts except through the app.
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

Known-open items (deliberate scope cuts, also in README disclaimers):
unworked regular-holiday qualification simplified (pays unless on unpaid
leave that day); BIR DAT file not generated (CSV for the BIR Alphalist
module instead).

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
- **Labor standards**: OT +25% ordinary / day-rate ×1.30 otherwise
  (169/195/260/338%); ND +10% (22:00–06:00), stacks multiplicatively;
  premiums 130/150/200/260%; unworked regular holiday 100% (presence on the
  preceding workday condition); special days no-work-no-pay; 13th month =
  YTD basic ÷ 12, due Dec 24.
- **2026 holidays**: Proclamation 1006 (+1189 Eid'l Fitr Mar 20, +1264 Eid'l
  Adha May 27) — 12 regular, 8 special non-working, Feb 25 special *working*.
- **NCR minimum wage reference**: ₱755/day non-agri (WO NCR-27, eff. Jul 25,
  2026); it's an admin setting, not hardcoded.
- **De minimis** (RR 29-2025, eff. Jan 6, 2026): rice ₱2,500/mo, uniform
  ₱8,000/yr, laundry ₱400/mo, medical assistance ₱12,000/yr, gifts ₱6,000/yr,
  CBA+productivity ₱12,000/yr, OT meal 30% of regional minimum wage,
  monetized VL 12 days. The app treats de minimis as admin-flagged
  non-taxable allowances — ceilings are the admin's responsibility.

Re-verify on these triggers: every January (agency announcements, new BIR
RRs); wage orders per region (NCR 2nd tranche **₱780 on Jan 20, 2027** —
admin must update the setting); each ~Aug–Oct for next year's holiday
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

### Statutory tables are versioned data, not code (confirmed approach)

> Every legal rate lives in `statutory_versions` keyed by `(kind, effective_from)`; payroll loads the version in force for the period end, so a law change is an INSERT, never a deploy.

`getStatutoryTables(asOf)` picks, per kind, the newest row with
`effective_from <= asOf`. `src/payroll/defaults.ts` mirrors the seeds for
unit tests only — the DB is the runtime source of truth. Company admins add
versions in the Statutory page's structured editor (brackets/rates as form
fields, validated before save); entity admins read only. Numeric inputs are
edited as text and parsed on save — binding them as numbers swallowed
partial decimals like "0.0". Why it mattered:
SSS stepped up every ~2 years through 2025 and wage orders/holidays change
annually; an MSME admin must apply a new circular without a developer, and
past periods must recompute with the tables in force back then.

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
and will WARN — leave them; `revoke_user_sessions` is service-role only.

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

### Supabase MCP waits for a human on destructive SQL

> `apply_migration` / `execute_sql` hold any statement containing DROP (even inside a larger migration) for the user to confirm in their client; unattended, the call times out after ~60 s and nothing is applied.

Seen 2026-10-19 with the multi-client migrations (they drop the old policies,
punch RPCs and `company_settings`). Non-destructive DDL and reads go through
immediately. Verify nothing landed after a timeout (`list_migrations`,
`to_regclass`) — it is all-or-nothing. Plan for it: validate locally first
(next lesson), then apply while the owner is present to approve, or hand
them the files for the SQL editor. Why it mattered: a "hung" migration looks
like a broken database; it is just an unanswered prompt.

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
produce a negative net pay whenever the true-up is a refund. The alphalist
flags employees whose year is not reconciled ("Under/Over-withheld … —
annualize"). Why it mattered: BIR expects tax withheld = tax due per
employee on the alphalist; the previous build left this manual.

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
