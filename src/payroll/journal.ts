// The payroll's journal entry: one balanced voucher per run for the books.
// Every payslip line lands in an account (an earning is a debit, a deduction a
// credit, a negative one the other way), the employer's contributions are an
// expense and a payable, the cash rounding and its carried centavos have
// their own accounts, and net pay is what is owed to employees. The account
// names are generic: the accountant maps them to the client's chart of
// accounts.

import type { Payslip } from '../lib/db'
import { round2 } from './types'

export type JournalSlip = Pick<
  Payslip,
  | 'earnings'
  | 'deductions'
  | 'net_pay'
  | 'sss_er'
  | 'sss_mpf_er'
  | 'sss_ec_er'
  | 'philhealth_er'
  | 'pagibig_er'
  | 'rounding_adjustment'
  | 'rounding_carry_in'
  | 'rounding_carry_out'
  | 'payment_method'
>

export interface JournalLine {
  account: string
  debit: number
  credit: number
}

export interface JournalEntry {
  lines: JournalLine[]
  debit: number
  credit: number
  balanced: boolean
}

/** The accounts, in the order the voucher lists them (debits first). */
export const ACCOUNTS = {
  salaries: 'Salaries and wages (basic, overtime, premiums, holiday pay)',
  allowances: 'Allowances (incl. de minimis benefits)',
  commissions: 'Commissions, fees and other supplementary pay',
  benefits: '13th month pay and other benefits',
  differential: 'Maternity salary differential',
  otherPay: 'Other non-taxable pay',
  erSss: 'Employer contributions: SSS and EC',
  erPhilhealth: 'Employer contributions: PhilHealth',
  erPagibig: 'Employer contributions: Pag-IBIG',
  rounding: 'Cash rounding of net pay',
  sssMaternity: 'Receivable from SSS: maternity benefit advanced',
  employeeReceivable: 'Receivable from employees (contributions and tax advanced)',
  maternityClearing: 'Employee contributions: maternity leave clearing',
  advances: 'Advances to employees (cash advances)',
  companyLoans: 'Loans receivable from employees',
  sss: 'SSS contributions payable',
  philhealth: 'PhilHealth contributions payable',
  pagibig: 'Pag-IBIG contributions payable',
  tax: 'Withholding tax on compensation payable (BIR 1601-C)',
  sssLoans: 'SSS loans payable',
  pagibigLoans: 'Pag-IBIG loans payable',
  unionDues: 'Union dues payable',
  hmo: 'HMO premiums payable',
  otherDeductions: 'Other payroll deductions payable',
  carried: 'Centavos held for employees (carried to the next payout)',
  netBank: 'Net pay payable: bank transfer',
  netCash: 'Net pay payable: cash',
  netOther: 'Net pay payable: other',
} as const

type Account = (typeof ACCOUNTS)[keyof typeof ACCOUNTS]

const SALARY_BUCKETS = ['basic', 'overtime', 'night_diff', 'holiday', 'premium', 'hazard']
const ALLOWANCE_BUCKETS = ['cola', 'representation', 'transportation', 'housing', 'other_taxable', 'de_minimis']
const COMMISSION_BUCKETS = ['commission', 'profit_sharing', 'fees', 'other_supplementary']
const BENEFIT_BUCKETS = ['thirteenth', 'other_benefits']

function earningAccount(l: { bir?: string; benefit?: string; taxable?: boolean }): Account {
  if (l.benefit === 'sss_maternity') return ACCOUNTS.sssMaternity
  if (l.benefit === 'maternity_differential') return ACCOUNTS.differential
  const b = l.bir ?? ''
  if (SALARY_BUCKETS.includes(b)) return ACCOUNTS.salaries
  if (ALLOWANCE_BUCKETS.includes(b)) return ACCOUNTS.allowances
  if (COMMISSION_BUCKETS.includes(b)) return ACCOUNTS.commissions
  if (BENEFIT_BUCKETS.includes(b)) return ACCOUNTS.benefits
  if (b === 'other_non_taxable') return ACCOUNTS.otherPay
  return l.taxable === false ? ACCOUNTS.otherPay : ACCOUNTS.commissions
}

