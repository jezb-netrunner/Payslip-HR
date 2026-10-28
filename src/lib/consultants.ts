// Independent consultants: the employee-or-contractor checklist the client
// signs off, and the labels of the consultants pages. Misclassification is
// the main risk: whoever the client controls in the means and methods of
// the work is an employee, whatever the contract calls them (the four-fold
// test, the control test foremost — Sonza v. ABS-CBN, G.R. 138051, 2004).

import type { Consultant } from './db'
import type { EwtReason } from '../payroll/ewt'

export const CONTRACTOR_CHECKLIST: { key: string; text: string }[] = [
  { key: 'control', text: 'The consultant decides how, when and where the work is done: the client sets only the results.' },
  { key: 'results', text: 'Paid for the service or deliverables under the contract, not a salary for time worked.' },
  { key: 'tools', text: 'Works with their own tools, equipment and workplace.' },
  { key: 'others', text: 'Free to take on other clients.' },
  { key: 'no_rules', text: "Not under the client's employee rules: no fixed hours, timekeeping, leave or performance reviews." },
  { key: 'registered', text: 'Registered with the BIR as self-employed or a business, and issues invoices for the fees.' },
  { key: 'term', text: 'Engaged for a defined service or project under a written contract that ends on its terms, not by dismissal.' },
]

/** The questions answered "no": each points to an employment. */
export function checklistConcerns(checklist: Record<string, boolean>): string[] {
  return CONTRACTOR_CHECKLIST.filter((q) => checklist[q.key] === false).map((q) => q.key)
}

export function checklistComplete(checklist: Record<string, boolean>): boolean {
  return CONTRACTOR_CHECKLIST.every((q) => typeof checklist[q.key] === 'boolean')
}

export const PAYEE_TYPE_LABELS: Record<Consultant['payee_type'], string> = {
  individual: 'Individual',
  juridical: 'Firm (corporation or partnership)',
}

export const FEE_BASIS_LABELS: Record<Consultant['fee_basis'], string> = {
  retainer: 'Monthly retainer',
  per_deliverable: 'Per deliverable',
}

export const BILLING_LABELS: Record<Consultant['billing'], string> = {
  monthly: 'Once a month',
  semi_monthly: 'Twice a month',
  per_deliverable: 'On each deliverable',
}

export function ewtReasonText(reason: EwtReason, threshold: number): string {
  const t = `₱${threshold.toLocaleString('en-PH')}`
  switch (reason) {
    case 'declared_over':
      return `declared gross income above ${t} this year`
    case 'no_declaration':
      return `no sworn declaration of gross income for the year on file`
    case 'vat_registered':
      return 'VAT-registered'
    default:
      return `declared gross income of ${t} or less this year`
  }
}
