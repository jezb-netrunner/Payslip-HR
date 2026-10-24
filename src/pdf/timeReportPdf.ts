// Time In/Out report PDFs (client-side, jsPDF + autotable): a daily time
// record (DTR) per employee — every day of the range, totals, a
// certification and signature lines — or the whole report as one summary
// table. The built-in PDF fonts are WinAnsi only: keep every string ASCII
// or Latin-1 (timeReport.ts formats dates and times itself for that reason).

import type { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { safeDoc } from './text'
import { fmtPeriod, fmtTin, fullName, plural } from '../lib/format'
import { FREQUENCY_LABELS } from '../lib/labels'
import { manilaHHMM, todayManila } from '../lib/manila'
import { shiftShort } from '../lib/shiftText'
import {
  clock12,
  dayName,
  hoursOf,
  pairTimes,
  shortDate,
  sumTotals,
  type EmployeeTimeReport,
  type ReportTotals,
} from '../lib/timeReport'

const NAVY: [number, number, number] = [18, 45, 85]
const SLATE: [number, number, number] = [100, 116, 139]
const TEXT: [number, number, number] = [51, 65, 85]
const ROSE: [number, number, number] = [190, 18, 60]
const SHADE: [number, number, number] = [244, 246, 250]
const MARGIN = 14

export interface ReportCompany {
  name: string
  registered_address: string
  tin: string
  tin_branch_code: string
}

type AutoTableDoc = jsPDF & { lastAutoTable: { finalY: number } }

const hrs = (minutes: number) => (minutes ? hoursOf(minutes).toFixed(2) : '')

export function generatedAt(): string {
  return `${shortDate(todayManila(), true)} ${clock12(manilaHHMM(new Date().toISOString()))}`
}

/** One line no wider than maxW (current font), cut with an ellipsis. */
function fitText(doc: jsPDF, text: string, maxW: number): string {
  if (doc.getTextWidth(text) <= maxW) return text
  let t = text
  while (t.length > 1 && doc.getTextWidth(`${t}…`) > maxW) t = t.slice(0, -1)
  return `${t.trimEnd()}…`
}

/** The dark band at the top of a report's first page: employer left, title and period right. */
export function drawHeader(doc: jsPDF, company: ReportCompany, title: string, period: string): void {
  const pageW = doc.internal.pageSize.getWidth()
  doc.setFillColor(...NAVY)
  doc.rect(0, 0, pageW, 26, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text(title, pageW - MARGIN, 11, { align: 'right' })
  let rightW = doc.getTextWidth(title)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.text(period, pageW - MARGIN, 16.5, { align: 'right' })
  rightW = Math.max(rightW, doc.getTextWidth(period))
  const leftW = pageW - MARGIN * 2 - rightW - 6

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  const name = company.name || 'Company'
  if (doc.getTextWidth(name) > leftW) doc.setFontSize(12)
  doc.text(fitText(doc, name, leftW), MARGIN, 11)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  const tin = fmtTin(company.tin, company.tin_branch_code)
  const sub = [company.registered_address, tin ? `TIN ${tin}` : ''].filter(Boolean).join('  •  ')
  if (sub) doc.text(fitText(doc, sub, leftW), MARGIN, 16.5)
}

function totalsLine(t: ReportTotals): string {
  return [
    `Workdays ${t.workdays}`,
    `Days worked ${t.daysWorked}`,
    `Absences ${t.absences}`,
    `Paid leave ${t.paidLeaveDays}`,
    `Unpaid leave ${t.unpaidLeaveDays}`,
    `Late ${plural(t.lateDays, 'time')} (${t.lateMinutes} min)`,
    `Undertime ${plural(t.undertimeDays, 'time')} (${t.undertimeMinutes} min)`,
    ...(t.restDaysWorked ? [`Rest days worked ${t.restDaysWorked}`] : []),
    ...(t.holidaysWorked ? [`Holidays worked ${t.holidaysWorked}`] : []),
    ...(t.missingTimeOut ? [`Days with a time in but no time out ${t.missingTimeOut}`] : []),
  ].join('  •  ')
}

const FOOTNOTE =
  'Times are Philippine time (UTC+8); (+1) = the next day. Hours are decimal hours net of the unpaid break, computed the way payroll computes them. OT = overtime, ND = night differential (10 PM–6 AM), UT = undertime.'

/** Draws one employee's daily time record from the top of the document's current page. */
function drawDtr(doc: jsPDF, r: EmployeeTimeReport, company: ReportCompany, generated: string): void {
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const e = r.employee
  drawHeader(doc, company, 'DAILY TIME RECORD', fmtPeriod(r.from, r.to))

  // ---- employee block ----
  let y = 33
  doc.setTextColor(...NAVY)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text(fitText(doc, fullName(e), pageW - MARGIN * 2), MARGIN, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...SLATE)
  const halfW = pageW / 2 - MARGIN - 2
  const left = [`Employee No: ${e.employee_no || '—'}`, `Position: ${e.position || '—'}`, `Department: ${e.department || '—'}`]
  const right = [`Schedule: ${r.schedule}`, `Pay frequency: ${FREQUENCY_LABELS[e.pay_frequency]}`]
  left.forEach((t, i) => doc.text(fitText(doc, t, halfW), MARGIN, y + 5.5 + i * 4.2))
  right.forEach((t, i) => doc.text(fitText(doc, t, halfW), pageW / 2 + 4, y + 5.5 + i * 4.2))
  y += 20

  // ---- the days ----
  const t = r.totals
  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN, right: MARGIN, top: 14 },
    head: [['Date', 'Day', 'Shift', 'Time in', 'Time out', 'Hours', 'OT', 'ND', 'Late (min)', 'UT (min)', 'Remarks']],
    body: r.days.map((d) => {
      const times = d.pairs.map((p) => pairTimes(p))
      return [
        shortDate(d.date),
        dayName(d.date),
        d.shift ? shiftShort(d.shift) : 'Rest day',
        times.map((x) => x.timeIn).join('\n'),
        times.map((x) => x.timeOut).join('\n'),
        hrs(d.workedMinutes),
        hrs(d.otMinutes),
        hrs(d.nightDiffMinutes),
        d.lateMinutes ? String(d.lateMinutes) : '',
        d.undertimeMinutes ? String(d.undertimeMinutes) : '',
        d.remarks.join('; '),
      ]
    }),
    foot: [[
      'Total', '', '', '', '',
      hoursOf(t.workedMinutes).toFixed(2), hoursOf(t.otMinutes).toFixed(2), hoursOf(t.nightDiffMinutes).toFixed(2),
      String(t.lateMinutes), String(t.undertimeMinutes), `${plural(t.daysWorked, 'day')} worked`,
    ]],
    // the total under the whole list only, not under each page's part of it
    showFoot: 'lastPage',
    theme: 'grid',
    styles: { fontSize: 7, cellPadding: 1, textColor: TEXT, lineColor: [226, 232, 240], lineWidth: 0.1, valign: 'middle' },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7 },
    footStyles: { fillColor: [237, 242, 250], textColor: NAVY, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 12 },
      1: { cellWidth: 8 },
      2: { cellWidth: 15, fontSize: 6.5, textColor: SLATE },
      3: { cellWidth: 19 },
      4: { cellWidth: 21 },
      5: { cellWidth: 10, halign: 'right' },
      6: { cellWidth: 9, halign: 'right' },
      7: { cellWidth: 9, halign: 'right' },
      8: { cellWidth: 10, halign: 'right' },
      9: { cellWidth: 10, halign: 'right' },
    },
    didParseCell: (data) => {
      if (data.section !== 'body') return
      const d = r.days[data.row.index]
      if (!d) return
      // rest days and holidays shaded; what payroll docks or ignores in red
      if (!d.scheduled || d.holiday) data.cell.styles.fillColor = SHADE
      if (data.column.index === 10 && (d.absent || d.missingTimeOut)) data.cell.styles.textColor = ROSE
    },
  })
  y = (doc as AutoTableDoc).lastAutoTable.finalY + 6

  // ---- totals, certification, signatures (about 52 mm) ----
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  const summary = doc.splitTextToSize(totalsLine(t), pageW - MARGIN * 2) as string[]
  if (y + summary.length * 3.6 + 48 > pageH - 8) {
    doc.addPage()
    y = 20
  }
  doc.setTextColor(...TEXT)
  doc.text(summary, MARGIN, y)
  y += summary.length * 3.6 + 5

  doc.setFont('helvetica', 'italic')
  doc.text('I certify that this is a true and correct record of my time in and time out for the period shown.', MARGIN, y)
  y += 18
  const lineW = 75
  doc.setDrawColor(...SLATE)
  doc.setLineWidth(0.2)
  doc.line(MARGIN, y, MARGIN + lineW, y)
  doc.line(pageW - MARGIN - lineW, y, pageW - MARGIN, y)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...NAVY)
  doc.text(fitText(doc, fullName(e), lineW), MARGIN, y - 1.5)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(...SLATE)
  doc.text("Employee's signature over printed name / date", MARGIN, y + 4)
  doc.text('Verified by (supervisor / HR): signature over printed name / date', pageW - MARGIN - lineW, y + 4, { maxWidth: lineW })
  y += 14

  // ---- footer ----
  doc.setFontSize(7)
  doc.setFont('helvetica', 'italic')
  const foot = doc.splitTextToSize(`${FOOTNOTE} Generated ${generated}.`, pageW - MARGIN * 2) as string[]
  doc.text(foot, MARGIN, y)
}

