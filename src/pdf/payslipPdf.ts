// Payslip PDF generation (client-side, jsPDF + autotable).
// Note: the built-in PDF fonts have no ₱ glyph, so amounts use "PHP".

import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { Payslip } from '../lib/db'
import type { PayslipCompany, PayslipRunInfo } from '../components/PayslipView'
import { employerFor, roundingLines } from '../lib/payslip'

const NAVY: [number, number, number] = [18, 45, 85]
const ORANGE: [number, number, number] = [246, 134, 46]
const SLATE: [number, number, number] = [100, 116, 139]

function php(v: number): string {
  return (
    'PHP ' +
    (v < 0 ? '(' : '') +
    Math.abs(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
    (v < 0 ? ')' : '')
  )
}

function periodLabel(run: PayslipRunInfo): string {
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  return `${fmt(run.period_start)} – ${fmt(run.period_end)}`
}

export function generatePayslipPdf(
  slip: Payslip,
  run: PayslipRunInfo,
  company: PayslipCompany,
): void {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const margin = 14
  const snap = slip.employee_snapshot as Record<string, string>
  const employer = employerFor(slip, company)

  // ---- header ----
  doc.setFillColor(...NAVY)
  doc.rect(0, 0, pageW, 26, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(employer.name || 'Company', margin, 11)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  const sub = [employer.registered_address, employer.tin ? `TIN ${employer.tin}` : '']
    .filter(Boolean)
    .join('  •  ')
  if (sub) doc.text(sub, margin, 17)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text('PAYSLIP', pageW - margin, 11, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  const runLabel =
    run.run_type === 'thirteenth_month'
      ? `13th Month Pay ${run.period_end.slice(0, 4)}`
      : periodLabel(run)
  doc.text(runLabel, pageW - margin, 16.5, { align: 'right' })
  doc.text(
    `Pay date: ${new Date(`${run.pay_date}T00:00:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}`,
    pageW - margin,
    21.5,
    { align: 'right' },
  )

  // ---- employee block ----
  let y = 33
  doc.setTextColor(...NAVY)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text(snap.name ?? '', margin, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...SLATE)
  const infoLeft = [
    `Employee No: ${snap.employee_no ?? '—'}`,
    `Position: ${snap.position || '—'}`,
    `Department: ${snap.department || '—'}`,
  ]
  const infoRight = [
    `SSS: ${snap.sss_no || '—'}`,
    `PhilHealth: ${snap.philhealth_no || '—'}`,
    `Pag-IBIG: ${snap.pagibig_no || '—'}   TIN: ${snap.tin || '—'}`,
  ]
  infoLeft.forEach((t, i) => doc.text(t, margin, y + 5.5 + i * 4.2))
  infoRight.forEach((t, i) => doc.text(t, pageW / 2 + 4, y + 5.5 + i * 4.2))
  y += 21

  // ---- earnings & deductions tables side by side ----
  const colW = (pageW - margin * 2 - 6) / 2
  const earningsBody = slip.earnings.map((l) => [
    l.label + (l.hours ? ` (${l.hours}h)` : ''),
    php(l.amount),
  ])
  const deductionsBody = slip.deductions.map((l) => [l.label, php(l.amount)])

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin + colW + 6 },
    tableWidth: colW,
    head: [['EARNINGS', 'AMOUNT']],
    body: earningsBody.length ? earningsBody : [['—', '']],
    foot: [['Gross Pay', php(slip.gross_pay)]],
    theme: 'plain',
    styles: { fontSize: 8.5, cellPadding: 1.8, textColor: [51, 65, 85] },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
    footStyles: { fontStyle: 'bold', textColor: NAVY, lineWidth: { top: 0.3 }, lineColor: NAVY },
    columnStyles: { 1: { halign: 'right' } },
  })
  const leftEndY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY

  autoTable(doc, {
    startY: y,
    margin: { left: margin + colW + 6, right: margin },
    tableWidth: colW,
    head: [['DEDUCTIONS', 'AMOUNT']],
    body: deductionsBody.length ? deductionsBody : [['—', '']],
    foot: [['Total Deductions', php(slip.total_deductions)]],
    theme: 'plain',
    styles: { fontSize: 8.5, cellPadding: 1.8, textColor: [51, 65, 85] },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
    footStyles: { fontStyle: 'bold', textColor: NAVY, lineWidth: { top: 0.3 }, lineColor: NAVY },
    columnStyles: { 1: { halign: 'right' } },
  })
  const rightEndY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY
  y = Math.max(leftEndY, rightEndY) + 7

  // ---- cash rounding (whole-peso cash payroll) ----
  const rounding = roundingLines(slip)
  if (rounding.length > 0) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...SLATE)
    const computed = Number(slip.gross_pay) - Number(slip.total_deductions)
    doc.text(`Computed net pay ${php(computed)}`, margin, y)
    for (const l of rounding) {
      y += 4
      doc.text(`${l.label} ${l.amount > 0 ? '+' : ''}${php(l.amount)}`, margin, y)
    }
    y += 5
  }

  // ---- net pay banner ----
  doc.setFillColor(...ORANGE)
  doc.roundedRect(margin, y, pageW - margin * 2, 12, 2, 2, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.text('NET PAY', margin + 5, y + 7.5)
  doc.setFontSize(12)
  doc.text(php(slip.net_pay), pageW - margin - 5, y + 7.8, { align: 'right' })
  y += 19

  // ---- attendance + employer share ----
  if (slip.days_worked > 0 || slip.overtime_hours > 0) {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Days Worked', 'Hours', 'OT Hours', 'Night Diff Hrs', 'Late (min)', 'Undertime (min)', 'Absent Days']],
      body: [[
        String(slip.days_worked),
        String(slip.hours_worked),
        String(slip.overtime_hours),
        String(slip.night_diff_hours),
        String(slip.late_minutes),
        String(slip.undertime_minutes),
        String(slip.absent_days),
      ]],
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 1.6, halign: 'center', textColor: [51, 65, 85] },
      headStyles: { fillColor: [237, 242, 250], textColor: NAVY, fontStyle: 'bold', fontSize: 7.5 },
    })
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6
  }

  const employerTotal =
    Number(slip.sss_er) + Number(slip.sss_mpf_er) + Number(slip.sss_ec_er) +
    Number(slip.philhealth_er) + Number(slip.pagibig_er)
  if (employerTotal > 0) {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['EMPLOYER CONTRIBUTIONS (not deducted from pay)', 'SSS', 'SSS MPF', 'EC', 'PhilHealth', 'Pag-IBIG', 'Total']],
      body: [[
        '',
        php(Number(slip.sss_er)),
        php(Number(slip.sss_mpf_er)),
        php(Number(slip.sss_ec_er)),
        php(Number(slip.philhealth_er)),
        php(Number(slip.pagibig_er)),
        php(employerTotal),
      ]],
      theme: 'grid',
      styles: { fontSize: 7.5, cellPadding: 1.6, halign: 'right', textColor: [51, 65, 85] },
      headStyles: { fillColor: [237, 242, 250], textColor: NAVY, fontStyle: 'bold', fontSize: 7, halign: 'right' },
      columnStyles: { 0: { halign: 'left', cellWidth: 52 } },
    })
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8
  }

  // ---- footer ----
  doc.setFontSize(7.5)
  doc.setFont('helvetica', 'italic')
  doc.setTextColor(...SLATE)
  // the note is free text from client settings: wrap it, and start the
  // "Generated" line below however many lines it took
  const note: string[] = doc.splitTextToSize(company.payslip_footer_note ?? '', pageW - margin * 2)
  doc.text(note, margin, y)
  doc.text(
    `Generated ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} • Confidential`,
    margin,
    y + Math.max(1, note.length) * 3.6 + 1,
  )

  const fileBase = `${(snap.employee_no ?? 'payslip').replace(/[^\w-]/g, '_')}_${run.period_end}`
  doc.save(`payslip_${fileBase}.pdf`)
}
