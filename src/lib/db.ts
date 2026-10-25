// Lightweight row types mirroring the Supabase schema.
// Keep in sync with supabase migrations (source of truth).

import type {
  AllowanceBasis,
  AllowanceCategory,
  BirBucket,
  ContributionTiming,
  IncomeClass,
  LeavePolicy,
  MaternityBenefit,
  PayFrequency,
  RoundingMode,
  StatutoryKind,
  WhtMethod,
  WorkSchedule,
} from '../payroll/types'
import type { EfpsGroup, FilingMode, ObligationKey } from '../payroll/dueDates'

export type Role = 'company_admin' | 'entity_admin' | 'employee'

/** Rank and file, or managerial/supervisory: a managerial or supervisory employee's fringe benefits are subject to the fringe benefit tax (NIRC Sec. 33). */
export type JobLevel = 'rank_and_file' | 'managerial_supervisory'

/** Who may be exempted from the maternity salary differential (RA 11210 Sec. 5(c), with DOLE approval each year). */
export type MaternityExemptionCategory = 'distressed' | 'small_retail_service' | 'micro_business' | 'equal_or_better'

export interface Profile {
  id: string
  employee_id: string | null
  role: Role
  email: string | null
  full_name: string
  is_active: boolean
  created_at?: string
}

/** A client: one employer / BIR withholding agent. */
export interface Entity {
  id: string
  code: string
  name: string
  trade_name: string
  tin: string
  tin_branch_code: string
  rdo_code: string
  registered_address: string
  zip_code: string
  contact_number: string
  contact_email: string
  withholding_agent_category: 'private' | 'government'
  is_top_withholding_agent: boolean
  sss_employer_no: string
  philhealth_employer_no: string
  pagibig_employer_no: string
  default_pay_frequency: PayFrequency
  minimum_wage_region: string
  /** the wage order's sector that applies to the client; '' = the region's general rate (spec T12) */
  minimum_wage_sector: string
  /** the client's own daily minimum wage: used only when the minimum wage table has no rate for the region and date */
  minimum_wage_daily: number
  minimum_wage_reference: string
  /** an unworked regular holiday after an unpaid absence: the workday-before rule, or pay it anyway (spec T12) */
  holiday_pay_after_absence: 'apply_rule' | 'pay_anyway'
  /** how cash conversion of unused leave is taxed (spec T7) */
  leave_policy: LeavePolicy
  /** DOLE exemption from the maternity salary differential (RA 11210 Sec. 5(c)): kind, approval reference and the year it covers */
  maternity_exemption_category: MaternityExemptionCategory | null
  maternity_exemption_dole_ref: string | null
  maternity_exemption_year: number | null
  /** how the client files with the BIR, which sets its 1601-C dates (spec T9); null = not chosen yet */
  filing_mode: FilingMode | null
  efps_group: EfpsGroup | null
  /** day of the next month each agency's remittance is due (spec P6, pending: no default) */
  sss_due_day: number | null
  philhealth_due_day: number | null
  pagibig_due_day: number | null
  standard_hours_per_day: number
  working_days_divisor: number
  grace_period_minutes: number
  night_diff_rate: number
  contribution_deduction_timing: ContributionTiming
  net_pay_rounding: RoundingMode
  rounding_scope: 'cash_only' | 'all'
  pay_date_lag_days: number
  payslip_footer_note: string
  is_active: boolean
  created_at: string
}

/** A statutory minimum wage of a region (and sector) from a wage order, kept by company admins (spec T12). */
export interface MinimumWage {
  id: string
  region: string
  sector: string
  daily_rate: number
  effective_from: string
  effective_to: string | null
  wage_order_ref: string
  created_at?: string
}

/** A due date the user set in place of the computed one, with the reason (spec T9). */
export interface DueDateOverrideRow {
  id: string
  entity_id: string
  obligation: ObligationKey
  /** the month covered, or January 1 of the tax year for the annual dates */
  period: string
  due_date: string
  note: string
}

