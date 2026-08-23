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
- Launched a 5-dimension adversarial code-review workflow (statutory math,
  attendance engine, service/data layer, security/RLS, React UI), each
  dimension's findings verified by a skeptic agent. **Results pending at the
  time of writing — fold confirmed findings and fixes into this log.**

**Found (the important discoveries are the Lessons below):** two from-memory
statutory values were wrong before research (NCR wage, PhilHealth centavo
split); two of my own test vectors were wrong, not the code (SSS EC tier);
nested React components caused remount bugs; RLS policies recursed until
refactored to security-definer helpers.

---

## Current deployed state (update when it changes)

Supabase project `ruuhpghcgccvezkjhisy` (ap-southeast-1):
- All migrations in `supabase/migrations/` are **applied** (verified via
  `list_migrations`; versions match filenames). Statutory versions, 2026
  holidays, leave types, and company settings (min wage ₱755, WO NCR-27) are
  **seeded**.
- Edge function **`admin-users` deployed** (verify_jwt on, v1); repo copy at
  `supabase/functions/admin-users/index.ts` matches.
- Private storage buckets `punch-selfies` and `employee-photos` exist.
- Security advisors clean except intentional WARNs on `clock_in`/`clock_out`/
  `review_time_correction` being callable by `authenticated` — that IS the
  punch API; do not "fix".
- **No auth users exist yet.** The first signup becomes the admin — never
  create throwaway accounts; that would steal the owner's admin bootstrap.

Known-open items (deliberate scope cuts, also in README disclaimers):
year-end tax annualization / BIR 2316 true-up not automated; unworked
regular-holiday qualification simplified (pays unless on unpaid leave that
day); mid-period hires/separations on monthly pay handled as absence
deductions (≈ proration); special/final-pay runs recompute their period like
a regular run (UI warns about overlapping finalized periods).

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
unit tests only — the DB is the runtime source of truth. Admins add versions
in the Statutory page by copying the current JSON shape. Why it mattered:
SSS stepped up every ~2 years through 2025 and wage orders/holidays change
annually; an MSME admin must apply a new circular without a developer, and
past periods must recompute with the tables in force back then.

### RLS policies that reference each other's tables recurse

> Payslips' employee policy checks the run's status while payroll_runs' policy checks for an own payslip — inline subqueries raise "infinite recursion detected in policy"; the fix is SECURITY DEFINER helper functions.

`run_is_finalized(uuid)`, `run_has_own_payslip(uuid)`, `is_admin()`,
`current_employee_id()` are security-definer (they bypass RLS on the tables
they read) and policies call them instead of inline subqueries. Rules that
came with it: always `set search_path = public` on definer functions; revoke
EXECUTE from `anon` on helpers but KEEP it for `authenticated` (policies
evaluate functions with the calling role's privileges — revoking
authenticated breaks every SELECT); trigger functions get EXECUTE revoked
from everyone (PostgREST exposes any executable function under /rpc).

### Anti-buddy-punching: enforce identity in the database, not the UI (confirmed approach)

> Employees have zero INSERT/UPDATE/DELETE on time_entries; the only way to punch is the `clock_in()`/`clock_out()` SECURITY DEFINER RPCs, which derive the employee from `auth.uid()` — punching for a teammate is impossible by construction.

Layers: server-derived identity (no employee_id parameter to spoof); DB-clock
timestamps; one open entry per employee (partial unique index); per-punch
evidence (selfie in private bucket where employees can only upload to their
own folder, device fingerprint = persistent localStorage UUID, IP from
request headers, optional geolocation); anomaly flags computed in the RPC
(`no_selfie`, `no_location`, `new_device`, `device_mismatch`,
`overlong_shift`) reviewed by admin with selfies side-by-side; immutable
entries — fixes only via admin-reviewed correction requests; audit triggers
on UPDATE/DELETE. Residual accepted risk: shared credentials + willing
accomplice selfie — mitigated by the evidence trail, not prevented.

### Manila time is fixed UTC+8 — but convert deliberately

> PH has no DST so attendance math uses fixed +8h arithmetic (`src/lib/manila.ts`); the trap is datetime-local inputs, which `new Date(value)` interprets in the *browser's* timezone — convert them as Manila wall time explicitly.

`work_date` is derived server-side in the RPCs
(`(now() at time zone settings.timezone)::date`). Form inputs
(`"2026-08-23T09:30"`) must become `new Date(value + ":00Z") − 8h` (see
`manilaLocalToIso` in MyAttendance.tsx and the manual-entry modal). ND
window 22:00–06:00 overlaps are computed per Manila date; ND minutes are
capped at net worked minutes so unpaid breaks don't earn ND. Why it
mattered: an admin filing from a non-PH browser would silently write shifted
timestamps — the classic way payroll hours drift by a day.

### Run Supabase security advisors after every DDL change

> `get_advisors(type=security)` caught real gaps after the initial migrations (mutable search_path; definer functions executable by anon via /rpc) — fixed in `harden_function_privileges`; re-run the advisors after any future DDL.

Checklist: pin `search_path` on every function; trigger functions →
`revoke execute from public, anon, authenticated` (triggers still fire — they
run as table owner); RLS helpers → revoke `anon` only; intentional RPCs
(`clock_in`/`clock_out`/`review_time_correction`) keep authenticated EXECUTE
by design and will always WARN — leave them.

### Employee logins: admin-users edge function + first-signup bootstrap

> Employee auth accounts can't be created from the browser with the anon key, so the `admin-users` edge function (service role) does it — and the first account ever created becomes admin via the `handle_new_user` trigger.

Actions: `create_employee_account` (creates auth user with
`app_metadata {role:'employee', employee_id}`, email pre-confirmed; DB
trigger creates the profile, function upserts the link as belt-and-braces),
`reset_password`, `set_active` (ban ~100y + `profiles.is_active`;
self-deactivation blocked). Client must send the **user's access token** as
the bearer, not the anon key (`callAdminUsers` in `src/lib/api.ts`). Edge
functions get SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env automatically —
no secrets in the repo. Why it mattered: the alternatives were shipping the
service key to the browser or letting employees self-signup — both
unacceptable.

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

### React: don't define components inside components

> Tab components defined inside a page component get a new function identity every parent render, so React unmounts/remounts them and their form state resets — hoist them to module scope.

Hit in `EmployeeDetail.tsx` (Profile/Career/Comp/Account tabs); fixed by
hoisting to top level with `useToast()` inside each. Why it mattered: forms
silently losing in-progress edits whenever the parent re-rendered.
