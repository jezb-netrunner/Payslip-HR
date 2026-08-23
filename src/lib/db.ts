// Lightweight row types mirroring the Supabase schema.
// Keep in sync with supabase migrations (source of truth).

import type { WorkSchedule } from '../payroll/types'

export interface Profile {
  id: string
  employee_id: string | null
  role: 'admin' | 'employee'
  email: string | null
  full_name: string
  is_active: boolean
}

export interface Employee {
  id: string
  employee_no: string
  first_name: string
  middle_name: string | null
  last_name: string
  suffix: string | null
  email: string
  phone: string | null
  address: string | null
  birth_date: string | null
  gender: string | null
  civil_status: string | null
  photo_url: string | null
  tin: string | null
  sss_no: string | null
  philhealth_no: string | null
  pagibig_no: string | null
  hire_date: string
  regularization_date: string | null
  separation_date: string | null
  employment_status: string
  position: string
  department: string
  pay_type: 'monthly' | 'daily'
  monthly_rate: number
  daily_rate: number
  is_minimum_wage_earner: boolean
  work_schedule: WorkSchedule
  bank_name: string | null
  bank_account_no: string | null
  emergency_contact_name: string | null
  emergency_contact_phone: string | null
  notes: string | null
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
  monthly_amount: number
  taxable: boolean
  de_minimis: boolean
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
}

export interface TimeEntry {
  id: string
  employee_id: string
  work_date: string
  clock_in: string
  clock_out: string | null
  clock_in_selfie_path: string | null
  clock_out_selfie_path: string | null
  clock_in_ip: string | null
  clock_out_ip: string | null
  clock_in_device: Record<string, string> | null
  clock_out_device: Record<string, string> | null
  clock_in_location: { lat: number; lng: number; accuracy?: number } | null
  clock_out_location: { lat: number; lng: number; accuracy?: number } | null
  source: string
  status: 'open' | 'closed'
  flags: string[]
  admin_notes: string | null
  manually_edited: boolean
}

export interface TimeCorrectionRequest {
  id: string
  employee_id: string
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
  code: string
  name: string
  default_annual_days: number
  paid: boolean
  active: boolean
}

export interface LeaveRequest {
  id: string
  employee_id: string
  leave_type_id: string
  start_date: string
  end_date: string
  days: number
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  review_notes: string | null
  created_at: string
}

export interface CompanySettings {
  id: number
  company_name: string
  address: string
  tin: string
  rdo_code: string
  sss_employer_no: string
  philhealth_employer_no: string
  pagibig_employer_no: string
  logo_url: string | null
  timezone: string
  currency: string
  pay_frequency: 'semi_monthly' | 'monthly'
  minimum_wage_daily: number
  minimum_wage_region: string
  standard_hours_per_day: number
  working_days_divisor: number
  grace_period_minutes: number
  night_diff_rate: number
  contribution_deduction_timing: 'split' | 'first_half' | 'second_half'
  require_selfie_on_punch: boolean
  require_location_on_punch: boolean
  payslip_footer_note: string
}

export interface StatutoryVersion {
  id: string
  kind: 'sss' | 'philhealth' | 'pagibig' | 'bir_wht' | 'bir_annual'
  effective_from: string
  effective_to: string | null
  description: string
  source_url: string | null
  data: unknown
  created_at: string
}

export interface Holiday {
  id: string
  holiday_date: string
  name: string
  kind: 'regular' | 'special_non_working' | 'special_working'
}

export interface PayrollRun {
  id: string
  run_type: 'regular' | 'thirteenth_month' | 'special' | 'final_pay'
  period_start: string
  period_end: string
  pay_date: string
  status: 'draft' | 'finalized' | 'paid'
  notes: string
  totals: Record<string, number>
  finalized_at: string | null
  created_at: string
}

export interface Payslip {
  id: string
  payroll_run_id: string
  employee_id: string
  employee_snapshot: Record<string, unknown>
  days_worked: number
  hours_worked: number
  overtime_hours: number
  night_diff_hours: number
  late_minutes: number
  undertime_minutes: number
  absent_days: number
  earnings: { code: string; label: string; amount: number; taxable?: boolean; hours?: number; meta?: string }[]
  deductions: { code: string; label: string; amount: number; meta?: string }[]
  basic_pay: number
  gross_pay: number
  taxable_income: number
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
  other_deductions_total: number
  total_deductions: number
  net_pay: number
  computation_trace: {
    dailyRate?: number
    hourlyRate?: number
    statutoryMonthlyBase?: number
    notes?: string[]
    warnings?: string[]
    days?: unknown[]
  }
  remarks: string | null
}

export interface AuditLog {
  id: number
  actor_id: string | null
  action: string
  entity: string
  entity_id: string | null
  old_data: unknown
  new_data: unknown
  created_at: string
}
