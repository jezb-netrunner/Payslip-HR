# Payslip HR

A **multi-client HR & Payroll platform for the Philippines**: one payroll
service company (the *company*) runs HR, timekeeping, payroll and BIR
reporting for many client employers (*clients*), on **Supabase** (Postgres +
Auth + Edge Functions) with a **React + TypeScript + Tailwind** front end.

**New here?** See the [Quick Guide](docs/USER_GUIDE.md).

## Who uses it

| Role | Signs in with | Can do |
|---|---|---|
| **Company admin** | email + password | Everything, across all clients: add/archive clients, create and assign admin users, update statutory tables and national holidays |
| **Entity admin** (client payroll staff / heads) | email + password | Full HR & payroll for the clients assigned to them — nothing else |
| **Employee** | a **login code** set by their entity admin (e.g. `ACME-7Q4KX9TB`) | Own dashboard, payslips, attendance, leaves, announcements, profile |

Login codes are prefixed with the client code, can be changed or disabled by
the entity admin at any time (signing the employee out everywhere), and are
never stored — only their last characters are kept as a hint. Guessable
codes (all digits, runs, too few different characters, the employee number)
are refused; the Generate button makes random ones.

## What it does

**Company admin**
- Clients: registered name, client code, TIN + branch code, RDO, address,
  withholding-agent category, top-withholding-agent flag, pay policy defaults
- Admin users: create entity/company admins, assign clients, deactivate
- Statutory tables (read-only): the WHT, SSS, PhilHealth, Pag-IBIG and BIR
  annual tables in force and every past version, each with its legal basis,
  source and the date it was last verified; a quick contribution check for
  a sample salary; a yearly-check reminder on the dashboard; the pay codes
  and how each is taxed
- National holidays (clients add their own local holidays)
- Dashboard across all clients

**Entity admin (per selected client)**
- Employee 201 file: personal data, TIN / SSS / PhilHealth / Pag-IBIG,
  nationality and ZIP (for the alphalist), **hire date and separation date with
  reason** (resignation, termination, retirement, end of contract, death…),
  career history, pay frequency, pay type, payment method (cash / bank /
  e-wallet / check), allowances with a pay code (how each is taxed, and
  whether it is regular or supplementary compensation), recurring deductions
  and loans, union dues, previous-employer and PERA data per tax year
- **Schedules**: client shift templates (start, end, meal break, flexible
  start, compressed-workweek days of up to 12 hours — DOLE Department
  Advisory 02-04); each employee's weekly pattern is set *from a date on*
  (earlier days, and anything already paid, keep the schedule they had);
  a weekly roster changes single dates (a swapped shift, a moved rest day)
  and warns when a week has no rest day (Labor Code Art. 91). Payroll
  measures lateness, undertime, overtime and absences against each date's
  own shift; a meal break under 60 minutes is paid time
- **Time In / Out**: daily sheet (whole team, one day) and per-employee sheet
  (one person, a whole period) — admins key in time in/out (or fill the
  scheduled days from each employee's shift; Fill skips approved leaves and
  non-working holidays), split shifts as extra in/out pairs, with rest days,
  holidays and approved leaves shown; employees can only *request*
  corrections. Attendance is locked once it has been paid in a finalized run.
  A **Report** tab gives any period's totals per employee and each one's
  daily time record (DTR), computed as payroll computes them, as PDF (with
  signature lines) or CSV
- Leaves: per-client leave types (seeded from statutory templates),
  per-employee credits, approvals that feed payroll, leaves filed by HR for
  an employee, and revoking an approved leave (until its days are paid).
  A leave type can require months of service: **Service Incentive Leave opens
  after 12 months** (Labor Code Art. 95), enforced by the database; credits
  set for a year grant it sooner
- Payroll runs per **pay frequency** (weekly / semi-monthly / monthly) with
  regular, 13th-month, special and final-pay run types; adjustments
  (bonuses, deductions, back pay); review → finalize (immutable) → reopen
  (audited); payroll register CSV; payslip PDFs for one employee or in
  **bulk** (ticked employees or everyone: one PDF, a payslip per page, or a
  ZIP of single PDFs); **cash payout sheet** with bill/coin breakdown per
  employee and per run. Computing warns, per employee, about scheduled
  workdays with no time in/out or leave (charged as absences). A draft can
  set what it deducts for any cash advance or loan — the amount agreed for
  that cutoff, or ₱0 to skip it — and the next payroll goes back to the usual
  installment
