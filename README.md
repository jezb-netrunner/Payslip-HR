# Payslip HR

An all-in-one **HR & Payroll (HCM) platform for Philippine MSMEs** — a
Paylocity-style unified system adapted to PH statutory rules, built as a
single-entity deployment on **Supabase** (Postgres + Auth + Storage + Edge
Functions) with a **React + TypeScript + Tailwind** front end.

## What it does

**Admin console**
- Employee 201-file management: personal data, government IDs (SSS,
  PhilHealth, Pag-IBIG, TIN), employment status, work schedules, bank details
- Career history timeline: hires, regularizations, promotions, salary
  adjustments, disciplinary actions, separations — with option to apply the
  event to the live record
- Live time & attendance monitoring: who's on the clock, flagged-punch review
  with selfie evidence, device/IP/location detail, manual entries (flagged +
  audit-logged), time-correction approvals
- Leave management: statutory leave types seeded (SIL, maternity RA 11210,
  paternity RA 8187, solo parent RA 11861, VAWC RA 9262, MCW RA 9710),
  approvals feed straight into payroll
- Payroll runs: draft → compute → review (with warnings) → finalize (immutable)
  → reopen (audited); semi-monthly or monthly; 13th-month, special, and
  final-pay run types; payroll register CSV export; payslip PDFs
- Statutory tables viewer/editor: versioned by effective date, with a live
  sample-salary calculator
- Insights dashboard: headcount & tenure, payroll cost trend (net / employee
  deductions / employer contributions), attendance rate, tardiness leaderboard,
  statutory remittance amounts with deadlines, minimum-wage compliance alerts,
  probation-ending reminders, 13th-month reminder, upcoming holidays
- Company settings: pay frequency, contribution timing, admin-set minimum wage,
  divisor, grace period, punch-security toggles — all audit-logged
- Full audit log of sensitive changes (database triggers)

**Employee portal**
- Time clock with verification selfie, device fingerprint, IP and optional
  geolocation — timestamps come from the server clock
- Own attendance records (read-only) + correction requests
- Leave balances and requests
- Own payslips (finalized only) with **PDF download**
- Own HR profile and career history

## Philippine statutory compliance (verified as of Aug 2026)

| Item | Basis | Implementation |
|---|---|---|
| Withholding tax | TRAIN (RA 10963), Annex E RR 11-2018, tables effective 1 Jan 2023 onward | Daily/weekly/semi-monthly/monthly bracket tables, versioned in DB |
| SSS | RA 11199, 15% (10% ER / 5% EE) since Jan 2025; MSC ₱5k–₱35k; MPF/WISP above ₱20k; EC ₱10/₱30 | MSC bracket mapping + MPF split + EC, versioned in DB |
| PhilHealth | RA 11223 (UHC), 5% of basic salary, floor ₱10k / ceiling ₱100k, 50/50 | Odd centavo carried by employer (official convention) |
| Pag-IBIG | RA 9679, HDMF Circular 460: max fund salary ₱10k; EE 1%/2%, ER 2% | Capped computation |
| 13th month | PD 851: 1/12 of YTD basic, due Dec 24; ₱90k tax-exempt cap | Dedicated run type, taxable-excess handling |
| OT / ND / premiums | Labor Code Arts. 86–94: OT +25%/×1.3, ND +10% (10pm–6am), rest 130%, special 130/150%, regular holiday 200/260% | Per-day engine with computation trace |
| Minimum wage | RA 6727 regional wage orders | Admin-configurable (seeded: NCR ₱755, WO NCR-27) with MWE tax exemption (RA 9504) |
| Holidays 2026 | Proclamations 1006 / 1189 / 1264 | Seeded, admin-editable |

Statutory tables live in the `statutory_versions` table **versioned by
effective date** — when a law changes, the admin adds a new version; payroll
runs automatically use the tables in force for their period. No code changes.

## Internal controls (anti-buddy-punching and beyond)

1. Employees **cannot write** to `time_entries` at all — punching happens only
   through `clock_in()` / `clock_out()` SECURITY DEFINER RPCs that derive the
   employee from the authenticated user (`auth.uid()`). Punching for someone
   else is impossible at the API level, not just in the UI.
