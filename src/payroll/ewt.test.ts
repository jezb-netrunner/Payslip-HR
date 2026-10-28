// EWT on consultants' fees: the rate a payee is withheld at, and the
// payor's quarterly figures (1601-EQ, 2307, the alphalist of payees).
import { describe, expect, it } from 'vitest'
import { DEFAULT_EWT } from './defaults'
import { ewtAmount, ewtRuleFor, ewtVersionOn, form2307Rows, qapRows, quarterOf, return1601Eq, type BillingFact } from './ewt'
import { ewtDueDates } from './ewtDueDates'

const data = DEFAULT_EWT.data
const ind = data.professional_fees.individual
const jur = data.professional_fees.juridical

describe('the rate a fee is withheld at', () => {
  it('an individual: the lower rate only on a declaration within the threshold', () => {
    const within = { over_threshold: false }
    expect(ewtRuleFor(data, { payee_type: 'individual', vat_registered: false }, within)).toMatchObject({ ...ind.within, reason: 'declared_within' })
    expect(ewtRuleFor(data, { payee_type: 'individual', vat_registered: false }, { over_threshold: true })).toMatchObject({ ...ind.above, reason: 'declared_over' })
    expect(ewtRuleFor(data, { payee_type: 'individual', vat_registered: false }, null).reason).toBe(ind.no_declaration_above ? 'no_declaration' : 'declared_within')
    expect(ewtRuleFor(data, { payee_type: 'individual', vat_registered: true }, within).reason).toBe(ind.vat_registered_above ? 'vat_registered' : 'declared_within')
  })

  it('a firm: its own threshold and rates', () => {
    expect(ewtRuleFor(data, { payee_type: 'juridical', vat_registered: false }, { over_threshold: false })).toMatchObject({ ...jur.within, threshold: jur.threshold })
    expect(ewtRuleFor(data, { payee_type: 'juridical', vat_registered: false }, { over_threshold: true })).toMatchObject(jur.above)
  })

  it('picks the table in force on the date and rounds the tax to the centavo', () => {
    const versions = [{ effective_from: '2018-01-01' }, { effective_from: '2030-01-01' }]
    expect(ewtVersionOn(versions, '2026-10-28')?.effective_from).toBe('2018-01-01')
    expect(ewtVersionOn(versions, '2017-12-31')).toBeUndefined()
    expect(ewtAmount(33333.33, 0.05)).toBe(1666.67)
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
    bill('a', '2026-07-15', 30000, 'WI010', 0.05),
    bill('a', '2026-07-31', 30000, 'WI010', 0.05),
    bill('a', '2026-09-30', 30000, 'WI011', 0.1),
    bill('b', '2026-08-31', 100000, 'WC011', 0.15),
    bill('b', '2026-10-01', 100000, 'WC011', 0.15),
  ]

  it('2307: per ATC, the income of each month and the tax withheld', () => {
    expect(form2307Rows(billings.filter((b) => b.consultant_id === 'a'), q3)).toEqual([
      { atc: 'WI010', rate: 0.05, months: [60000, 0, 0], total: 60000, withheld: 3000 },
      { atc: 'WI011', rate: 0.1, months: [0, 0, 30000], total: 30000, withheld: 3000 },
    ])
  })

  it("1601-EQ: the quarter's tax by ATC, and each month's withholding (0619-E for the first two)", () => {
    const r = return1601Eq(billings, q3)
    expect(r.rows).toEqual([
      { atc: 'WC011', rate: 0.15, base: 100000, withheld: 15000 },
      { atc: 'WI010', rate: 0.05, base: 60000, withheld: 3000 },
      { atc: 'WI011', rate: 0.1, base: 30000, withheld: 3000 },
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
      [1, '987654321', 'Abaca Advisory Inc.', 'WC011', 100000, 15000],
      [2, '123456789', 'Santos, Rhea', 'WI010', 60000, 3000],
      [3, '123456789', 'Santos, Rhea', 'WI011', 30000, 3000],
    ])
  })
})
