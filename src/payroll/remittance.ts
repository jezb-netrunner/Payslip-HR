// BIR Form 1601-C: the tax a month's payrolls withheld, less the year-end
// refunds paid that month. A refund larger than the month's tax carries to
// the following months (crossing into the next year) until used up.
// Basis: NIRC Sec. 79(F) (refunds by 25 January); RR 2-98 Sec. 2.79(B)(5)(b)
// as amended by RR 11-2018.

import { round2 } from './types'

export interface RemittanceMonthInput {
  /** YYYY-MM-01, in order */
  month: string
  /** tax withheld by the month's payrolls (pay date), the employer-advanced shortfall included */
  withheld: number
  /** over-withheld tax refunded to employees in the month */
  refunds: number
}

export interface RemittanceMonth extends RemittanceMonthInput {
  /** refunds left from earlier months */
  carryIn: number
  toRemit: number
  /** refunds still to apply to later months */
  carryOut: number
}

export function remittances1601C(months: RemittanceMonthInput[], openingCarry = 0): RemittanceMonth[] {
  let carry = round2(openingCarry)
  return months.map((m) => {
    const due = round2(m.withheld - m.refunds - carry)
    const row = { ...m, carryIn: carry, toRemit: Math.max(0, due), carryOut: Math.max(0, round2(-due)) }
    carry = row.carryOut
    return row
  })
}
