// EWT on consultants' fees: the rate a payee is withheld at, and the
// payor's quarterly figures (1601-EQ, 2307, the alphalist of payees).
import { describe, expect, it } from 'vitest'
import { DEFAULT_EWT } from './defaults'
import { billedBefore, ewtAmount, ewtRuleFor, ewtVersionOn, form2307Rows, qapRows, quarterOf, return1601Eq, type BillingFact } from './ewt'
import { ewtDueDates, ewtYearCalendar } from './ewtDueDates'

const data = DEFAULT_EWT.data
const consultancy = data.fees.consultancy
const person = (over: Partial<{ vat_registered: boolean; fee_kind: string }> = {}) => ({
  payee_type: 'individual' as const,
  vat_registered: false,
  fee_kind: 'consultancy',
  ...over,
})
const firm = { payee_type: 'juridical' as const, vat_registered: false, fee_kind: 'consultancy' }

describe('the rate a fee is withheld at', () => {
  it('an individual: 5% only with a declaration within ₱3M, not VAT-registered, billed within ₱3M (RR 11-2018, RR 14-2018)', () => {
    const within = { over_threshold: false }
    expect(ewtRuleFor(data, person(), within, 360000)).toMatchObject({ rate: 0.05, atc: 'WI050', reason: 'declared_within' })
    expect(ewtRuleFor(data, person(), { over_threshold: true }, 1)).toMatchObject({ rate: 0.1, atc: 'WI051', reason: 'declared_over' })
    expect(ewtRuleFor(data, person(), null, 1)).toMatchObject({ rate: 0.1, reason: 'no_declaration' })
    expect(ewtRuleFor(data, person({ vat_registered: true }), within, 1)).toMatchObject({ rate: 0.1, reason: 'vat_registered' })
    // the client's own billings pass the threshold: 10% from that billing on
    expect(ewtRuleFor(data, person(), within, 3000000)?.reason).toBe('declared_within')
    expect(ewtRuleFor(data, person(), within, 3000000.01)).toMatchObject({ rate: 0.1, reason: 'billed_over' })
  })

  it('a licensed professional has its own codes at the same rates', () => {
    expect(ewtRuleFor(data, person({ fee_kind: 'professional' }), { over_threshold: false })).toMatchObject({ rate: 0.05, atc: 'WI010' })
    expect(ewtRuleFor(data, { ...firm, fee_kind: 'professional' }, { over_threshold: true })).toMatchObject({ rate: 0.15, atc: 'WC011' })
  })

  it('a firm: 10% within ₱720,000 with its declaration, else 15%; VAT registration alone changes nothing', () => {
    expect(ewtRuleFor(data, firm, { over_threshold: false }, 720000)).toMatchObject({ rate: 0.1, atc: 'WC050', threshold: consultancy.juridical.threshold })
    expect(ewtRuleFor(data, firm, { over_threshold: false }, 720000.01)).toMatchObject({ rate: 0.15, atc: 'WC051' })
    expect(ewtRuleFor(data, firm, null)).toMatchObject({ rate: 0.15, reason: 'no_declaration' })
    expect(ewtRuleFor(data, { ...firm, vat_registered: true }, { over_threshold: false })?.rate).toBe(0.1)
  })

  it('no rules for a kind of fee the table lacks', () => {
    expect(ewtRuleFor(data, person({ fee_kind: 'royalties' }), null)).toBeUndefined()
  })

  it('picks the table in force on the date and rounds the tax to the centavo', () => {
    const versions = [{ effective_from: '2018-05-01' }, { effective_from: '2030-01-01' }]
    expect(ewtVersionOn(versions, '2026-10-28')?.effective_from).toBe('2018-05-01')
    expect(ewtVersionOn(versions, '2018-04-30')).toBeUndefined()
    expect(ewtAmount(33333.33, 0.05)).toBe(1666.67)
  })

  it('counts what was billed earlier in the year, by date then entry', () => {
    const b = (id: string, billed_on: string, created_at: string, gross_amount: number, consultant_id = 'a') => ({ id, consultant_id, billed_on, created_at, gross_amount })
    const rows = [
      b('1', '2025-12-31', 't1', 999),
      b('2', '2026-01-15', 't1', 1000),
      b('3', '2026-02-15', 't2', 2000),
      b('4', '2026-02-15', 't3', 4000),
      b('5', '2026-03-15', 't1', 8000),
      b('6', '2026-01-01', 't1', 50, 'other'),
    ]
    expect(billedBefore(rows, 'a', '2026-02-15')).toBe(7000)
    expect(billedBefore(rows, 'a', '2026-02-15', '4')).toBe(3000)
    expect(billedBefore(rows, 'a', '2026-02-15', '3')).toBe(1000)
  })
})

