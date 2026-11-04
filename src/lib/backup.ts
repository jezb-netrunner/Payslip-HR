// The client's payroll records as one Excel workbook, to keep on the
// client's own storage (BIR RMO 9-2021 Annex B, item 7: backups the taxpayer
// keeps; RA 11976 and RR 7-2024: records kept five years). Every sheet
// starts with the report identification. Pure: the Data export page fetches
// the records, this lays them out.

import type {
  AdvanceRepayment,
  AuditLog,
  Consultant,
  ConsultantBilling,
  Employee,
  EmployeePayRate,
  LeaveRequest,
  Payslip,
  PayrollAdjustment,
  PayrollRun,
  PayrollVoid,
  RecurringDeduction,
  TaxRemittance,
  TimeEntry,
} from './db'
import { manilaDateStr, manilaHHMM } from './manila'
import { stampRows, type ReportStamp } from './reportStamp'
import type { XlsxCell, XlsxColumn, XlsxSheet } from './xlsx'

export interface BackupData {
  /** "2026", or "all years" */
  period: string
  runs: PayrollRun[]
  payslips: Payslip[]
  employees: Employee[]
  payRates: EmployeePayRate[]
  adjustments: PayrollAdjustment[]
  /** cash advances and loans (recurring deductions with a total) */
  deductions: RecurringDeduction[]
  repayments: AdvanceRepayment[]
  remittances: TaxRemittance[]
  consultants: Consultant[]
  billings: ConsultantBilling[]
  voids: PayrollVoid[]
  timeEntries: TimeEntry[]
  leaves: (LeaveRequest & { leave_types?: { name: string } | null })[]
  audit: AuditLog[]
}

const RUN_TYPES: Record<string, string> = {
  regular: 'Regular',
  thirteenth_month: '13th month',
  special: 'Special',
  final_pay: 'Final pay',
}

/** "2026-10-29 09:15" in Philippine time. */
export function manilaDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  return `${manilaDateStr(new Date(iso))} ${manilaHHMM(iso)}`
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))
const col = (header: string, format?: XlsxColumn['format'], width?: number): XlsxColumn => ({ header, format, width })
const money = (header: string) => col(header, 'money', Math.max(12, header.length + 2))

/** What the sheets list, in order: name, what it holds. */
export const BACKUP_SHEETS: [string, string][] = [
  ['Payroll runs', 'Every payroll of the period: control number, dates, status and totals'],
  ['Payslips', 'Every payslip: attendance, pay, contributions, tax and net pay'],
  ['Payslip lines', 'Each earning and deduction line of every payslip'],
  ['Employees', 'The employee master file, government numbers and pay settings'],
  ['Pay rates', 'The dated pay-rate history'],
  ['Adjustments', 'One-time earnings and deductions of the payrolls'],
  ['Advances and loans', 'Cash advances and loans deducted from pay, with their balances'],
  ['Repayments', 'Advances repaid outside payroll'],
  ['BIR remittances', 'Withholding tax remitted (BIR 1601-C)'],
  ['Consultants', 'Independent consultants (payees of professional fees)'],
  ['Consultant billings', 'Professional fees billed and the expanded withholding tax'],
  ['Voided payrolls', 'Posted payrolls voided and reissued, with the reason'],
  ['Voided payslips', 'The payslips of the voided payrolls, as posted'],
  ['Time in-out', 'Time in and time out entered for each workday'],
  ['Leave', 'Leave filed and its approval'],
  ['Audit log', 'Changes, sign-ins, reports and exports on the audit trail'],
]

function person(e: { employee_no?: string; last_name?: string; first_name?: string; middle_name?: string | null } | undefined): [string, string] {
  if (!e) return ['', '']
  return [e.employee_no ?? '', [e.last_name, [e.first_name, e.middle_name].filter(Boolean).join(' ')].filter(Boolean).join(', ')]
}

function changed(r: AuditLog): string {
  const n = (r.new_data ?? {}) as Record<string, unknown>
  if (r.table_name === 'activity') {
    return Object.entries(n)
      .filter(([, v]) => v !== null && v !== '' && typeof v !== 'object')
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ')
  }
  if (r.action !== 'update' || !r.old_data) return ''
  const o = r.old_data as Record<string, unknown>
  return Object.keys(n)
    .filter((k) => k !== 'updated_at' && JSON.stringify(o[k]) !== JSON.stringify(n[k]))
    .join(', ')
}

