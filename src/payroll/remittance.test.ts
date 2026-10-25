// Spec T8: a year-end refund is paid by January 25 of the next year and
// recovered from the 1601-C remittance of the month it was paid; what that
// remittance can't absorb is recovered from the following months (across
// the year end). Tax the employer paid at the year-end adjustment is
// remitted with the month's withholding.
import { describe, expect, it } from 'vitest'
import { refundDeadline, remittanceMonths, remittanceSchedule, yearRemittanceSchedule } from './remittance'

describe('T8 refunds recovered from the 1601-C remittances', () => {
  it('Y2: the refund is due by January 25 of the next year', () => {
    expect(refundDeadline(2026)).toBe('2027-01-25')
  })

  it('Y2: a 7,500 refund paid with the December payroll lowers the December 1601-C (remitted in January) by 7,500', () => {
    const [dec] = remittanceSchedule([{ month: '2026-12-01', withheld: 20000, employerPaid: 0, refunds: 7500 }])
    expect(dec).toMatchObject({ month: '2026-12-01', recovered: 7500, due: 12500, carryOut: 0 })
  })

  it('Y2: a refund larger than the month\'s tax is recovered from the following months, into the next year', () => {
    const rows = remittanceSchedule([
      { month: '2026-12-01', withheld: 5000, employerPaid: 0, refunds: 7500 },
      { month: '2027-01-01', withheld: 1000, employerPaid: 0, refunds: 0 },
      { month: '2027-02-01', withheld: 4000, employerPaid: 0, refunds: 0 },
    ])
    expect(rows.map((r) => [r.month, r.carriedIn, r.recovered, r.due, r.carryOut])).toEqual([
      ['2026-12-01', 0, 5000, 0, 2500],
      ['2027-01-01', 2500, 1000, 0, 1500],
      ['2027-02-01', 1500, 1500, 2500, 0],
    ])
  })

  it('a month with no payroll still carries the refund forward', () => {
    const rows = remittanceSchedule([
      { month: '2026-12-01', withheld: 0, employerPaid: 0, refunds: 300 },
      { month: '2027-02-01', withheld: 1000, employerPaid: 0, refunds: 0 },
    ])
    expect(rows.map((r) => [r.month, r.due, r.carryOut])).toEqual([
      ['2026-12-01', 0, 300],
      ['2027-01-01', 0, 300],
      ['2027-02-01', 700, 0],
    ])
  })

  it('a span lists every month of it, payroll or not', () => {
    const rows = remittanceSchedule([{ month: '2027-03-01', withheld: 1000, employerPaid: 0, refunds: 0 }], 0, { from: '2027-01-01', through: '2027-04-01' })
    expect(rows.map((r) => [r.month, r.due])).toEqual([
      ['2027-01-01', 0],
      ['2027-02-01', 0],
      ['2027-03-01', 1000],
      ['2027-04-01', 0],
    ])
  })

  it('a refund carried in from last year starts the schedule', () => {
    const [jan] = remittanceSchedule([{ month: '2027-01-01', withheld: 4000, employerPaid: 0, refunds: 0 }], 2500)
    expect(jan).toMatchObject({ carriedIn: 2500, recovered: 2500, due: 1500 })
  })

  it('tax the employer paid at the year-end adjustment is remitted with the month', () => {
    const [dec] = remittanceSchedule([{ month: '2026-12-01', withheld: 10000, employerPaid: 7500, refunds: 0 }])
    expect(dec.due).toBe(17500)
  })

  it('payslips by pay month: withholding, refunds and employer-paid tax apart', () => {
    const months = remittanceMonths([
      { pay_date: '2026-12-15', withholding_tax: 4000, tax_paid_by_employer: 0 },
      { pay_date: '2026-12-20', withholding_tax: 10000, tax_paid_by_employer: 7500 },
      { pay_date: '2026-12-20', withholding_tax: -7500.25, tax_paid_by_employer: 0 },
      { pay_date: '2026-11-30', withholding_tax: 1200.1, tax_paid_by_employer: null },
    ])
    expect(months).toEqual([
      { month: '2026-11-01', withheld: 1200.1, employerPaid: 0, refunds: 0 },
      { month: '2026-12-01', withheld: 14000, employerPaid: 7500, refunds: 7500.25 },
    ])
  })

  it('a tax year\'s twelve months, with last year\'s unrecovered refunds carried in', () => {
    const rows = yearRemittanceSchedule([
      { pay_date: '2026-12-20', withholding_tax: 5000, tax_paid_by_employer: 0 },
      { pay_date: '2026-12-20', withholding_tax: -7500, tax_paid_by_employer: 0 },
      { pay_date: '2027-01-30', withholding_tax: 1000, tax_paid_by_employer: 0 },
      { pay_date: '2027-02-27', withholding_tax: 4000, tax_paid_by_employer: 0 },
    ], 2027)
    expect(rows).toHaveLength(12)
    expect(rows.slice(0, 3).map((r) => [r.month, r.carriedIn, r.due])).toEqual([
      ['2027-01-01', 2500, 0],
      ['2027-02-01', 1500, 2500],
      ['2027-03-01', 0, 0],
    ])
  })
})
