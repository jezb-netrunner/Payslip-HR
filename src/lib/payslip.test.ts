import { describe, expect, it } from 'vitest'
import { attendanceFacts, payslipRate } from './payslip'

describe('payslipRate', () => {
  it('reads the monthly or daily rate the payslip was computed at', () => {
    expect(payslipRate({ employee_snapshot: { pay_type: 'monthly', monthly_rate: 30000, daily_rate: 0 } })).toEqual({ amount: 30000, per: 'month' })
    expect(payslipRate({ employee_snapshot: { pay_type: 'daily', monthly_rate: 0, daily_rate: '755.00' } })).toEqual({ amount: 755, per: 'day' })
  })

  it('has none for a zero rate or an old snapshot', () => {
    expect(payslipRate({ employee_snapshot: { pay_type: 'daily', daily_rate: 0 } })).toBeNull()
    expect(payslipRate({ employee_snapshot: { name: 'Ana' } })).toBeNull()
  })
})

describe('attendanceFacts', () => {
  const base = {
    run_type: 'regular' as const,
    days_worked: 11,
    hours_worked: 88,
    overtime_hours: 0,
    night_diff_hours: 0,
    late_minutes: 0,
    undertime_minutes: 0,
    absent_days: 0,
  }

  it('always shows days and hours, and the rest only when not zero', () => {
    expect(attendanceFacts(base)).toEqual([
      { label: 'Days worked', value: '11' },
      { label: 'Hours', value: '88' },
    ])
    expect(attendanceFacts({ ...base, overtime_hours: 2.5, late_minutes: 15, absent_days: 1 })).toEqual([
      { label: 'Days worked', value: '11' },
      { label: 'Hours', value: '88' },
      { label: 'Overtime', value: '2.5 h' },
      { label: 'Late', value: '15 min' },
      { label: 'Absent / unpaid leave', value: '1 day' },
    ])
  })

  it('is empty for a 13th month payslip and for one without attendance', () => {
    expect(attendanceFacts({ ...base, run_type: 'thirteenth_month' })).toEqual([])
    expect(attendanceFacts({ ...base, days_worked: 0, hours_worked: 0 })).toEqual([])
  })

  it('shows a period of absences only', () => {
    expect(attendanceFacts({ ...base, days_worked: 0, hours_worked: 0, absent_days: 3 })).toEqual([
      { label: 'Days worked', value: '0' },
      { label: 'Hours', value: '0' },
      { label: 'Absent / unpaid leave', value: '3 days' },
    ])
  })
})