- **Cash Advances** ("bale"): record an advance when it is released, or
  approve an employee's request (a fixed installment, or **no fixed
  installment**: each payroll deducts what is set for it), with the date the employee signed the
  written authorization to deduct it (a printable agreement is built in;
  Labor Code Art. 113 and its IRR as amended by DOLE D.O. 195-2018). Advances
  are interest-free; each payroll deducts the agreed installment after tax,
  never more than the net pay (what it can't take stays in the balance), and
  the payroll that includes the employee's separation, or their final pay,
  takes the remaining balance (a paused advance is flagged in its review
  warnings instead). Repayments made outside payroll, pausing
  deductions, and a per-advance ledger (release → payroll deductions →
  repayments → balance) are tracked; the database only lets the balance move
  through a finalized payroll or a recorded repayment
- **Announcements** (pinned / expiring) shown on the employee portal
- **BIR & Reports**: **Insights** — management reports from the app's own
  records: payroll cost (what moved it, employer contributions, the 13th
  month accruing), overtime (who, how routine, its full-time equivalent),
  attendance (absence and late rates, weekday patterns, perfect
  attendance), headcount and turnover (why people left, probation
  deadlines, pay below the minimum wage setting), leave (and the cash value
  of unused SIL), cash advances and loans (ageing, exposure, stalled
  deductions) and a custom report of any payslip figures by month,
  department, position, employee or pay type; each with key figures,
  plain-language findings, charts with a table view, CSV and PDF, and its
  settings in the link. Then the BIR side: 1604-C alphalist Schedule 1 and
  Schedule 2 (MWEs), BIR 2316 working copies, 1604-C summary, 1601-C monthly
  remittance log, SSS / PhilHealth / Pag-IBIG contribution reports
- Client settings, audit log

**Employee portal**
- Dashboard: latest take-home pay and where the gross went (SSS, PhilHealth,
  Pag-IBIG, tax, other deductions, cash rounding), year-to-date totals, days
  and hours on record this month, leave balances, announcements
- Payslips (finalized only) with PDF download, attendance records +
  correction requests, leave requests, cash advance requests with each
  advance's balance and repayment history, profile (the login code is their only
  credential — a lost code is replaced by the entity admin)

## Pay frequency and periods

