# Payslip HR — Quick Guide

## Signing in
- **Admins** (company admins and client payroll/HR staff): **Admin** tab → email + password.
- **Employees**: **Employee** tab → the login code from HR (e.g. `ACME-7Q4KX9TB`, dash included).
- First-ever setup: the first account created becomes the company admin.

## Company admin — one-time setup
1. **Clients** → add each client (name, code, TIN, RDO, pay policy).
2. **Admin Users** → create entity admins and assign them their clients.
3. **Holidays** → keep national holidays current. **Statutory Tables** shows the tax and contribution tables payroll uses, read-only: they ship with the software (verified against BIR, SSS, PhilHealth and Pag-IBIG issuances) and can't be typed in, so a wrong rate can't slip in. When the dashboard says this year's check is due, or you hear of a new circular, ask the system maintainer to confirm the tables.

## Entity admin — pay cycle
Always pick the client first in the client selector at the top.

1. **Employees** → add employees (201 file, government IDs, pay rate, pay frequency) and generate each one's **login code**. Set their regular schedule on the employee's **Schedule** tab (**Change schedule** → the shift for each weekday, from a date on).
   **Schedules** → **Shifts**: add the client's shifts once (e.g. Opening 6 AM–3 PM, Closing 2 PM–11 PM, Half day) — start, end, meal break (under 60 minutes counts as paid time), an optional flexible start, and *compressed workweek* for agreed long days (up to 12 hours, no overtime pay within the shift). **Weekly roster**: who works which shift each day; click a day to change just that date (swap a shift, move a rest day). Days already paid are locked; earlier days keep the schedule they had.
2. **Time In / Out** → key in attendance (daily sheet for the team, or per-employee for a period). **Fill** pre-loads scheduled days.
   The **Report** tab shows a period's attendance — totals per employee and each one's daily time record (DTR), with the hours, overtime, lateness and absences payroll will use — and **Download**s it as a PDF (to print and sign) or CSV. A pay run links to the report for its period.
3. **Leaves** → approve/reject leave requests; **Time In / Out → Correction requests** → review employees' missing-time reports (red counts show what's pending).
4. **Pay Runs** → **New pay run** (frequency + period) → add adjustments if any → **Compute draft** → review → **Finalize**.
   Under **Cash advances & loans this payroll**, the pencil sets what this payroll deducts for an advance or loan — the amount you agreed with the employee for this cutoff, or ₱0 to skip it — then recompute. The next payroll goes back to the usual installment.
   Finalizing publishes payslips to employees and locks the period's attendance. **Reopen** if you need to fix something (audit-logged), then recompute and finalize again.
5. Download the payroll register or cash payout sheet from the run. For payslips, tick employees (or **Select all**) → **Download payslips** → one PDF to print, or a ZIP with one file per employee.
   Before finalizing, read the review warnings: a workday with no time in/out and no leave is charged as an absence.
6. **Cash Advances** → **Record advance** when you release one (or **Requests** → **Approve…** an employee's request): amount, deduction per payroll — or **No fixed installment** when you agree on the amount each payroll (set it in each draft; nothing is deducted until you do) — release and first-deduction dates. Print the **agreement**, have the employee sign it, and tick *Signed by the employee on* — an advance can't be saved without it. Each finalized payroll deducts the installment (never more than the net pay); the payroll that includes a separation takes the rest (a paused advance shows up in that payroll's review warnings instead). **Details** shows the history; record a **repayment** made outside payroll there, pause deductions, or change the installment.
7. **BIR & Reports** → **Insights**: pick a report (payroll cost, overtime, attendance, headcount & turnover, leave, cash advances & loans, or a custom report of any payslip figures), the period, department and grouping; read **What stands out**, switch any chart to a table, and download **CSV** or **PDF**. The page link keeps the settings, so a report can be bookmarked or sent to a co-admin. The other tabs: 1601-C, 1604-C alphalist, 2316, SSS / PhilHealth / Pag-IBIG reports.
8. **Announcements** → post notices to employees.

## Fixing a mistake after payday
- **Not paid out yet** → open the run → **Reopen as draft** → fix it → recompute → finalize. A reopen doesn't recompute later payslips: if later payrolls of the same people are finalized, reopen those first (latest first) and finalize again oldest first.
- **Underpaid** (missed overtime, a day docked by mistake) → next pay run → **Add adjustment** → *Earning* with the matching classification (e.g. Overtime, Basic pay) and a label naming the period. It is taxed, and counts toward the 13th month, like the original pay.
- **Overpaid** → reopen the paid run and correct it so the taxable pay is right, then on the employee's **Pay** tab add a deduction (*Other*, amount per payroll, balance = the excess) — only with the employee's written consent. A one-time deduction alone would leave the excess in taxable pay.
- **Tax withheld wrong, pay right** → fix the cause (e.g. a wrong tax table version) for future payrolls. The year's last payroll with **Annualize** ticked (or the final pay) then withholds what is short or refunds what is over. **BIR & Reports → Alphalist** lists who is under- or over-withheld. If the *taxable amount* was wrong (an earning classified non-taxable, the minimum-wage flag), annualization can't see it: reopen and recompute the payrolls involved.
- **That month's 1601-C is already filed** → report the difference on a later 1601-C (adjustment of taxes withheld from previous months; record it under **1601-C remittances → Adjustment**) or amend the return. Interest and penalties may apply, so check with your accountant.

## Employees
- **Dashboard** — latest take-home pay, deductions, leave balances.
- **Payslips** — view/download finalized payslips.
- **Attendance** — check records; **report a missing time entry** if something's wrong (HR fixes it).
- **Leaves** — file leave requests. Service Incentive Leave becomes available after 12 months of service (the date shows on the card).
- **Cash Advances** — request an advance (amount and how much to deduct per payroll), see what you owe, what the next payroll deducts (or that the amount is agreed each payroll), and every deduction so far. Advances carry no interest; you sign an authorization before the money is released.
- Lost your code? Ask HR for a new one.
