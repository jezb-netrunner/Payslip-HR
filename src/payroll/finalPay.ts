// What a separated employee's final pay still owes beside the last payroll:
// the 13th month pay pro-rated to the last day (PD 851; DOLE Labor Advisory
// 06-20: final pay within 30 days of separation) and the leave credits left
// (unused service incentive leave converts to cash, Labor Code Art. 95;
// other leave as the company's policy says). The payroll that holds the
// separation names both; the run page turns them into a 13th month run and
// leave-conversion adjustments.

import { leaveDaysInYear, showsBalance, usableOn, type Workdays } from '../lib/leave'
import type { Holiday, LeaveRequest, LeaveType } from '../lib/db'
import { EMPLOYMENT } from './law'
import { round2 } from './types'

/** The leave a separated employee has left, per leave type. */
export interface UnusedLeave {
  typeId: string
  code: string
  name: string
  days: number
}

/** Stored on the payslip's trace for the run page. */
export interface FinalPayDue {
  separationDate: string
  /** 13th month pay still due (0 when paid or not eligible) */
  thirteenth: number
  leave: UnusedLeave[]
}

/** 1/12 of the basic salary earned in the year, less what was already paid. */
export function thirteenthMonthDue(basicEarned: number, alreadyPaid: number): number {
  return round2(Math.max(0, basicEarned / EMPLOYMENT.thirteenthMonthDivisor.value - alreadyPaid))
}

/** Service incentive leave converts to cash by law; other leave only by company policy. */
export const STATUTORY_CONVERTIBLE = ['SIL']

/**
 * Leave credits left in the separation year, per paid leave type that keeps
 * a balance: the credits HR set for the year (else the type's yearly days),
 * less the approved leave charged to the year. A type not yet usable by the
 * last day (service incentive leave before 12 months of service) has none.
 */
export function unusedLeave(params: {
  types: Pick<LeaveType, 'id' | 'code' | 'name' | 'paid' | 'active' | 'default_annual_days' | 'min_service_months'>[]
  entitlements: { leave_type_id: string; days: number }[]
  approved: Pick<LeaveRequest, 'leave_type_id' | 'start_date' | 'end_date' | 'days'>[]
  year: number
  hireDate: string
  separationDate: string
  schedule: Workdays
  holidays?: Pick<Holiday, 'holiday_date' | 'kind'>[]
}): UnusedLeave[] {
  const out: UnusedLeave[] = []
  for (const t of params.types) {
    if (!t.paid || t.active === false) continue
    const set = params.entitlements.find((e) => e.leave_type_id === t.id)
    const credits = set ? Number(set.days) : undefined
    if (!showsBalance(t, credits)) continue
    if (!usableOn(t, params.hireDate, params.separationDate, credits)) continue
    const used = params.approved
      .filter((r) => r.leave_type_id === t.id)
      .reduce((s, r) => s + leaveDaysInYear(r, params.year, params.schedule, params.holidays ?? [], t), 0)
    const left = round2((credits ?? Number(t.default_annual_days)) - used)
    if (left > 0) out.push({ typeId: t.id, code: t.code, name: t.name, days: left })
  }
  return out
}