export interface EntityAdmin {
  profile_id: string
  entity_id: string
}

export type EmploymentStatus =
  | 'regular'
  | 'probationary'
  | 'casual'
  | 'contractual'
  | 'project_based'
  | 'seasonal'
  | 'apprentice'

export type SeparationReason =
  | 'resignation'
  | 'termination'
  | 'end_of_contract'
  | 'retirement'
  | 'death'
  | 'transfer'
  | 'other'

export type PaymentMethod = 'cash' | 'bank_transfer' | 'e_wallet' | 'check'

export interface Employee {
  id: string
  entity_id: string
  employee_no: string
  first_name: string
  middle_name: string | null
  last_name: string
  suffix: string | null
  email: string | null
  phone: string | null
  address: string | null
  zip_code: string | null
  birth_date: string | null
  gender: string | null
  civil_status: string | null
  nationality: string
  photo_url: string | null
  tin: string | null
  sss_no: string | null
  philhealth_no: string | null
  pagibig_no: string | null
  hire_date: string
  regularization_date: string | null
  separation_date: string | null
  separation_reason: SeparationReason | null
  separation_remarks: string | null
  employment_status: EmploymentStatus
  position: string
  department: string
  pay_type: 'monthly' | 'daily'
  pay_frequency: PayFrequency
  monthly_rate: number
  daily_rate: number
  days_per_year: number | null
  is_minimum_wage_earner: boolean
  /** rank and file, or managerial/supervisory (fringe benefits subject to the fringe benefit tax) */
  job_level: JobLevel
  /** a minimum wage earner's hazard pay is exempt only with these (spec T5) */
  hazard_criteria_met: boolean
  hazard_dole_cert_ref: string | null
  /** the national government pays the PhilHealth employee share (RA 11228 PWD; RA 11861 solo parent), by month (spec T6) */
  philhealth_ee_waiver?: 'pwd' | 'solo_parent' | null
  /** first month of the NG share (YYYY-MM-01) */
  philhealth_waiver_start_month?: string | null
  /** solo parent: the SPIC's expiry (only months it fully covers are waived) */
  philhealth_spic_expiry?: string | null
  /** PWD: PhilHealth's status (only "confirmed" is waived) */
  philhealth_pwd_status?: 'for_verification' | 'confirmed' | null
  payment_method: PaymentMethod
  work_schedule: WorkSchedule
  bank_name: string | null
  bank_account_no: string | null
  emergency_contact_name: string | null
  emergency_contact_phone: string | null
  notes: string | null
  login_code_hint: string | null
  login_code_set_at: string | null
  rounding_balance: number
  /** Bumped by every finalize/reopen touching the employee (system-maintained). */
  payroll_seq: number
  created_at: string
}

export interface CareerEvent {
  id: string
  employee_id: string
  event_type: string
  effective_date: string
  position: string | null
  department: string | null
  monthly_rate: number | null
  daily_rate: number | null
  details: string
  created_at: string
}

export interface EmployeeAllowance {
  id: string
  employee_id: string
  label: string
  amount: number
  /** follows the pay code (a database trigger keeps them in step) */
  category: AllowanceCategory
  basis: AllowanceBasis
  /** pay_codes.code: what the allowance is (spec T2) */
  pay_code: string
  active: boolean
}

export interface RecurringDeduction {
  id: string
  employee_id: string
  label: string
  category: string
  amount_per_period: number
  total_amount: number | null
  balance: number | null
  start_date: string | null
  end_date: string | null
  active: boolean
  /** Cash advances: when and how it was released, and when the employee signed the authorization to deduct. */
  released_on?: string | null
  release_method?: PaymentMethod | null
  authorized_on?: string | null
  notes?: string
  /** Tax the employer paid at this run's year-end adjustment (spec T8): created at finalize, removed at reopen. */
  source_run_id?: string | null
  created_at?: string
}