function deductionAccount(code: string): Account {
  switch (code) {
    case 'sss':
    case 'sss_mpf':
      return ACCOUNTS.sss
    case 'philhealth':
      return ACCOUNTS.philhealth
    case 'pagibig':
      return ACCOUNTS.pagibig
    case 'wht':
      return ACCOUNTS.tax
    case 'ee_collect':
    case 'tax_advance':
      return ACCOUNTS.employeeReceivable
    case 'ee_pending':
    case 'ee_prepaid':
    case 'maternity_contributions':
      return ACCOUNTS.maternityClearing
  }
  const category = code.includes(':') ? code.slice(code.indexOf(':') + 1) : ''
  switch (category) {
    case 'cash_advance':
      return ACCOUNTS.advances
    case 'company_loan':
      return ACCOUNTS.companyLoans
    case 'sss_loan':
      return ACCOUNTS.sssLoans
    case 'pagibig_loan':
      return ACCOUNTS.pagibigLoans
    case 'union_dues':
      return ACCOUNTS.unionDues
    case 'hmo':
      return ACCOUNTS.hmo
    default:
      return ACCOUNTS.otherDeductions
  }
}

/** The run's voucher: one line per account, debit or credit by its net amount. */
export function payrollJournal(slips: JournalSlip[]): JournalEntry {
  // signed per account: debit positive, credit negative, in centavos
  const cents = new Map<Account, number>()
  const post = (account: Account, debit: number) => {
    const c = Math.round(Number(debit) * 100)
    if (c !== 0) cents.set(account, (cents.get(account) ?? 0) + c)
  }
  for (const s of slips) {
    for (const l of s.earnings ?? []) post(earningAccount(l), Number(l.amount))
    for (const l of s.deductions ?? []) post(deductionAccount(l.code), -Number(l.amount))
    const sssEr = Number(s.sss_er) + Number(s.sss_mpf_er) + Number(s.sss_ec_er)
    post(ACCOUNTS.erSss, sssEr)
    post(ACCOUNTS.sss, -sssEr)
    post(ACCOUNTS.erPhilhealth, Number(s.philhealth_er))
    post(ACCOUNTS.philhealth, -Number(s.philhealth_er))
    post(ACCOUNTS.erPagibig, Number(s.pagibig_er))
    post(ACCOUNTS.pagibig, -Number(s.pagibig_er))
    // rounding: centavos carried in are paid out of what was held, centavos
    // carried out are held for the employee, the rest is the employer's
    const carryIn = Number(s.rounding_carry_in ?? 0)
    const carryOut = Number(s.rounding_carry_out ?? 0)
    post(ACCOUNTS.carried, carryIn - carryOut)
    post(ACCOUNTS.rounding, Number(s.rounding_adjustment ?? 0) - carryIn + carryOut)
    post(s.payment_method === 'cash' ? ACCOUNTS.netCash : s.payment_method === 'bank_transfer' ? ACCOUNTS.netBank : ACCOUNTS.netOther, -Number(s.net_pay))
  }
  const order = Object.values(ACCOUNTS) as Account[]
  const all = order.filter((a) => (cents.get(a) ?? 0) !== 0).map((a) => ({ account: a, c: cents.get(a)! }))
  const lines: JournalLine[] = [
    ...all.filter((x) => x.c > 0).map((x) => ({ account: x.account, debit: x.c / 100, credit: 0 })),
    ...all.filter((x) => x.c < 0).map((x) => ({ account: x.account, debit: 0, credit: -x.c / 100 })),
  ]
  const debit = round2(lines.reduce((t, l) => t + l.debit, 0))
  const credit = round2(lines.reduce((t, l) => t + l.credit, 0))
  return { lines, debit, credit, balanced: Math.abs(debit - credit) < 0.005 }
}
