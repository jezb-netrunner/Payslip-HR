// Payslip PDF generation (client-side, jsPDF + autotable): one payslip, or
// many at once — one PDF with a payslip per page, or a ZIP of single PDFs.
// Note: the built-in PDF fonts have no ₱ glyph, so amounts use "PHP".

import { zipSync } from 'fflate'
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

/** One line no wider than maxW (current font), cut with an ellipsis. */
function fitText(doc: jsPDF, text: string, maxW: number): string {
  if (doc.getTextWidth(text) <= maxW) return text
  let t = text
  while (t.length > 1 && doc.getTextWidth(`${t}…`) > maxW) t = t.slice(0, -1)
  return `${t.trimEnd()}…`
}

const newDoc = () => new jsPDF({ unit: 'mm', format: 'a4' })

/** Draws one payslip from the top of the document's current page. */
function drawPayslip(doc: jsPDF, slip: Payslip, run: PayslipRunInfo, company: PayslipCompany): void {
  const pageW = doc.internal.pageSize.getWidth()
  const margin = 14
  const snap = slip.employee_snapshot as Record<string, string>
  const employer = employerFor(slip, company)

  // ---- header ----
  doc.setFillColor(...NAVY)
  doc.rect(0, 0, pageW, 26, 'F')
  doc.setTextColor(255, 255, 255)

  // right block first: the employer's name and address get what is left
  const runLabel =
    run.run_type === 'thirteenth_month'
      ? `13th Month Pay ${run.period_end.slice(0, 4)}`
      : periodLabel(run)
  const payDate = `Pay date: ${new Date(`${run.pay_date}T00:00:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}`
  // a draft can still change: never let its printout pass for the final payslip
  const title = run.status === 'draft' ? 'DRAFT PAYSLIP' : 'PAYSLIP'
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text(title, pageW - margin, 11, { align: 'right' })
  let rightW = doc.getTextWidth(title)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.text(runLabel, pageW - margin, 16.5, { align: 'right' })
  doc.text(payDate, pageW - margin, 21.5, { align: 'right' })
  rightW = Math.max(rightW, doc.getTextWidth(runLabel), doc.getTextWidth(payDate))
  const leftW = pageW - margin * 2 - rightW - 6

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  const name = employer.name || 'Company'
  if (doc.getTextWidth(name) > leftW) doc.setFontSize(12)
  doc.text(fitText(doc, name, leftW), margin, 11)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  const sub = [employer.registered_address, employer.tin ? `TIN ${employer.tin}` : '']
    .filter(Boolean)
    .join('  •  ')
  if (sub) {
    const lines = doc.splitTextToSize(sub, leftW) as string[]
    doc.text(lines[0], margin, 16.5)
    if (lines.length > 1) doc.text(fitText(doc, lines.slice(1).join(' '), leftW), margin, 20.5)
  }

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
  const halfW = pageW / 2 - margin - 2
  infoLeft.forEach((t, i) => doc.text(fitText(doc, t, halfW), margin, y + 5.5 + i * 4.2))
  infoRight.forEach((t, i) => doc.text(fitText(doc, t, halfW), pageW / 2 + 4, y + 5.5 + i * 4.2))
  y += 21

  // ---- earnings & deductions tables side by side ----
  const colW = (pageW - margin * 2 - 6) / 2
  const earningsBody = slip.earnings.map((l) => [
    l.label + (l.hours ? ` (${l.hours}h)` : ''),
    php(l.amount),
  ])
  const deductionsBody = slip.deductions.map((l) => [l.label, php(l.amount)])
  // a long table runs onto further pages: both tables start on this page,
  // and what follows them continues after whichever ends later
  const startPage = doc.getCurrentPageInfo().pageNumber
  const tableEnd = () => ({
    page: doc.getCurrentPageInfo().pageNumber,
    y: (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY,
  })

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
  const leftEnd = tableEnd()
  doc.setPage(startPage)

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
  const rightEnd = tableEnd()
  const end =
    leftEnd.page > rightEnd.page || (leftEnd.page === rightEnd.page && leftEnd.y >= rightEnd.y) ? leftEnd : rightEnd
  doc.setPage(end.page)
  y = end.y + 7
  // the rounding note, the net pay banner and the attendance row need about 50 mm
  const pageH = doc.internal.pageSize.getHeight()
  if (y > pageH - 50) {
    doc.addPage()
    y = 20
  }

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
    `Generated ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} • Confidential` +
      (run.status === 'draft' ? ' • DRAFT: not final, may change before the payroll is finalized' : ''),
    margin,
    y + Math.max(1, note.length) * 3.6 + 1,
  )
}

/** payslip_<employee no>_<period end>.pdf */
export function payslipFileName(slip: Payslip, run: PayslipRunInfo): string {
  const no = (slip.employee_snapshot as Record<string, string>).employee_no ?? 'payslip'
  return `payslip_${no.replace(/[^\w-]/g, '_')}_${run.period_end}.pdf`
}

export function generatePayslipPdf(slip: Payslip, run: PayslipRunInfo, company: PayslipCompany): void {
  const doc = newDoc()
  drawPayslip(doc, slip, run, company)
  doc.save(payslipFileName(slip, run))
}

/** Lets the page repaint (progress text) between batches of a long export. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const BATCH = 10

/** One document holding every given payslip, each starting on its own page, in the order given. */
export async function buildPayslipsDoc(
  slips: Payslip[],
  run: PayslipRunInfo,
  company: PayslipCompany,
  onProgress?: (done: number) => void,
): Promise<jsPDF> {
  const doc = newDoc()
  for (let i = 0; i < slips.length; i++) {
    if (i > 0) doc.addPage()
    drawPayslip(doc, slips[i], run, company)
    if ((i + 1) % BATCH === 0) {
      onProgress?.(i + 1)
      await breathe()
    }
  }
  return doc
}

/** Every given payslip as its own PDF, packed in one ZIP (PDFs are compressed already: stored, not deflated). */
export async function buildPayslipsZip(
  slips: Payslip[],
  run: PayslipRunInfo,
  company: PayslipCompany,
  onProgress?: (done: number) => void,
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  for (let i = 0; i < slips.length; i++) {
    const doc = newDoc()
    drawPayslip(doc, slips[i], run, company)
    let name = payslipFileName(slips[i], run)
    for (let n = 2; files[name]; n++) name = payslipFileName(slips[i], run).replace(/\.pdf$/, `_${n}.pdf`)
    files[name] = new Uint8Array(doc.output('arraybuffer'))
    if ((i + 1) % BATCH === 0) {
      onProgress?.(i + 1)
      await breathe()
    }
  }
  return zipSync(files, { level: 0 })
}