/** Lets the page repaint (progress text) between batches of a long export. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const BATCH = 10

/** One document holding every given employee's daily time record, each starting on its own page. */
export async function buildDtrDoc(
  reports: EmployeeTimeReport[],
  company: ReportCompany,
  onProgress?: (done: number) => void,
): Promise<jsPDF> {
  const doc = safeDoc({ unit: 'mm', format: 'a4' })
  const generated = generatedAt()
  for (let i = 0; i < reports.length; i++) {
    if (i > 0) doc.addPage()
    drawDtr(doc, reports[i], company, generated)
    if ((i + 1) % BATCH === 0) {
      onProgress?.(i + 1)
      await breathe()
    }
  }
  return doc
}

/** The whole report as one table: a row per employee and the totals (landscape). */
export function buildTimeSummaryDoc(reports: EmployeeTimeReport[], company: ReportCompany, from: string, to: string): jsPDF {
  const doc = safeDoc({ unit: 'mm', format: 'a4', orientation: 'landscape' })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  drawHeader(doc, company, 'TIME IN / OUT SUMMARY', fmtPeriod(from, to))
  const figures = (t: ReportTotals) => [
    String(t.workdays), String(t.daysWorked), String(t.absences), String(t.paidLeaveDays), String(t.unpaidLeaveDays),
    hoursOf(t.workedMinutes).toFixed(2), hoursOf(t.regularMinutes).toFixed(2), hoursOf(t.otMinutes).toFixed(2),
    hoursOf(t.nightDiffMinutes).toFixed(2), `${t.lateDays} / ${t.lateMinutes}`, `${t.undertimeDays} / ${t.undertimeMinutes}`,
    String(t.restDaysWorked), String(t.holidaysWorked), String(t.missingTimeOut),
  ]
  autoTable(doc, {
    startY: 32,
    margin: { left: MARGIN, right: MARGIN, top: 14 },
    head: [[
      'Employee No', 'Employee', 'Workdays', 'Days worked', 'Absent', 'Paid leave', 'Unpaid leave', 'Hours', 'Regular',
      'OT', 'ND', 'Late (times / min)', 'UT (times / min)', 'Rest days worked', 'Holidays worked', 'No time out',
    ]],
    body: reports.map((r) => [
      r.employee.employee_no,
      fullName(r.employee) + (r.from !== from || r.to !== to ? `\n(${fmtPeriod(r.from, r.to)})` : ''),
      ...figures(r.totals),
    ]),
    foot: [['', `Total (${plural(reports.length, 'employee')})`, ...figures(sumTotals(reports))]],
    showFoot: 'lastPage',
    theme: 'grid',
    styles: { fontSize: 7.5, cellPadding: 1.3, textColor: TEXT, lineColor: [226, 232, 240], lineWidth: 0.1, halign: 'right', valign: 'middle' },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7, halign: 'right' },
    footStyles: { fillColor: [237, 242, 250], textColor: NAVY, fontStyle: 'bold' },
    columnStyles: { 0: { halign: 'left', cellWidth: 22 }, 1: { halign: 'left', cellWidth: 52 } },
    didParseCell: (data) => {
      if (data.column.index <= 1) data.cell.styles.halign = 'left'
      const r = data.section === 'body' ? reports[data.row.index] : undefined
      if (r && data.column.index === 15 && r.totals.missingTimeOut > 0) data.cell.styles.textColor = ROSE
    },
  })
  let y = (doc as AutoTableDoc).lastAutoTable.finalY + 6
  if (y > pageH - 16) {
    doc.addPage()
    y = 20
  }
  doc.setFont('helvetica', 'italic')
  doc.setFontSize(7)
  doc.setTextColor(...SLATE)
  const foot = doc.splitTextToSize(
    `${FOOTNOTE} Workdays are scheduled working days up to today, excluding holidays and rest days; an employee hired or separated within the period is reported for the days employed (shown under the name). Generated ${generatedAt()}.`,
    pageW - MARGIN * 2,
  ) as string[]
  doc.text(foot, MARGIN, y)
  return doc
}

/** File name without extension: dtr_<client>_<employee no>_<from>_<to> for one employee, dtr_<client>_<from>_<to> for several. */
export function timeReportFileName(kind: 'dtr' | 'time_summary', clientCode: string, from: string, to: string, employeeNo?: string): string {
  const safe = (v: string) => v.replace(/[^\w-]/g, '_')
  return [kind, safe(clientCode), ...(employeeNo ? [safe(employeeNo)] : []), from, to].join('_')
}
