# Security and data protection

What personal data Payslip HR holds, how it is protected, what only the
owner can do, and what to do after a suspected breach. Have counsel review
the Data Privacy Act parts; this is a starting point, not legal advice.

## The personal data it holds

| Data | Where | Who can read it |
| --- | --- | --- |
| 201 file: name, birth date, gender, civil status, address, phone, email, emergency contact | `employees` | the client's admins; the employee (own record) |
| Government numbers (TIN, SSS, PhilHealth, Pag-IBIG), bank and account number | `employees`, payslip snapshots, alphalist and 2316 reports | same |
| Pay: rates and their history, payslips, loans, cash advances, opening balances | payroll tables | same |
| Attendance, schedules, leave, correction requests | attendance and leave tables | same |
| Consultants: TIN, address, fees, tax withheld | `consultants`, `consultant_billings` | the client's admins |
| Output reports (uploaded files) | storage bucket `output-reports` | the client's admins |
| Admin accounts: name, email | `profiles`, Supabase Auth | company admins |
| Audit trail: a full copy of each record before and after every change | `audit_logs` | the client's admins; company admins (global rows) |

Under the Data Privacy Act (RA 10173), government-issued numbers, age and
marital status are *sensitive* personal information. Exports (Excel, CSV,
PDF) leave the system: they are as sensitive as the database.

## How it is protected

- **Access rules in the database.** Row-level security on every table:
  admins reach only their clients, employees only their own records, and
  employees can never write attendance or payslips. Signed-out callers have
  no table privileges at all. 25 SQL suites test the rules on a replica of
  every migration (`supabase/tests/run.sh`); `fingerprint.sql` proves live
  runs the tested schema.
- **Admin sign-in** (`auth-guard`): 12+ character passwords screened against
  known breaches, five failures lock the account for 30 minutes, two-step
  sign-in (authenticator app) for every admin, one active session, and the
  database refuses admin access to any other session, one without the second
  factor, one 30 minutes idle or 12 hours old. Passwords are kept at the
  Auth server keyed with a server secret.
- **Employee sign-in** (`auth-guard`): the login code is mapped to its
  account with a server secret, so the account address in a session left on
  a shared computer says nothing about the code. Wrong codes count against
  the client: 50 within 15 minutes pause that client's employee sign-ins
  until the window ends, on the audit trail. Employee sessions follow the
  same 30-minute and 12-hour limits in the database.
- **The browser.** A Content-Security-Policy lets the page run only the
  app's own scripts and talk only to its Supabase project; fonts are served
  with the app. Printed reports escape every value.
- **Audit trail.** Database triggers record every change to the records
  above, every sign-in, failure, lockout, report, print and export; no app
  user can write or change it.
- **Platform.** Supabase encrypts the database at rest and all traffic uses
  TLS. Dependencies are audited (`npm audit`: none known) and Dependabot
  proposes updates; the deploy workflow's actions are pinned to commits.

## Only the owner can do these

1. **Backups.** The Free plan keeps no database backups. Upgrade to Pro
   (daily backups for 7 days, point-in-time recovery as an add-on), or take
   your own regularly: README → *Backups*.
2. **Protect `main`.** Every push to `main` deploys the live site. GitHub →
   Settings → Branches → add a rule for `main`: require a pull request and
   the deploy checks; limit who can push.
3. **Two-step sign-in on GitHub and Supabase.** Whoever controls those
   accounts controls the data. In Supabase, also enforce MFA for the
   organization and add a second owner, so a lost account can be recovered.
4. **AI tools on production.** Supabase advises against connecting its MCP
   server to production data. Use `read_only=true&project_ref=<ref>` for
   routine work and apply migrations yourself, or work on a separate project.
5. **A second phone for two-step sign-in** (account menu → Two-step
   sign-in): no one can reset the only company admin's authenticator.
6. **Dependabot alerts and security updates**: GitHub → Settings → Code
   security.
7. **Delete the unused storage buckets** `punch-selfies` and
   `employee-photos` (Supabase → Storage); nothing uses them.
8. **Keep the admin email private.** A public commit email names the admin
   account to anyone who wants to lock it out: use another address for the
   admin, or GitHub's "Keep my email address private".
9. **The repository is public.** The code holds no secrets, but MEMORY.md
   describes the live system. GitHub Pages on a private repository needs a
   paid GitHub plan; another host (Cloudflare Pages, Netlify) can also send
   real security headers. Moving hosts: set the edge-function secret
   `APP_ORIGINS` to the new site's origin and check the CSP in
   `vite.config.ts`.
10. **Data Privacy Act duties.** Running payroll for client companies makes
    you their personal information processor: a processing agreement with
    each client, a Data Protection Officer, a privacy notice for employees, a
    retention schedule, and registration with the National Privacy
    Commission once you process sensitive personal information of 1,000 or
    more people or employ 250 or more (NPC Circular 2022-04).

## After a suspected breach

1. **Contain.** Deactivate the accounts involved (Admin Users; an
   employee's Login tab, or set a new code, which signs them out
   everywhere). If the whole system may be compromised, sign everyone out
   at once in the Supabase SQL editor:
   `delete from public.admin_session_activity; delete from auth.sessions;`
   (the database stops answering every admin and employee session at once;
   everyone signs in again). Change your own password and check Admin Users
   for accounts you don't know. Replace the `ADMIN_PASSWORD_PEPPER` secret
   only as a last resort: every admin password and employee login code
   stops working with it.
2. **Keep the evidence.** Export the audit log (Audit Log → Excel) and the
   Supabase Auth and API logs at once: the Free plan keeps logs briefly.
3. **Assess.** Which records, how many people, which clients, since when.
4. **Notify.** As the processor, tell each affected client at once. The
   client (the controller) must notify the National Privacy Commission and
   the affected people within 72 hours of knowing, when sensitive personal
   information was likely acquired by someone unauthorized and could cause
   them serious harm (NPC Circular 16-03). Involve counsel early.
5. **Fix and record** what happened, what was done and when, in the MEMORY
   log and the client's incident file.

## Retention

Nothing is purged automatically: payslips, attendance and the audit trail
(with its full copies of changed records, government numbers included) stay
until deleted. Payroll records must be kept for the BIR and labor-law
periods; agree a retention period with counsel and clients, then remove
what is past it.
