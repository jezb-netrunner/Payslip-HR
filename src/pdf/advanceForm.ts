// The cash advance agreement the employee signs before the advance is
// released: wage deductions need the employee's written authorization, and
// the employer may not profit from the advance (Labor Code Art. 113 and its
// implementing rules as amended by DOLE D.O. 195-2018).
// Built-in PDF fonts have no peso sign, so amounts print as "PHP".

import { jsPDF } from 'jspdf'

export interface AdvanceFormData {
  employer: { name: string; address?: string | null; tin?: string | null }
  employee: { name: string; employeeNo: string; position?: string | null }
  amount: number
  perPayroll: number
  payrolls: number
  releasedOn: string
  firstDeduction: string
  releaseMethod: string
}

const php = (v: number) => `PHP ${v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const longDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' })

export function generateAdvanceForm(f: AdvanceFormData): void {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const margin = 20
  const width = pageW - margin * 2
  let y = 22

  doc.setTextColor(20, 20, 30)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text(f.employer.name, margin, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  const sub = [f.employer.address, f.employer.tin ? `TIN ${f.employer.tin}` : ''].filter(Boolean).join('  •  ')
  if (sub) {
    y += 5
    doc.text(doc.splitTextToSize(sub, width) as string[], margin, y)
  }

  y += 14
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text('CASH ADVANCE AGREEMENT AND AUTHORIZATION TO DEDUCT', pageW / 2, y, { align: 'center' })

  y += 12
  doc.setFontSize(10)
  const facts: [string, string][] = [
    ['Employee', `${f.employee.name} (${f.employee.employeeNo})${f.employee.position ? `, ${f.employee.position}` : ''}`],
    ['Amount advanced', php(f.amount)],
    ['Released on', `${longDate(f.releasedOn)}, by ${f.releaseMethod}`],
    ['Repayment', `${php(f.perPayroll)} per payroll, about ${f.payrolls} payroll${f.payrolls === 1 ? '' : 's'}, starting with the payroll whose cutoff includes ${longDate(f.firstDeduction)}`],
  ]
  for (const [k, v] of facts) {
    doc.setFont('helvetica', 'bold')
    doc.text(k, margin, y)
    doc.setFont('helvetica', 'normal')
    const lines = doc.splitTextToSize(v, width - 42) as string[]
    doc.text(lines, margin + 42, y)
    y += lines.length * 5 + 2
  }

  y += 4
  const terms = [
    `I acknowledge receiving the amount above from ${f.employer.name} as an advance on my wages. It carries no interest, fee or other charge.`,
    `I authorize ${f.employer.name} to deduct the installment above from my wages every payroll until the advance is fully repaid. A payroll deducts only as much as my net pay allows; any part it cannot deduct stays in the balance and is deducted from later payrolls.`,
    `If my employment ends before the advance is fully repaid, I authorize ${f.employer.name} to deduct the remaining balance from my last pay and final pay.`,
    'I may repay any part of the balance at any time. Every deduction and repayment is shown on my payslips and in my cash advance record.',
  ]
  doc.setFontSize(10)
  terms.forEach((t, i) => {
    const lines = doc.splitTextToSize(t, width - 8) as string[]
    doc.text(`${i + 1}.`, margin, y)
    doc.text(lines, margin + 8, y)
    y += lines.length * 5 + 3
  })

  y += 16
  const col = width / 2 - 6
  const sign = (x: number, label: string) => {
    doc.setDrawColor(80, 80, 90)
    doc.line(x, y, x + col, y)
    doc.setFontSize(9)
    doc.text(label, x, y + 5)
    doc.line(x, y + 18, x + col * 0.6, y + 18)
    doc.text('Date', x, y + 23)
  }
  sign(margin, `${f.employee.name} (signature over printed name)`)
  sign(margin + col + 12, 'Released by (signature over printed name)')

  y += 40
  doc.setFont('helvetica', 'italic')
  doc.setFontSize(8)
  doc.setTextColor(100, 100, 110)
  doc.text(
    doc.splitTextToSize(
      'Deductions from wages need the employee\'s written authorization, and the employer may not profit from the advance (Labor Code Art. 113 and its implementing rules, as amended by DOLE D.O. 195-2018). Keep the signed copy in the employee\'s file.',
      width,
    ) as string[],
    margin,
    y,
  )

  doc.save(`cash-advance_${f.employee.employeeNo.replace(/[^\w-]/g, '_')}_${f.releasedOn}.pdf`)
}