describe('the quarter', () => {
  it('knows its months and dates', () => {
    expect(quarterOf('2026-11-15')).toEqual({ start: '2026-10-01', end: '2026-12-31', label: 'Q4 2026', months: ['2026-10', '2026-11', '2026-12'] })
    expect(quarterOf('2026-02-01').end).toBe('2026-03-31')
  })

  it('has its filing dates', () => {
    const due = ewtDueDates(quarterOf('2026-08-15'))
    expect(due.return1601eq).toBe('2026-10-31')
    expect(due.monthly[0].slice(0, 7)).toBe('2026-08')
    expect(due.monthly[1].slice(0, 7)).toBe('2026-09')
    // the year's last quarter files in the next year
    expect(ewtDueDates(quarterOf('2026-12-01')).return1601eq).toBe('2027-01-31')
  })

  it('takes the eFPS group for 0619-E, a date the client changed, and notes weekends', () => {
    const q3 = quarterOf('2026-08-15')
    const due = ewtDueDates(q3, { filing: 'efps', efpsGroup: 'C' }, [], [
      { filing: '1601eq', period: '2026-07-01', due_date: '2026-11-03', note: 'RMC 95-2026 extension' },
    ])
    expect(due.monthly).toEqual(['2026-08-13', '2026-09-13'])
    expect(due.return1601eq).toBe('2026-11-03')
    const row = due.rows.find((r) => r.filing === '1601eq')!
    expect([row.overridden, row.note]).toEqual([true, 'RMC 95-2026 extension'])
    // 13 September 2026 is a Sunday: noted, not moved
    expect(due.rows.find((r) => r.period === '2026-08-01')?.note).toBe('Falls on a Sunday')
    expect(due.form2307).toBe('2026-10-20')
  })

  it("lists a year's filings: 8 0619-E, 4 2307, 4 1601-EQ, the declarations list and the 1604-E", () => {
    const rows = ewtYearCalendar(2026, { filing: 'manual', efpsGroup: null })
    const count = (f: string) => rows.filter((r) => r.filing === f).length
    expect([count('0619e'), count('2307'), count('1601eq'), count('declarations'), count('1604e')]).toEqual([8, 4, 4, 1, 1])
    expect(rows.find((r) => r.filing === '1604e')?.due).toBe('2027-03-01')
    expect(rows.map((r) => r.due)).toEqual([...rows.map((r) => r.due)].sort())
  })
})

describe("the payor's figures", () => {
  const q3 = quarterOf('2026-07-01')
  const bill = (consultant_id: string, billed_on: string, gross: number, atc: string, rate: number): BillingFact => ({
    consultant_id,
    billed_on,
    gross_amount: gross,
    atc,
    ewt_rate: rate,
    ewt_amount: ewtAmount(gross, rate),
  })
  const billings = [
    bill('a', '2026-07-15', 30000, 'WI050', 0.05),
    bill('a', '2026-07-31', 30000, 'WI050', 0.05),
    bill('a', '2026-09-30', 30000, 'WI051', 0.1),
    bill('b', '2026-08-31', 100000, 'WC051', 0.15),
    bill('b', '2026-10-01', 100000, 'WC051', 0.15),
  ]

  it('2307: per ATC, the income of each month and the tax withheld', () => {
    expect(form2307Rows(billings.filter((b) => b.consultant_id === 'a'), q3)).toEqual([
      { atc: 'WI050', rate: 0.05, months: [60000, 0, 0], total: 60000, withheld: 3000 },
      { atc: 'WI051', rate: 0.1, months: [0, 0, 30000], total: 30000, withheld: 3000 },
    ])
  })

  it("1601-EQ: the quarter's tax by ATC, and each month's withholding (0619-E for the first two)", () => {
    const r = return1601Eq(billings, q3)
    expect(r.rows).toEqual([
      { atc: 'WC051', rate: 0.15, base: 100000, withheld: 15000 },
      { atc: 'WI050', rate: 0.05, base: 60000, withheld: 3000 },
      { atc: 'WI051', rate: 0.1, base: 30000, withheld: 3000 },
    ])
    expect(r.total).toBe(21000)
    expect(r.byMonth).toEqual([3000, 15000, 3000])
  })

  it('the alphalist of payees: a row per payee and ATC, names as the payee type has them', () => {
    const payees = [
      { id: 'a', payee_type: 'individual' as const, tin: '123-456-789', tin_branch_code: '00000', last_name: 'Santos', first_name: 'Rhea', middle_name: 'M', registered_name: '', service: 'Consultancy' },
      { id: 'b', payee_type: 'juridical' as const, tin: '987-654-321', tin_branch_code: '000', last_name: '', first_name: '', middle_name: '', registered_name: 'Abaca Advisory Inc.', service: 'Audit advisory' },
    ]
    const rows = qapRows(payees, billings, q3)
    expect(rows.map((r) => [r.seq, r.tin, r.registeredName || `${r.lastName}, ${r.firstName}`, r.atc, r.income, r.withheld])).toEqual([
      [1, '987654321', 'Abaca Advisory Inc.', 'WC051', 100000, 15000],
      [2, '123456789', 'Santos, Rhea', 'WI050', 60000, 3000],
      [3, '123456789', 'Santos, Rhea', 'WI051', 30000, 3000],
    ])
  })
})
