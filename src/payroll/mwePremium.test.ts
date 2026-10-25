// Spec T5: for a minimum wage earner, the exemption covers the minimum wage,
// holiday pay, overtime, night differential and hazard pay — not the premium
// for work on a rest day or a special day. Pay for the day at the SMW rate
// stays exempt; the add-on above it (30%; 50% for a special day on a rest
// day) and anything above 200% for a regular holiday on a rest day is S.
// Hazard pay is exempt only with the criteria met and a DOLE certification.
import { describe, expect, it } from 'vitest'
import { summarizeYear } from './annual'
import { computeAttendance } from './attendance'
import { BIR_ANNUAL_2023, DEFAULT_TABLES } from './defaults'
import { computePayslip } from './engine'
import type { HolidayLite, PayrollEmployeeInput, PayrollSettingsInput, PayslipComputation } from './types'

// fixture: daily SMW = 500 (a test value only)
const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  // no contributions on this payroll: the figures stay the day's pay
  contributionTiming: 'last_period',
  payFrequency: 'weekly',
  minimumWageDaily: 500,
}
const mwe: PayrollEmployeeInput = {
  id: 'm1',
  name: 'Min Wage',
  payType: 'daily',
  monthlyRate: 0,
  dailyRate: 500,
  isMinimumWageEarner: true,
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
}

/** One day worked 09:00–18:00 Manila (plus `otHours` past it), in a one-day payroll. */
function workDay(date: string, holiday?: HolidayLite['kind'], employee = mwe, otHours = 0): PayslipComputation {
  const out = `${String(10 + otHours).padStart(2, '0')}:00`
  const holidays: HolidayLite[] = holiday ? [{ holiday_date: date, name: 'Holiday', kind: holiday }] : []
  return computePayslip({
    employee,
    settings,
    period: { start: date, end: date, index: 1, count: 4 },
    tables: DEFAULT_TABLES,
    days: computeAttendance({
      periodStart: date,
      periodEnd: date,
      schedule: employee.schedule,
      standardHoursPerDay: 8,
      gracePeriodMinutes: 0,
      entries: [{ work_date: date, clock_in: `${date}T01:00:00Z`, clock_out: `${date}T${out}:00Z` }],
      holidays,
      approvedLeaves: [],
    }),
    runType: 'regular',
  })
}

const exempt = (s: PayslipComputation) => s.earnings.filter((l) => !l.taxable).reduce((a, l) => a + l.amount, 0)
const taxable = (s: PayslipComputation) => s.earnings.filter((l) => l.taxable).reduce((a, l) => a + l.amount, 0)

describe('T5 MWE premium pay split (daily SMW 500)', () => {
  it('rest day worked: 650 = SMW 500 + S 150', () => {
    const s = workDay('2026-08-15') // Saturday
    expect(s.grossPay).toBe(650)
    expect(exempt(s)).toBe(500)
    expect(taxable(s)).toBe(150)
    expect(s.taxableSupplementary).toBe(150)
    expect(s.earnings.find((l) => l.taxable)).toMatchObject({ code: 'restday_addon', bir: 'other_taxable', incomeClass: 'supplementary' })
  })

  it('special day worked: 650 = SMW 500 + S 150', () => {
    const s = workDay('2026-08-21', 'special_non_working') // Friday
    expect([s.grossPay, exempt(s), taxable(s)]).toEqual([650, 500, 150])
  })

  it('special day on a rest day: 750 = SMW 500 + S 250', () => {
    const s = workDay('2026-08-16', 'special_non_working') // Sunday
    expect([s.grossPay, exempt(s), taxable(s)]).toEqual([750, 500, 250])
  })

  it('regular holiday worked: 1,000, all exempt holiday pay', () => {
    const s = workDay('2026-08-31', 'regular') // Monday
    expect([s.grossPay, exempt(s), taxable(s)]).toEqual([1000, 1000, 0])
  })

  it('regular holiday on a rest day (260%): 1,000 exempt and (260% − 200%) × 500 = 300 S', () => {
    const s = workDay('2026-08-30', 'regular') // Sunday
    expect([s.grossPay, exempt(s), taxable(s)]).toEqual([1300, 1000, 300])
    expect(s.taxableSupplementary).toBe(300)
  })

  it('overtime and night differential on those days stay exempt', () => {
    const s = workDay('2026-08-15', undefined, mwe, 2)
    const ot = s.earnings.find((l) => l.code === 'ot')!
    expect(ot.taxable).toBe(false)
    expect(taxable(s)).toBe(150)
  })

  it('MWE status does not change, and a non-MWE\'s premium is all taxable as before', () => {
    expect(workDay('2026-08-15').trace.notes.some((n) => n.startsWith('Minimum wage earner'))).toBe(true)
    const s = workDay('2026-08-15', undefined, { ...mwe, isMinimumWageEarner: false })
    expect(s.earnings.map((l) => l.code)).toEqual(['basic', 'restday'])
    expect(taxable(s)).toBe(650)
  })

  it('a monthly-paid MWE: the rest-day day at the SMW is exempt, the 30% is S', () => {
    const monthlyMwe = { ...mwe, payType: 'monthly' as const, monthlyRate: 10875, dailyRate: 0 } // 500 × 261 / 12
    const s = workDay('2026-08-15', undefined, monthlyMwe)
    const rest = s.earnings.filter((l) => l.code.startsWith('restday'))
    expect(rest.map((l) => [l.code, l.amount, l.taxable])).toEqual([
      ['restday', 500, false],
      ['restday_addon', 150, true],
    ])
  })
})

describe('T5 MWE hazard pay', () => {
  const hazard = { label: 'Hazard pay', amount: 1000, category: 'hazard' as const, basis: 'per_period' as const, payCode: 'HAZARD' }

  it('is S unless the criteria are met and a DOLE certification is on file', () => {
    const s = workDay('2026-08-17', undefined, { ...mwe, allowances: [hazard] })
    expect(s.earnings.find((l) => l.payCode === 'HAZARD')).toMatchObject({ bir: 'hazard', taxable: true, incomeClass: 'supplementary' })
    expect(s.taxableSupplementary).toBe(1000)
    const met = workDay('2026-08-17', undefined, { ...mwe, allowances: [hazard], hazardExempt: true })
    expect(met.earnings.find((l) => l.payCode === 'HAZARD')).toMatchObject({ bir: 'hazard', taxable: false })
    expect(met.taxableIncome).toBe(0)
  })

  it('the year: taxable hazard pay and the premium add-ons are taxable compensation, not in the MWE boxes', () => {
    const facts = [
      workDay('2026-08-17', undefined, { ...mwe, allowances: [hazard] }),
      workDay('2026-08-15'),
    ].map((s) => ({ payMonth: '2026-08-01', isMwe: true, earnings: s.earnings, contributionsEe: 0, unionDues: 0, withholdingTax: 0 }))
    const y = summarizeYear(facts, BIR_ANNUAL_2023)
    expect(y.mweHazard).toBe(0)
    expect(y.taxableHazard).toBe(1000)
    expect(y.mweBasic).toBe(1000) // two days at the SMW
    expect(y.taxableOtherSupplementary).toBe(150)
    expect(y.totalTaxablePresent).toBe(1150)
  })
})
