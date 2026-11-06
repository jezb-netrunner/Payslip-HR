# Test data scripts

| File | What it does |
|---|---|
| `reset_client.sql` | Deletes one client and everything under it (employees and their logins, attendance, leave, loans, payroll runs and payslips, including posted ones, consultants, the client's audit rows). Global tables and admin accounts are untouched. Irreversible: test data only. |
| `demo_client.sql` | Creates the test client **DEMO, Demo Trading Corporation**. All names, TINs and government numbers are fictitious. |

Run either as the database owner, in one transaction (Supabase SQL editor or
MCP `execute_sql`). To rebuild the test client from scratch: `reset_client.sql`
with `'DEMO'`, then `demo_client.sql`.

## What the DEMO client contains

NCR, minimum wage ₱755 (WO NCR-28), semi-monthly default, 5-minute grace,
VAT-registered. Attendance runs 1 Oct to 5 Nov 2026 (weekly-paid staff from
28 Sep, the first week ending in October), with lates, overtime, undertime and
a few absences.

| No. | Employee | Pay | Scenario |
|---|---|---|---|
| 0001 | Maria Santos, HR & Admin Manager | ₱45,000/mo, semi-monthly | SSS loan, rice (de minimis) and transportation allowances, approved SL 27 Oct, half-day Saturday roster change 24 Oct |
| 0002 | Jose Reyes, Accountant | ₱30,000 → ₱32,000 from 21 Oct | mid-period raise (Pay History), HMO deduction, approved VL 8–9 Oct |
| 0003 | Ana Cruz, Sales Supervisor | ₱28,000/mo + commission | commission outputs 15 and 31 Oct, pending VL 12–13 Nov |
| 0004 | Pedro Garcia, Warehouse Staff | ₱755/day, MWE, Mon–Sat | Pag-IBIG loan, per-day meal allowance, works the 2 Nov special day, pending cash-advance request |
| 0005 | Liza Mendoza, Cashier | ₱800/day, weekly, probationary | Tue–Sun (works 1 Nov), **open entry 20 Oct with a pending correction request**, pending LWOP 10 Nov |
| 0006 | Ramon Villanueva, Security Guard | ₱755/day, MWE, weekly | night shift 22:00–06:00 (night differential), works his rest day 25 Oct, cash advance ₱4,000 repaid ₱1,000/week |
| 0007 | Carmela Bautista, Executive Assistant | ₱38,000/mo, fixed salary | no timekeeping: the monthly rate pays the period (her time entries are ignored) |
| 0008 | Daniel Flores, Production Worker | piece rate (output pay, basic) | daily output at ₱6.50/box |
| 0009 | Grace Torres, Marketing Associate | ₱25,000/mo | resigned 31 Oct: final pay |
| 0010 | Mark Aquino, IT Support | ₱30,000/mo, probationary | hired 12 Oct (prorated first payroll), previous employer Jan–Sep (2316) |

Also: five shift templates, VL/SL entitlements for regular staff, the NCR-only
16–18 Nov special days as client holidays, a consultant (Paolo Rivera, retainer
₱20,000/month, no billings yet), and a pinned announcement.

Not created (only the app can): employee login codes and client admins.

## Suggested walkthrough

1. **Requests:** approve Liza's time correction (20 Oct), approve or reject
   Pedro's cash advance, Ana's VL and Liza's LWOP.
2. **Weekly payrolls** (Liza, Ramon): 28 Sep–4 Oct, 5–11, 12–18, 19–25 Oct,
   26 Oct–1 Nov. Compute, review, finalize each, in order.
3. **Semi-monthly payrolls:** 1–15 Oct, then 16–31 Oct. Finalize both.
4. **Final pay** for Grace, then the **13th month** pay.
5. **Void and reissue** one finalized run, check the VOID payslip and the new
   control number.
6. **1–15 Nov:** add the missing time in/out from 6 Nov, compute (2 Nov
   special day: Pedro's and Ramon's premium, no pay for the office staff
   who didn't work).
7. **Consultant:** add Paolo's October invoice, check EWT.
8. **Reports and exports:** remittances, alphalist (Mark's previous
   employer), Time In/Out, Insights, Data Export, Audit Log.
9. **Employee view:** issue a login code (employee Login tab), sign in as
   the employee, file a leave and a correction.

Net pay the engine gave in the repo's payroll harness, before any request
was approved (a different figure in the app is worth a look; approving
Liza's correction changes her 19–25 Oct week):

| Run | Net pay |
|---|---|
| 1–15 Oct | Maria 21,707.28 · Jose 13,360.28 · Ana 16,024.19 · Pedro 9,956.56 · Carmela 17,435.90 · Daniel 9,957.34 · Grace 12,011.97 · Mark 4,256.32 |
| 16–31 Oct | Maria 19,433.14 · Jose 15,183.38 · Ana 16,265.71 · Pedro 10,623.47 · Carmela 17,435.90 · Daniel 9,808.16 · Grace 11,817.29 · Mark 15,524.86 |
| Weekly, Liza | 4,818.20 · 4,715.42 · 4,471.67 · 3,719.57 · 4,587.89 |
| Weekly, Ramon | 2,303.72 · 3,256.59 · 3,333.43 · 4,071.81 · 4,098.78 |

Payroll history starts in October, so without opening balances any
annualization (Grace's separation in 16–31 Oct, December's year-end run)
sees October onward only: Grace's 16–31 Oct payslip refunds just her 1–15
Oct withholding (₱281.47). To model the client's January–September payroll,
enter each employee's **opening balances** (employee → BIR tab → *Before
going live on the app*, last pay date 5 Oct 2026 for the 16–30 Sep payroll)
before computing October; annualization, the 13th month and the alphalist
then count the whole year. Grace at ₱25,000 a month leaving in October is
still under the ₱250,000 zero bracket for the year, so her separation still
refunds, but all of the year's withholding, not just 1–15 October's.
