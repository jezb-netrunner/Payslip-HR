# BIR RMO 9-2021 Annex B — how Payslip HR meets it

Annex B is the checklist of *Standard Functional and Technical Requirements*
filed with the registration of a computerized accounting system (CAS) or its
components. Payslip HR is a **payroll component**: it computes compensation,
withholding on compensation and on consultants' fees, and the reports and
certificates that follow from them. It issues no sales invoices and keeps no
books of accounts, so the sales, books and e-invoicing items are N/A.

Each row gives the answer for the form's **Complied / Remarks** columns.
"The client" is the employer (the taxpayer-applicant); the company running
Payslip HR is the system provider.

## Not applicable to a payroll system

| Annex B item | Remarks |
| --- | --- |
| System-generated receipts/invoices, their serial numbers, buyer details, VAT breakdown, SC/PWD details, bottom-portion phrases, copies | N/A — the system issues no receipts or invoices. |
| System-generated books of accounts (General Journal, General Ledger, Sales and Purchase Journals, Inventory Book) | N/A — payroll totals go to the client's accounting system or books. |
| Sending sales data to the BIR (EIS) | N/A — no sales transactions. |
| Adjustments to sales/revenue and their supplementary documents | N/A — no sales. Payroll corrections are voided and reissued (see audit trail). |
| BIR Form 2306 (final tax withheld) | N/A — the system withholds no final tax. |

## Report identification (printout and electronic copy)

Every report — PDFs, CSV and Excel exports, print sheets — starts (or ends,
on a printed page) with:

| Requirement | Complied | Remarks |
| --- | --- | --- |
| Taxpayer's registered name | ✓ | The client's registered name (Client Settings). |
| Registered address where the reports are generated | ✓ | The client's registered address. |
| "VAT REG TIN" / "NON-VAT REG TIN" with the 9-digit TIN and branch code | ✓ | From the client's TIN, branch code and **VAT registration** (Client Settings). Until the VAT status is set, reports print "TIN" alone — set it for every client. |
| Software name and version number | ✓ | "Payslip HR v1.0.0 (build …)": the release and the build it came from. |
| User name/ID of the one who generated the report | ✓ | The signed-in user's name and email. |
| Date and time stamp when the report was generated | ✓ | Philippine time. |

Agency import files (the BIR alphalist schedules, Annex F, the QAP of
consultants) keep the agency's exact format, so they carry no heading
rows; their generation is still on the audit trail.

## Electronic files

| Requirement | Complied | Remarks |
| --- | --- | --- |
| Saves reports in .csv or .dat (RR 16-2006) | ✓ | Every report downloads as CSV (payroll register, cash payout, time records, BIR reports, contributions, alphalists, management reports, audit log) and the records as Excel. The BIR Alphalist DAT file is produced by the BIR's own Alphalist Data Entry module from the CSV. |
| Database backup preserved for the mandatory period | ✓ | **Data Export** downloads a client's payroll records — payroll runs, payslips and every payslip line, employees, pay rates, adjustments, advances and loans, remittances, consultants and billings, voided payrolls, time in/out, leave and the audit log — as one Excel workbook, by year. The client keeps it on its own storage. The form cites ten years (RR 17-2013 as amended by RR 5-2014); RA 11976 (Ease of Paying Taxes) shortened the NIRC preservation period to five years (RR 7-2024). Keep each year's file at least that long; keeping ten matches the form. |

## Audit trail