2. Server-side timestamps (database clock) — client time is never trusted.
3. Mandatory verification **selfie** per punch (configurable), stored in a
   private bucket where each employee can only upload to their own folder and
   only admins can view all.
4. **Device fingerprint, IP address, geolocation** recorded per punch;
   anomalies auto-flagged (`new_device`, `device_mismatch`, `no_selfie`,
   `overlong_shift`) for admin review with selfie evidence.
5. One open entry per employee (DB constraint), corrections only via
   admin-approved requests, finalized payslips immutable (DB trigger),
   payroll-run deletions blocked, everything sensitive audit-logged by trigger.
6. Row Level Security everywhere: employees see only their own records;
   payslips only after finalization.

## Stack

- **Backend**: Supabase (project `ruuhpghcgccvezkjhisy`, ap-southeast-1) —
  Postgres 17, RLS, triggers, RPCs, Storage, `admin-users` edge function for
  account provisioning
- **Frontend**: Vite + React 19 + TypeScript + Tailwind CSS v4, React Router,
  Recharts (dashboard), jsPDF (payslip PDFs), Lucide icons
- **Tests**: Vitest — payroll engine covered with official computation vectors

## Getting started

```bash
npm install
cp .env.example .env   # already points at the Supabase project
npm run dev
```

1. Open the app → **“First time here? Create the admin account.”** The first
   account ever created becomes the administrator — do this immediately after
   deploying, then **disable public sign-ups** in the Supabase dashboard
   (Authentication → Sign In / Up) so the bootstrap can't be raced; all
   employee accounts are provisioned by the admin from inside the app.
2. Settings → fill in company identity, employer numbers, pay policy.
3. Employees → add employees → each employee's **Login Account** tab → create
   their login (they sign in and punch from their own account).
4. Payroll → New payroll run → Compute draft → review → Finalize.

```bash
npm test           # payroll engine unit tests
npm run build      # typecheck + production build
npm run lint       # oxlint
```

## Deploying to GitHub Pages

The app is a static SPA (Supabase is the backend), so GitHub Pages hosts it
directly. A workflow at `.github/workflows/deploy-pages.yml` builds and
deploys on every push to `main` (tests must pass first).

1. One-time: repo **Settings → Pages → Source: “GitHub Actions”** (the
   workflow also attempts to enable this automatically on first run).
2. Push to `main` (or run the workflow manually from the Actions tab).
3. The app goes live at `https://<your-username>.github.io/Payslip-HR/`.

How it works: the build passes `--base=/Payslip-HR/` so assets resolve under
the project path, React Router picks the same basename from
`import.meta.env.BASE_URL`, and `index.html` is copied to `404.html` so deep
links (e.g. `/admin/payroll`) survive refreshes — Pages has no SPA rewrites.
No secrets are needed in CI: the Supabase URL and anon key are public by
design (RLS protects all data).

Right after the first deploy, open the site, create the admin account, and
disable public sign-ups in Supabase (see Getting started).

### Database

The applied migrations are in `supabase/migrations/` (schema, RLS, RPCs,
storage policies, seeds, hardening) and the edge function source is in
`supabase/functions/admin-users/`. The live project already has all of them
applied.

## Repository map

```
src/
  payroll/        # the engine: statutory calcs, attendance, payslip math (+tests)
  pages/admin/    # admin console
  pages/employee/ # employee portal
  components/     # UI kit, camera capture, payslip view
  lib/            # supabase client, auth, api helpers, Manila-time utils
  pdf/            # payslip PDF generation
supabase/         # migrations + edge functions (source of truth for schema)
MEMORY.md         # running memory log: session history, deployed state, lessons
```

## Disclaimers & known simplifications

- Withholding is computed per period from the BIR tables; **year-end
  annualization/adjustment (BIR Form 2316 true-up) is not yet automated**.
- Unworked regular-holiday pay qualification (presence on the preceding
  workday) is simplified — the engine pays unless the employee is on unpaid
  leave; see the computation trace notes.
- De minimis ceilings are the admin's responsibility when flagging allowances
  as de minimis (current caps are listed in the UI, per RR 29-2025).
- This software assists with compliance but is not legal advice — always
  reconcile remittances with each agency's official schedules and forms.
