# Payslip HR — Quick Guide

## Signing in
- **Admins** (company admins and client payroll/HR staff): **Admin** tab → email + password.
- **Employees**: **Employee** tab → the login code from HR (e.g. `ACME-7Q4KX9TB`, dash included).
- First-ever setup: the first account created becomes the company admin.

## Company admin — one-time setup
1. **Clients** → add each client (name, code, TIN, RDO, pay policy).
2. **Admin Users** → create entity admins and assign them their clients.
3. **Holidays** / **Statutory Tables** → keep national holidays and tax/contribution tables current (add a new version when a law changes).

## Entity admin — pay cycle
Always pick the client first in the client selector at the top.

1. **Employees** → add employees (201 file, government IDs, pay rate, pay frequency, schedule) and generate each one's **login code**.
2. **Time In / Out** → key in attendance (daily sheet for the team, or per-employee for a period). **Fill** pre-loads scheduled days.
3. **Leaves** → approve/reject leave requests; **Time In / Out → Correction requests** → review employees' missing-time reports (red counts show what's pending).
4. **Pay Runs** → **New pay run** (frequency + period) → add adjustments if any → **Compute draft** → review → **Finalize**.
   Finalizing publishes payslips to employees and locks the period's attendance. **Reopen** if you need to fix something (audit-logged), then recompute and finalize again.
5. Download the payroll register or cash payout sheet from the run. For payslips, tick employees (or **Select all**) → **Download payslips** → one PDF to print, or a ZIP with one file per employee.
   Before finalizing, read the review warnings: a workday with no time in/out and no leave is charged as an absence.
6. **Cash Advances** → **Record advance** when you release one (or **Requests** → **Approve…** an employee's request): amount, deduction per payroll, release and first-deduction dates. Print the **agreement**, have the employee sign it, and tick *Signed by the employee on* — an advance can't be saved without it. Each finalized payroll deducts the installment (never more than the net pay); the payroll that includes a separation takes the rest. **Details** shows the history; record a **repayment** made outside payroll there, pause deductions, or change the installment.
7. **BIR & Reports** → 1601-C, 1604-C alphalist, 2316, SSS / PhilHealth / Pag-IBIG reports.
8. **Announcements** → post notices to employees.

## Employees
- **Dashboard** — latest take-home pay, deductions, leave balances.
- **Payslips** — view/download finalized payslips.
- **Attendance** — check records; **report a missing time entry** if something's wrong (HR fixes it).
- **Leaves** — file leave requests. Service Incentive Leave becomes available after 12 months of service (the date shows on the card).
- **Cash Advances** — request an advance (amount and how much to deduct per payroll), see what you owe, what the next payroll deducts, and every deduction so far. Advances carry no interest; you sign an authorization before the money is released.
- Lost your code? Ask HR for a new one.
