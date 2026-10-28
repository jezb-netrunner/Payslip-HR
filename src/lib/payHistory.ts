// Display helpers for the pay-rate history (src/payroll/payRates.ts holds the rules).
import type { EmployeePayRate } from './db'
import { money } from './format'
import { todayManila } from './manila'
import { rateOn } from '../payroll/payRates'

/** "₱30,000.00 a month" / "₱700.00 a day" */
export function rateText(r: Pick<EmployeePayRate, 'pay_type' | 'rate'>): string {
  return `${money(Number(r.rate))} a ${r.pay_type === 'monthly' ? 'month' : 'day'}`
}

/** The rate in effect today and the changes dated ahead of it. */
export function currentAndUpcoming(rates: EmployeePayRate[]) {
  const today = todayManila()
  return {
    current: rateOn(rates, today),
    upcoming: rates.filter((r) => r.effective_from > today).sort((a, b) => a.effective_from.localeCompare(b.effective_from)),
  }
}