/** An employee's request for a cash advance; approving it records the advance. */
export interface AdvanceRequest {
  id: string
  entity_id: string
  employee_id: string
  amount: number
  per_payroll: number
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  reviewed_by: string | null
  reviewed_at: string | null
  review_notes: string | null
  advance_id: string | null
  created_at: string
}

/** A cash advance repaid outside payroll (cash handed back, a transfer). */
export interface AdvanceRepayment {
  id: string
  advance_id: string
  entity_id: string
  employee_id: string
  paid_on: string
  amount: number
  notes: string
  recorded_by: string | null
  created_at: string
}

export interface TimeEntry {
  id: string
  employee_id: string
  entity_id: string
  work_date: string
  clock_in: string
  clock_out: string | null
  source: 'admin' | 'import' | 'correction'
  status: 'open' | 'closed'
  flags: string[]
  admin_notes: string | null
  manually_edited: boolean
}

export interface TimeCorrectionRequest {
  id: string
  employee_id: string
  entity_id: string
  time_entry_id: string | null
  work_date: string
  requested_clock_in: string | null
  requested_clock_out: string | null
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  reviewed_by: string | null
  reviewed_at: string | null
  review_notes: string | null
  created_at: string
}

export interface LeaveType {
  id: string
  entity_id: string | null
  code: string
  name: string
  default_annual_days: number
  paid: boolean
  active: boolean
  /** Months of service before the leave can be used (SIL: 12, Labor Code Art. 95); 0 = from the hire date. */
  min_service_months: number
}

export interface LeaveRequest {
  id: string
  employee_id: string
  entity_id: string
  leave_type_id: string
  start_date: string
  end_date: string
  days: number
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  review_notes: string | null
  created_at: string
}

export interface StatutoryVersion {
  id: string
  kind: StatutoryKind
  effective_from: string
  effective_to: string | null
  description: string
  source_url: string | null
  /** The law, regulation or circular the version implements. */
  legal_basis: string
  /** When the maintainer last checked it against its source. */
  verified_on: string | null
  data: unknown
  created_at: string
}

export interface Holiday {
  id: string
  entity_id: string | null
  holiday_date: string
  name: string
  kind: 'regular' | 'special_non_working' | 'special_working'
}

export type RunType = 'regular' | 'thirteenth_month' | 'special' | 'final_pay'

export interface PayrollRun {
  id: string
  entity_id: string
  run_type: RunType
  pay_frequency: PayFrequency | null
  period_start: string
  period_end: string
  pay_date: string
  period_month: string
  period_index: number
  periods_in_month: number
  employee_ids: string[] | null
  annualize: boolean
  status: 'draft' | 'finalized' | 'paid'
  notes: string
  totals: Record<string, number>
  finalized_at: string | null
  created_at: string
}

export interface PayslipLine {
  code: string
  label: string
  amount: number
  taxable?: boolean
  bir?: BirBucket
  hours?: number
  meta?: string
  /** allowances and one-time earnings */
  payCode?: string
  /** in the SSS base (spec T3) */
  sss?: boolean
  /** counts toward the 13th month besides basic pay */
  thirteenthBasis?: boolean
  /** taxable lines from spec T5 on: regular or supplementary compensation */
  incomeClass?: IncomeClass
  /** leave cash conversion: the days the line pays */
  days?: number
  /** a fringe benefit to a managerial or supervisory employee: for FBT review, not withheld on */
  fbt?: boolean
}