| Requirement | Complied | Remarks |
| --- | --- | --- |
| Audit trail / activity log of all transactions and activities, printable | ✓ | **Audit Log**: every insert, change and delete of payroll and HR records (who, when, what changed), plus sign-ins, failed sign-ins, lockouts, password changes, sign-outs, reports printed and files exported, and voids with their reason. Filter by client, record type and dates; **Print**, or export to Excel or CSV. |
| The system controls the numbering | ✓ | Finalizing a payroll gives it the next payroll number (PR-000001) and its payslips the next payslip numbers (PS-000001), per client, six running digits, padded with zeros. Numbers are assigned only by the database, never typed, and never reused: a voided payroll keeps its numbers on record and the reissue gets new ones. |
| Posting date is the date it entered the system | ✓ | Finalization and every change carry the database's own timestamp. |
| A transaction can be voided, not modified, once posted | ✓ | A finalized payroll and its payslips can't be edited or deleted (database triggers). **Void and reissue** archives the posted version with the reason (it stays on record and prints marked VOID), restores the loan balances and cash-rounding carries it moved, and returns the run to draft; finalizing it again posts a new version under new numbers. |
| The run date is the date the report was generated | ✓ | The stamp on every report. |
| Users can't edit data within system-generated reports | ✓ | Reports are generated from the database each time, and posted payroll data can't be changed; downloaded files are copies. |
| Users can't override edits within the programs | ✓ | The rules are enforced by the database (constraints, triggers, row-level security), not only by the screens. |
| Each transaction stamped with the user ID of its author | ✓ | The audit trail records the user of every change. |
| Automatic totals and cross-check; reports an out-of-balance condition | ✓ | Finalize refuses a payroll whose payslip lines don't add up to each payslip's gross pay and deductions, whose net pay isn't gross less deductions plus the cash rounding, or whose totals differ from its payslips. The run page shows the **control totals** with their balance status; the payroll register CSV ends with a totals row. |

## Withholding tax certificates

| Requirement | Complied | Remarks |
| --- | --- | --- |
| BIR Form 2316 | Partly | The system computes every 2316 figure (BIR & Reports → 2316) and prints them per employee; the employer copies them onto the official form, signs, and gives it to the employee. A system-generated 2316 in the BIR's official layout (RMC 121-2019) needs the BIR's form template, which is to be added. No electronic signature. |
| BIR Form 2307 | Partly | Same for consultants: the quarter's 2307 figures per payee (Consultants → BIR (EWT)). |

## System security

| Requirement | Complied | Remarks |
| --- | --- | --- |
| Standard procedure and approval for user access | ✓ | Only a company admin creates admin accounts (Admin Users) and assigns each entity admin the clients they may handle; employees get a personal login code from their entity admin. Keep the written approval of each request. |
| Users can't be active on multiple terminals at once | ✓ | An admin account has one active session: signing in elsewhere signs the earlier session out, and the database stops answering it as an admin at once (a sign-in made outside the app's sign-in has no admin access at all). Employee logins only view their own payslips and file requests. |
| User IDs deactivated after unsuccessful sign-in attempts | ✓ | Five failed sign-ins in a row lock the account for 30 minutes; attempts are counted in the database one at a time, so a burst of them can't slip past the count. Passwords are kept at the Auth server only in a keyed form, so they can't be guessed around the lock either. A company admin can unlock an account sooner (Admin Users); unlocks and password resets are on the audit trail. |
| Password changed every 30 days | ✓ | A password older than 30 days must be changed at the next sign-in. A password set by another admin is temporary: it must be changed at the first sign-in. Policy: changed every 30 days; the new password must differ from the current one. |
| Passwords combine alphabetic and numeric characters | ✓ | Rule: at least 8 characters, letters and digits, not containing the email's name. Checked by the server. |
| Users other than administrators can't reach sensitive operating system commands | ✓ | It is a web application: no user has operating-system access. Database administration is only through the provider's console, by the account owner. |
| Users can reach accounting information only through authorized transactions | ✓ | Row-level security: each admin reaches only their clients; employees only their own records. |
| Access rights removed or revised on termination or transfer | ✓ | Deactivate the account or change its clients (Admin Users); a deactivated account's sessions end at once. |
| Audit trails protected from modification and destruction | ✓ | No user can write, change or delete audit entries; only the database's own triggers and functions add them. |
| Server rooms and data centers (locks, air-conditioning, power, fire, cabling, network points) | Provider | Hosted on Supabase (AWS, Singapore region): the physical controls are the provider's. Attach the provider's security or compliance report. |
| Dial-up access | N/A | None. |
| Remote access over the Internet encrypted | ✓ | HTTPS (TLS) only. |
| External network access through a monitored firewall | Provider | The provider's network controls. |
| Application access protected with authentication | ✓ | Every request needs a signed-in session. |
| Database record modification logged | ✓ | Database triggers log every change of the payroll and HR tables. |

## What the client still does

1. Set **VAT registration** in Client Settings for each client.
2. Download the **Data Export** workbook after each finalized payroll, or at
   least monthly, and keep it on the client's own storage.
3. Copy the 2316 and 2307 figures onto the official forms until the system
   generates them in the official layout.
4. Keep the written approvals of admin access requests.