export function backupSheets(d: BackupData, stampFor: (title: string) => ReportStamp): XlsxSheet[] {
  const employees = new Map(d.employees.map((e) => [e.id, e]))
  const consultants = new Map(d.consultants.map((c) => [c.id, c]))
  const runs = new Map(d.runs.map((r) => [r.id, r]))
  const runNo = (id: string) => runs.get(id)?.control_no ?? ''
  const payee = (c: Consultant | undefined) =>
    !c ? '' : c.payee_type === 'juridical' ? c.registered_name : [c.last_name, [c.first_name, c.middle_name].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  const heading = (title: string) => stampRows(stampFor(`${title}, ${d.period}`))
  const sheet = (name: string, columns: XlsxColumn[], rows: XlsxCell[][]): XlsxSheet => ({ name, heading: heading(name), columns, rows })
  const slipName = (s: Payslip) => {
    const snap = s.employee_snapshot as Record<string, string>
    return [snap.employee_no ?? employees.get(s.employee_id)?.employee_no ?? '', snap.name ?? person(employees.get(s.employee_id))[1]]
  }

  const sheets: XlsxSheet[] = [
    sheet(
      'Payroll runs',
      [
        col('Payroll No', 'text', 12), col('Run type', 'text', 12), col('Frequency'), col('Period start', 'text', 12), col('Period end', 'text', 12),
        col('Pay date', 'text', 12), col('Payroll month', 'text', 13), col('Payroll of the month', 'text', 10), col('Status'), col('Finalized at', 'text', 17),
        col('Employees', 'int'), money('Gross pay'), money('Withholding tax'), money('SSS EE'), money('SSS ER'), money('PhilHealth EE'),
        money('PhilHealth ER'), money('Pag-IBIG EE'), money('Pag-IBIG ER'), money('Net pay'), money('Employer cost'), col('Notes', 'text', 30),
      ],
      d.runs.map((r) => {
        const t = r.totals ?? {}
        return [
          r.control_no ?? '', RUN_TYPES[r.run_type] ?? r.run_type, r.pay_frequency ?? '', r.period_start, r.period_end, r.pay_date,
          r.period_month?.slice(0, 7), `${r.period_index} of ${r.periods_in_month}`, r.status, manilaDateTime(r.finalized_at),
          num(t.employees), num(t.gross), num(t.withholding_tax), num(t.sss_ee), num(t.sss_er), num(t.philhealth_ee),
          num(t.philhealth_er), num(t.pagibig_ee), num(t.pagibig_er), num(t.net), num(t.employer_cost), r.notes,
        ]
      }),
    ),
    sheet(
      'Payslips',
      [
        col('Payslip No', 'text', 12), col('Payroll No', 'text', 12), col('Run status'), col('Employee No', 'text', 12), col('Employee', 'text', 28),
        col('Position', 'text', 18), col('Period start', 'text', 12), col('Period end', 'text', 12), col('Pay date', 'text', 12),
        col('Run type', 'text', 12), col('Frequency'), col('Paid by'), col('MWE'), col('Days worked', 'number'), col('Hours worked', 'number'),
        col('OT hours', 'number'), col('Night diff hours', 'number'), col('Late (min)', 'int'), col('Undertime (min)', 'int'),
        col('Absent days', 'number'), money('Basic pay'), money('Gross pay'), money('Taxable income'), money('SSS EE'), money('SSS MPF EE'),
        money('PhilHealth EE'), money('Pag-IBIG EE'), money('Withholding tax'), money('Union dues'), money('Other deductions'),
        money('Total deductions'), money('Cash rounding'), money('Net pay'), money('SSS ER'), money('SSS MPF ER'), money('EC ER'),
        money('PhilHealth ER'), money('Pag-IBIG ER'), money('PhilHealth NG share'),
      ],
      d.payslips.map((s) => {
        const snap = s.employee_snapshot as Record<string, string>
        const [no, name] = slipName(s)
        return [
          s.control_no ?? '', runNo(s.payroll_run_id), runs.get(s.payroll_run_id)?.status ?? '', no, name, snap.position ?? '',
          s.period_start, s.period_end, s.pay_date, s.run_type ? RUN_TYPES[s.run_type] : '', s.pay_frequency ?? '', s.payment_method ?? '',
          s.is_minimum_wage_earner, num(s.days_worked), num(s.hours_worked), num(s.overtime_hours), num(s.night_diff_hours),
          num(s.late_minutes), num(s.undertime_minutes), num(s.absent_days), num(s.basic_pay), num(s.gross_pay), num(s.taxable_income),
          num(s.sss_ee), num(s.sss_mpf_ee), num(s.philhealth_ee), num(s.pagibig_ee), num(s.withholding_tax), num(s.union_dues),
          num(s.other_deductions_total), num(s.total_deductions), num(s.rounding_adjustment), num(s.net_pay), num(s.sss_er),
          num(s.sss_mpf_er), num(s.sss_ec_er), num(s.philhealth_er), num(s.pagibig_er), num(s.philhealth_ng),
        ]
      }),
    ),
    sheet(
      'Payslip lines',
      [
        col('Payslip No', 'text', 12), col('Payroll No', 'text', 12), col('Employee No', 'text', 12), col('Employee', 'text', 28),
        col('Pay date', 'text', 12), col('Kind'), col('Code', 'text', 18), col('Label', 'text', 30), col('Hours', 'number'),
        col('Taxable'), col('BIR class', 'text', 14), money('Amount'),
      ],
      d.payslips.flatMap((s) => {
        const [no, name] = slipName(s)
        const line = (kind: string) => (l: Payslip['earnings'][number]): XlsxCell[] => [
          s.control_no ?? '', runNo(s.payroll_run_id), no, name, s.pay_date, kind, l.code, l.label, num(l.hours),
          l.taxable === undefined ? '' : l.taxable, l.bir ?? '', num(l.amount),
        ]
        return [...(s.earnings ?? []).map(line('Earning')), ...(s.deductions ?? []).map(line('Deduction'))]
      }),
    ),
    sheet(
      'Employees',
      [
        col('Employee No', 'text', 12), col('Last name', 'text', 16), col('First name', 'text', 16), col('Middle name', 'text', 14), col('Suffix'),
        col('Status'), col('Position', 'text', 18), col('Department', 'text', 16), col('Hire date', 'text', 12),
        col('Regularization date', 'text', 12), col('Separation date', 'text', 12), col('Separation reason', 'text', 16),
        col('Pay type'), col('Pay frequency'), money('Monthly rate'), money('Daily rate'), col('MWE'), col('Fixed salary'),
        col('Paid by'), col('Bank', 'text', 14), col('Bank account no', 'text', 16), col('TIN', 'text', 14), col('SSS no', 'text', 14),
        col('PhilHealth no', 'text', 15), col('Pag-IBIG no', 'text', 15), col('Birth date', 'text', 12), col('Gender'),
        col('Civil status'), col('Nationality'), col('Address', 'text', 30), col('ZIP'), col('Email', 'text', 22), col('Phone', 'text', 14),
      ],
      d.employees.map((e) => [
        e.employee_no, e.last_name, e.first_name, e.middle_name, e.suffix, e.employment_status, e.position, e.department, e.hire_date,
        e.regularization_date, e.separation_date, e.separation_reason, e.pay_type, e.pay_frequency, num(e.monthly_rate), num(e.daily_rate),
        e.is_minimum_wage_earner, e.fixed_salary ?? false, e.payment_method, e.bank_name, e.bank_account_no, e.tin, e.sss_no,
        e.philhealth_no, e.pagibig_no, e.birth_date, e.gender, e.civil_status, e.nationality, e.address, e.zip_code, e.email, e.phone,
      ]),
    ),
    sheet(
      'Pay rates',
      [
        col('Employee No', 'text', 12), col('Employee', 'text', 28), col('Effective from', 'text', 13), col('Pay type'), money('Rate'),
        col('Reason', 'text', 14), col('Approved by', 'text', 18), col('Note', 'text', 30), col('Recorded at', 'text', 17),
      ],
      d.payRates.map((r) => [
        ...person(employees.get(r.employee_id)), r.effective_from, r.pay_type, num(r.rate), r.reason, r.approved_by, r.note, manilaDateTime(r.created_at),
      ]),
    ),
    sheet(
      'Adjustments',
      [
        col('Payroll No', 'text', 12), col('Pay date', 'text', 12), col('Employee No', 'text', 12), col('Employee', 'text', 28), col('Kind'),
        col('Label', 'text', 28), col('Category', 'text', 16), money('Amount'), col('Authorized on', 'text', 13), col('Recorded at', 'text', 17),
      ],
      d.adjustments.map((a) => [
        runNo(a.payroll_run_id), runs.get(a.payroll_run_id)?.pay_date ?? '', ...person(employees.get(a.employee_id)), a.kind, a.label,
        a.category, num(a.amount), a.authorized_on ?? '', manilaDateTime(a.created_at),
      ]),
    ),
    sheet(
      'Advances and loans',
      [
        col('Employee No', 'text', 12), col('Employee', 'text', 28), col('Label', 'text', 28), col('Category', 'text', 14), money('Total'),
        money('Per payroll'), money('Balance'), col('Start', 'text', 12), col('End', 'text', 12), col('Active'), col('Released on', 'text', 12),
        col('Released by'), col('Authorized on', 'text', 13), col('Notes', 'text', 30),
      ],
      d.deductions.map((r) => [
        ...person(employees.get(r.employee_id)), r.label, r.category, num(r.total_amount), num(r.amount_per_period), num(r.balance),
        r.start_date, r.end_date, r.active, r.released_on ?? '', r.release_method ?? '', r.authorized_on ?? '', r.notes ?? '',
      ]),
    ),
    sheet(
      'Repayments',
      [col('Employee No', 'text', 12), col('Employee', 'text', 28), col('Paid on', 'text', 12), money('Amount'), col('Notes', 'text', 30)],
      d.repayments.map((r) => [...person(employees.get(r.employee_id)), r.paid_on, num(r.amount), r.notes]),
    ),
    sheet(
      'BIR remittances',
      [
        col('Month', 'text', 10), col('Date paid', 'text', 12), col('Bank or agency', 'text', 18), col('Reference no', 'text', 18),
        money('Taxes withheld'), money('Adjustment'), money('Penalties'), money('Total remitted'), col('Remarks', 'text', 30),
      ],
      d.remittances.map((r) => [
        r.period_month?.slice(0, 7), r.date_paid, r.bank_or_agency, r.reference_no, num(r.taxes_withheld), num(r.adjustment),
        num(r.penalties), num(r.total_remitted), r.remarks,
      ]),
    ),
    sheet(
      'Consultants',
      [
        col('Payee', 'text', 28), col('Type'), col('TIN', 'text', 14), col('Branch'), col('Address', 'text', 30), col('ZIP'),
        col('VAT-registered'), col('Service', 'text', 24), col('Fee basis', 'text', 14), money('Fee'), col('Billing', 'text', 14),
        col('Contract ref', 'text', 14), col('Contract start', 'text', 13), col('Contract end', 'text', 13), col('Active'),
      ],
      d.consultants.map((c) => [
        payee(c), c.payee_type, c.tin, c.tin_branch_code, c.address, c.zip_code, c.vat_registered, c.service, c.fee_basis,
        num(c.fee_amount), c.billing, c.contract_ref, c.contract_start, c.contract_end, c.active,
      ]),
    ),
    sheet(
      'Consultant billings',
      [
        col('Payee', 'text', 28), col('TIN', 'text', 14), col('Invoice no', 'text', 14), col('Billed on', 'text', 12),
        col('Service from', 'text', 12), col('Service to', 'text', 12), col('Description', 'text', 28), money('Gross'), money('VAT'),
        col('ATC'), col('EWT rate', 'number'), money('EWT withheld'), money('Net paid'), col('Paid on', 'text', 12), col('Payment ref', 'text', 16),
      ],
      d.billings.map((b) => {
        const c = consultants.get(b.consultant_id)
        return [
          payee(c), c?.tin ?? '', b.invoice_no, b.billed_on, b.service_from, b.service_to, b.description, num(b.gross_amount),
          num(b.vat_amount), b.atc, num(b.ewt_rate), num(b.ewt_amount), num(b.net_amount), b.paid_on, b.payment_ref,
        ]
      }),
    ),
    sheet(
      'Voided payrolls',
      [
        col('Payroll No', 'text', 12), col('Period start', 'text', 12), col('Period end', 'text', 12), col('Pay date', 'text', 12),
        col('Voided at', 'text', 17), col('Voided by', 'text', 22), col('Reason', 'text', 40), col('Payslips', 'int'), money('Gross pay'), money('Net pay'),
      ],
      d.voids.map((v) => [
        v.run_control_no ?? '', v.run_snapshot.period_start, v.run_snapshot.period_end, v.run_snapshot.pay_date, manilaDateTime(v.voided_at),
        v.voided_by_email ?? '', v.reason, v.payslips.length,
        v.payslips.reduce((t, s) => t + Number(s.gross_pay), 0), v.payslips.reduce((t, s) => t + Number(s.net_pay), 0),
      ]),
    ),
    sheet(
      'Voided payslips',
      [
        col('Payroll No', 'text', 12), col('Payslip No', 'text', 12), col('Employee No', 'text', 12), col('Employee', 'text', 28),
        col('Pay date', 'text', 12), money('Gross pay'), money('Withholding tax'), money('Total deductions'), money('Net pay'), col('Voided at', 'text', 17),
      ],
      d.voids.flatMap((v) =>
        v.payslips.map((s) => {
          const [no, name] = slipName(s)
          return [v.run_control_no ?? '', s.control_no ?? '', no, name, s.pay_date, num(s.gross_pay), num(s.withholding_tax), num(s.total_deductions), num(s.net_pay), manilaDateTime(v.voided_at)]
        }),
      ),
    ),
    sheet(
      'Time in-out',
      [
        col('Employee No', 'text', 12), col('Employee', 'text', 28), col('Work date', 'text', 12), col('Time in', 'text', 17),
        col('Time out', 'text', 17), col('Source'), col('Status'), col('Edited'), col('Flags', 'text', 18), col('Notes', 'text', 30),
      ],
      d.timeEntries.map((t) => [
        ...person(employees.get(t.employee_id)), t.work_date, manilaDateTime(t.clock_in), manilaDateTime(t.clock_out), t.source, t.status,
        t.manually_edited, (t.flags ?? []).join(', '), t.admin_notes ?? '',
      ]),
    ),
    sheet(
      'Leave',
      [
        col('Employee No', 'text', 12), col('Employee', 'text', 28), col('Leave type', 'text', 18), col('Start', 'text', 12), col('End', 'text', 12),
        col('Days', 'number'), col('Status'), col('Reason', 'text', 30), col('Review notes', 'text', 30), col('Filed at', 'text', 17),
      ],
      d.leaves.map((l) => [
        ...person(employees.get(l.employee_id)), l.leave_types?.name ?? '', l.start_date, l.end_date, num(l.days), l.status, l.reason,
        l.review_notes ?? '', manilaDateTime(l.created_at),
      ]),
    ),
    sheet(
      'Audit log',
      [col('When', 'text', 17), col('By', 'text', 24), col('Action', 'text', 14), col('Record type', 'text', 20), col('Record id', 'text', 38), col('Changed or detail', 'text', 50)],
      d.audit.map((r) => [manilaDateTime(r.created_at), r.actor_email ?? (r.actor_id ? r.actor_id : 'system'), r.action, r.table_name, r.record_id ?? '', changed(r)]),
    ),
  ]

  const counts = new Map(sheets.map((s) => [s.name, s.rows.length]))
  const about: XlsxSheet = {
    name: 'About',
    heading: stampRows(stampFor(`Payroll records backup, ${d.period}`)),
    columns: [col('Sheet', 'text', 20), col('Rows', 'int'), col('What it holds', 'text', 70)],
    rows: [
      ...BACKUP_SHEETS.map(([name, what]) => [name, counts.get(name) ?? 0, what]),
      [],
      ['Note', null, 'Amounts are in Philippine pesos; dates and times are Philippine time (UTC+8). Keep this file with the client\'s books for at least five years (RA 11976, RR 7-2024).'],
    ],
  }
  return [about, ...sheets]
}