Each employee has their own pay frequency, so a client can pay some staff
weekly and others semi-monthly or monthly. Each run covers one client and one
frequency and is tied to a **payroll month slot** taken from the period's
cutoff (e.g. "October 2026, payroll 2 of 2", or "payroll 5 of 5" for weekly),
so moving a payday for a holiday never breaks a month. Monthly amounts —
allowances, recurring deductions, SSS / PhilHealth / Pag-IBIG — are split
across the month's periods so the parts always add up to the monthly
figure, or deducted on the first or last period only (client setting); an
employee hired or separated mid-month still has the month's contributions
completed on their own first or last payroll. Withholding tax uses the BIR
table for the run's frequency, and the tax year follows the **pay date**
(a December 16–31 payroll paid in January is next year's compensation).

Safety rules enforced by the database: a draft can only be finalized if it
was fully computed after its latest input change (attendance, leave,
adjustments, rates or client settings); nobody is paid twice for the same
days; finalized payrolls are frozen until reopened.

## Cash payroll without centavos

For cash-paid staff (or everyone, per client setting) net pay can be paid in
whole pesos:

- **Round up** — the employer adds the centavos (e.g. ₱4,321.40 → ₱4,322).
- **Carry forward** — pay ₱4,321 now; the ₱0.40 is owed to the employee,
  added to the next payout and settled in full on final pay.

There is deliberately **no round-down** option: withholding any part of a
worker's wage is prohibited (Labor Code Art. 113). The rounding is shown as
its own payslip line so the payslip still ties out to the centavo, and the
payout sheet gives the bills and coins to prepare.

## BIR 1604-C and the Alphalist of Employees

The app captures everything the annual information return needs:

- Client: TIN + branch code, RDO, registered name and address, ZIP,
  withholding-agent category, top withholding agent, contact details
- Employee: TIN, name, birth date, nationality, address + ZIP, employment
  status (regular / casual / contractual / probationary / seasonal…),
  inclusive dates of employment, reason of separation, previous employer
  (TIN, name, compensation and tax withheld), PERA tax credit, substituted
  filing
- Every earning carries its BIR classification (basic, holiday, overtime,
  night differential, hazard, 13th month & other benefits, de minimis,
  representation, transportation, COLA, housing, other regular /
  supplementary) so the 2316 / alphalist columns are summed, not guessed.
  Minimum wage earners' exempt package (basic, holiday, OT, ND, hazard) is
  kept separate, the ₱90,000 13th-month/other-benefits exemption is tracked
  across the tax year (a bonus beyond what is left of it is taxed with the
  payroll that pays it), and an **annualizing run** (the last payroll paid
  in December, a payroll that includes an employee's separation, or final
  pay) trues up the year's tax
- 1601-C remittances (date, bank/agency, TRA/eROR/eAR, amounts) for the
  1604-C remittance schedule

Reports export as CSV, one per schedule, and flag employees whose data is
incomplete or whose tax is not yet reconciled (while the year is still in
progress, withholding differences are shown as a note — they settle on the
last payroll paid in December or on final pay). Schedule 2 takes the
statutory minimum wage from the employee's last payslip of the year, and the
previous-employer section carries TIN, status, period, reason of separation
and itemized amounts. They are the working data you
key or import into the **BIR Alphalist Data Entry and Validation Module**,
which produces the DAT file to submit; the return itself is filed through
eBIRForms / eFPS.

## Philippine statutory compliance (verified Aug 2026, reviewed Oct 24, 2026)

| Item | Basis | Implementation |
|---|---|---|
| Withholding tax | TRAIN (RA 10963), Annex E RR 11-2018, tables effective 1 Jan 2023 onward; RR 2-98 Sec. 2.79(B) as amended by RR 11-2018 (regular and cumulative average methods) | Daily / weekly / semi-monthly / monthly tables + annual table for annualization, versioned in DB. Taxable pay is split by pay code into regular (R) and supplementary (S) compensation; the table row comes from R alone, and the cumulative average method applies from a trigger (S paid while R is in the 0% row, S at least R, or a previous employer this year) to the end of the year |
| SSS | RA 11199, 15% (10% ER / 5% EE) since Jan 2025; MSC ₱5k–₱35k; MySSS Pension Booster (MPF) above ₱20k; EC ₱10/₱30; MSC on the month's actual compensation (Sec. 8(f)); SSS IRR Rule 12 Sec. 6 (bonuses except the Christmas bonus; transportation, board and lodging unless liquidated) | Earlier payrolls of a month deduct a provisional share on the rate; the month's closing payroll settles it on everything the month paid, by each pay code's SSS setting (OT, allowances, bonuses other than the Christmas bonus), refunding any over-deduction. 13th month pay, de minimis, other non-taxable pay and the advanced SSS maternity benefit are company-admin settings (out by default) until the law is confirmed |
| PhilHealth | RA 11223 (UHC), 5% of basic salary, floor ₱10k / ceiling ₱100k, 50/50; employee share paid by the government for PWDs (RA 11228) and solo parents (RA 11861, Circular 2026-0015) | Odd centavo carried by employer (official convention); waiver per employee with dates |
| Pag-IBIG | RA 9679, HDMF Circular 460: max fund salary ₱10k; EE 1%/2%, ER 2% | On basic salary plus allowances, capped |
| 13th month | PD 851: 1/12 of basic earned in the year, due Dec 24; ₱90k exemption cap | Dedicated run type; cap tracked across the tax year; the excess taxed when paid |
| OT / ND / premiums / holiday pay | Labor Code Arts. 86–94; IRR Book III Rule IV Secs. 6, 10 | Per-day engine with computation trace; an unworked regular holiday is paid after work or paid leave on the workday before it |
| Hours of work & schedules | Art. 83 (8 hours), Art. 85 + IRR Book III Rule I §7 (meal ≥ 60 min unpaid; shorter meals and rests ≤ 20 min are hours worked), Art. 91 (weekly rest day), DOLE DA 02-04 (compressed workweek) | Each date measured against its own shift; compressed days regular up to the shift (max 12 h; ≤ 5 days and 48 h a week) |
| Leaves | Art. 95 (SIL after 12 months), RA 11861 (solo parent, 6 months), RA 9710 (women, 6 months), RA 11210 (maternity 105 calendar days), RA 8187, RA 9262 | Service requirements enforced; maternity paid as the SSS benefit + salary differential (tax-exempt, RMC 105-2019), not as salary |
| Deductions | Art. 113, IRR Book III Rule VIII §10 (DO 195-18) | Company loans, HMO and other deductions need the employee's written authorization date |
| Minimum wage | RA 6727 regional wage orders (e.g. NCR-28, ₱755 from Sep 26, 2026); MWE exemption RA 9504; apprentices/learners 75% (Arts. 61, 73) | Per-client wage region and rate; MWE exempt package; payslip warnings when a rate is below the floor or an MWE is paid above the minimum |
| Holidays | 2026: Proclamations 1006 / 1189 / 1264; 2027: Proclamation 1427 | National list + per-client local holidays |

Statutory tables live in `statutory_versions`, **versioned by effective
date**: payroll uses the version in force for each period (contributions)
or pay date (withholding). As in commercial payroll software, the tables
**ship with the software** rather than being typed in by users — see
*Updating the statutory tables* below.

### Updating the statutory tables (maintainers)

The app's users can only read the tables; the database refuses writes from
every API role. A change in the law ships as a migration:

1. Confirm the change in the agency's own issuance (BIR revenue regulation,
   SSS / PhilHealth / Pag-IBIG circular) and one more independent source;
   note the effective date. SSS, PhilHealth and Pag-IBIG versions start on
   the first of a month (they follow the payroll month); BIR tables and the
   de minimis ceilings (`kind = 'de_minimis'`) may start on any date (they
   follow the pay date — RR 29-2025 applies from 2026-01-07).