export interface Payslip {
  id: string
  payroll_run_id: string
  employee_id: string
  entity_id: string
  // Run info copied from the run by a DB trigger so employees never need
  // read access to payroll_runs (which carries company-wide totals/notes).
  period_start: string | null
  period_end: string | null
  pay_date: string | null
  run_type: RunType | null
  period_month: string | null
  pay_frequency: PayFrequency | null
  payment_method: PaymentMethod | null
  is_minimum_wage_earner: boolean
  employee_snapshot: Record<string, unknown>
  days_worked: number
  hours_worked: number
  overtime_hours: number
  night_diff_hours: number
  late_minutes: number
  undertime_minutes: number
  absent_days: number
  earnings: PayslipLine[]
  deductions: PayslipLine[]
  basic_pay: number
  gross_pay: number
  taxable_income: number
  /** R and S (spec T2); null on payslips computed before them */
  taxable_regular: number | null
  taxable_supplementary: number | null
  /** how withholding was computed; null on payslips computed before T2 */
  wht_method: WhtMethod | null
  sss_ee: number
  sss_er: number
  sss_ec_er: number
  sss_mpf_ee: number
  sss_mpf_er: number
  philhealth_ee: number
  philhealth_er: number
  pagibig_ee: number
  pagibig_er: number
  withholding_tax: number
  /** Year-end adjustment: tax the employer paid because the pay couldn't cover it (an advance to the employee, spec T8). */
  tax_paid_by_employer: number
  union_dues: number
  other_deductions_total: number
  total_deductions: number
  net_pay: number
  rounding_adjustment: number
  rounding_carry_in: number
  rounding_carry_out: number
  /** employees.payroll_seq the draft was computed from */
  employee_payroll_seq: number | null
  computation_trace: {
    dailyRate?: number
    hourlyRate?: number
    statutoryMonthlyBase?: number
    notes?: string[]
    warnings?: string[]
    /** problems that block finalizing (spec T4) */
    errors?: string[]
    days?: unknown[]
  }
  remarks: string | null
  created_at?: string
}

export interface PayrollAdjustment {
  id: string
  payroll_run_id: string
  employee_id: string
  entity_id: string
  kind: 'earning' | 'deduction'
  label: string
  amount: number
  /** earnings: follows the pay code; deductions: 'union_dues' or 'other' */
  category: string
  /** earnings only: pay_codes.code (spec T2) */
  pay_code?: string | null
  /** leave cash conversion: the days converted (spec T7) */
  days?: number | null
  /** RA 11210 maternity pay (category other_non_taxable), set by the pay code */
  benefit?: MaternityBenefit | null
  /** date the employee signed the written authorization ('other' deductions, Labor Code Art. 113) */
  authorized_on?: string | null
  created_at: string
}

/** What one draft payroll deducts for a recurring deduction instead of its usual installment (0 = skip). */
export interface PayrollDeductionOverride {
  id: string
  payroll_run_id: string
  deduction_id: string
  employee_id: string
  entity_id: string
  amount: number
  note: string
  created_at: string
}

export interface Announcement {
  id: string
  entity_id: string
  title: string
  body: string
  pinned: boolean
  published_at: string
  expires_at: string | null
  created_by: string | null
  created_at: string
}

export interface TaxRemittance {
  id: string
  entity_id: string
  period_month: string
  date_paid: string | null
  bank_or_agency: string
  reference_no: string
  taxes_withheld: number
  adjustment: number
  penalties: number
  total_remitted: number
  remarks: string
}

export interface EmployeeTaxYear {
  id: string
  employee_id: string
  entity_id: string
  year: number
  has_previous_employer: boolean
  prev_employer_tin: string
  prev_employer_name: string
  prev_employer_address: string
  prev_employer_zip: string
  prev_employment_from: string | null
  prev_employment_to: string | null
  /** employment status and reason of separation at the previous employer (alphalist previous-employer section) */
  prev_employment_status: EmploymentStatus | null
  prev_separation_reason: SeparationReason | null
  prev_mwe_exempt: number
  prev_13th_other_benefits_exempt: number
  prev_de_minimis: number
  prev_contributions: number
  prev_other_non_taxable: number
  prev_taxable_basic: number
  prev_taxable_13th_other_benefits: number
  prev_taxable_other: number
  prev_tax_withheld: number
  pera_tax_credit: number
  substituted_filing: 'auto' | 'yes' | 'no'
  notes: string
}

export interface AuditLog {
  id: number
  actor_id: string | null
  actor_email: string | null
  action: string
  table_name: string
  record_id: string | null
  entity_id: string | null
  old_data: unknown
  new_data: unknown
  created_at: string
}