2. Add a migration inserting the new version with `kind`,
   `effective_from`, `description`, `legal_basis`, `source_url` (https) and
   `verified_on`. The database checks the figures (rates in range, MSC
   steps, tax brackets ascending with each base following from the one
   before) and refuses a malformed version.
3. Mirror it in `src/payroll/defaults.ts`, add test vectors from the
   agency's own examples, and run `npm test` and `supabase/tests/run.sh`.
4. Apply the migration, run the Supabase security advisors, and record the
   change in MEMORY.md (*Verified 2026 PH statutory figures*).

**Pay codes** ship the same way: what each allowance and one-time earning
is (`pay_codes`: BIR bucket, regular or supplementary, tax rule) is a
migration, mirrored in `src/payroll/payCodes.ts` and checked by
`supabase/tests/18_pay_codes_tests.sql`. Rows saved with only a category get
that category's code (`default_pay_code`).

Versions that finalized payrolls may have used are frozen. Only a published
mistake is corrected in place, deliberately: the correcting migration runs
`set local statutory.correction = 'on'`, and the affected payrolls are
reopened and recomputed. Re-check every table each January (the dashboard
reminds company admins when this year's check is due).

## Internal controls

1. Employees have **no write access** to time entries, payroll runs or
   payslips — not just in the UI but in the database (row-level security).
   Time is entered by admins; employees can only file correction and leave
   requests.
2. Entity admins can only reach the clients assigned to them; everything is
   scoped by client in the database, and archiving a client locks its entity
   admins out.
3. Finalized payslips are immutable; attendance already paid is locked;
   finalize / reopen run as atomic database functions that also maintain the
   cash-rounding carry balance.
4. Sensitive changes are audit-logged by database triggers (who, when, what,
   which client) — including login-code changes made through the edge
   function and leave / correction reviews; bookkeeping writes (draft
   totals, payroll sequence) are skipped. CSV exports neutralize
   formula-like text so a typed name can't run as a spreadsheet formula.
5. Employee login codes are client-prefixed (no cross-client guessing),
   high-entropy, revocable, and never stored in readable form.

## Stack

- **Backend**: Supabase (project `ruuhpghcgccvezkjhisy`, ap-southeast-1) —
  Postgres 17, RLS, triggers, RPCs, `admin-users` edge function for login
  codes and admin accounts
- **Frontend**: Vite + React 19 + TypeScript + Tailwind CSS v4, React Router,
  Recharts, jsPDF, Lucide icons
- **Tests**: Vitest — payroll engine, frequencies, annualization, alphalist,
  cash rounding, login codes, CSV safety, and end-to-end `computeRun` flows
  against an in-memory Supabase (`src/payroll/flows/`); SQL suites for RLS,
  RPCs and triggers (`supabase/tests/`)

## Getting started

```bash
npm install
cp .env.example .env   # already points at the Supabase project
npm run dev
```

1. Open the app → **“First time here? Create the admin account.”** The first
   account ever created becomes a company admin — do this immediately after
   deploying, then **disable public sign-ups** in the Supabase dashboard
   (Authentication → Sign In / Up) so the bootstrap can't be raced.
2. **Clients** → add a client (its code becomes the prefix of its employees'
   login codes), fill in its BIR details and pay policy.
3. **Admin Users** → create entity admins and assign their clients.
4. **Employees** → add employees → each employee's **Login** tab → set their
   login code and hand it to them.
5. **Time In / Out** → enter attendance → **Payroll** → new run → compute →
   review → finalize.

```bash
npm test           # unit tests
npm run build      # typecheck + production build
npm run lint       # oxlint
```

## Deploying to GitHub Pages

The app is a static SPA (Supabase is the backend), so GitHub Pages hosts it.
`.github/workflows/deploy-pages.yml` builds and deploys on every push to
`main` (tests must pass first).

1. One-time: repo **Settings → Pages → Source: “GitHub Actions”**.
2. Push to `main` (or run the workflow manually from the Actions tab).
3. The app goes live at `https://<your-username>.github.io/Payslip-HR/`.

The build passes `--base=/Payslip-HR/`, React Router takes the same basename
from `import.meta.env.BASE_URL`, and `index.html` is copied to `404.html` so
deep links survive refreshes. No secrets are needed in CI: the Supabase URL
and anon key are public by design (RLS protects all data).

### Database

Migrations are in `supabase/migrations/` and the edge function source is in
`supabase/functions/admin-users/`. The front end, the migrations and the edge
function must be deployed **together**: the multi-client migrations
(`*_multi_client_schema.sql`, `*_multi_client_security.sql`) replace the
single-company schema, so an older front end stops working once they are
applied, and this front end needs them. Apply the migrations, deploy the edge
function, then merge to `main`. See `MEMORY.md` → *Current deployed state* for
what is live.

## Repository map

```
src/
  payroll/        # engine, statutory calcs, attendance, annual tax / 2316, alphalist (+tests)
  pages/admin/    # admin console (company + entity admins)
  pages/employee/ # employee portal
  components/     # UI kit, shell, payslip view
  lib/            # supabase client, auth, client context, login codes, pay periods,
                  # cash denominations, Manila-time utils, labels, schedules,
                  # management reports (insights.ts: pure aggregations + tests)
  pdf/            # payslip PDFs, cash advance agreement, time and insight reports
supabase/         # migrations + edge functions (source of truth for schema)
MEMORY.md         # running memory log: session history, deployed state, lessons
```

## Disclaimers & known simplifications

- The BIR reports are working data for the BIR Alphalist module and
  eBIRForms; the app does not generate the DAT file or file returns.
- The SSS maternity benefit and the salary differential are entered as
  adjustments (the SSS figure comes from the SSS portal); payroll only stops
  paying the leave days as salary and reminds you. Until the BIR's copy of
  RMC 105-2019 is confirmed, the differential is taxed as supplementary
  compensation by default (a company-admin setting on the Statutory Tables
  page can make it exempt); a client without a DOLE exemption for the year
  can't finalize a payroll that covers maternity leave without it.
- Whether a minimum wage earner's rest-day and special-day premiums are
  tax-exempt like holiday pay is not settled in the sources checked; the app
  treats them as exempt — confirm with your accountant.
- De minimis ceilings are on file as a statutory table (RR 29-2025, pay
  dated 2026-01-07 and later; Statutory Tables page), but payroll doesn't
  apply them yet: classifying allowances as de minimis within the ceilings
  stays the admin's responsibility until the per-item tracking (payroll tax
  rules spec, T7) is built.
- The cumulative average method follows the payroll tax rules spec; where
  it is silent the app reads it this way: a payroll with no pay at all is
  not "S at least R"; a 13th-month payslip (no regular pay of its own) does
  not count as the 0% row; periods are counted by pay date from the first
  pay of the year (a previous employer's start date, or January 1 when it
  isn't on file); payrolls paid before the rule count for the triggers with
  their regular and supplementary pay as they were taxed.
- This software assists with compliance but is not legal advice — always
  reconcile remittances with each agency's official schedules and forms.
