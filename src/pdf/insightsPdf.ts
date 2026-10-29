// A management report as a PDF: the header band, the key figures, what
// stands out, and every table of the report (the charts' numbers are in the
// tables). The built-in fonts are WinAnsi: the peso sign prints as "PHP".

import type { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { cellText, type Report } from '../lib/insights'
import { pdfText, safeDoc } from './text'
import { drawHeader, generatedLine, type ReportCompany } from './timeReportPdf'
import type { ReportStamp } from '../lib/reportStamp'

const NAVY: [number, number, number] = [18, 45, 85]
const TEXT: [number, number, number] = [51, 65, 85]
const SLATE: [number, number, number] = [100, 116, 139]
const MARGIN = 14

type AutoTableDoc = jsPDF & { lastAutoTable: { finalY: number } }

export function generateInsightsPdf(company: ReportCompany, title: string, period: string, report: Report, stamp?: ReportStamp): void {
  const wide = report.tables.some((t) => t.columns.length > 7)
  const doc = safeDoc({ unit: 'mm', format: 'a4', orientation: wide ? 'landscape' : 'portrait' })
  const pageW = doc.internal.pageSize.getWidth()
  drawHeader(doc, company, pdfText(title), pdfText(period))
  let y = 34

  // key figures, two to a row
  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    body: report.kpis.map((k) => [pdfText(k.label), pdfText(k.value), pdfText(k.sub ?? '')]),
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 1.2, textColor: TEXT },
    columnStyles: { 0: { cellWidth: 52 }, 1: { fontStyle: 'bold', textColor: NAVY, cellWidth: 48 } },
  })
  y = (doc as AutoTableDoc).lastAutoTable.finalY + 6

  if (report.insights.length) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...NAVY)
    doc.text('What stands out', MARGIN, y)
    y += 5
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(...TEXT)
    for (const i of report.insights) {
      const lines = doc.splitTextToSize(pdfText(i.text), pageW - MARGIN * 2 - 6) as string[]
      if (y + lines.length * 4 > doc.internal.pageSize.getHeight() - 16) {
        doc.addPage()
        y = 16
      }
      doc.text(i.tone === 'warn' ? '!' : '•', MARGIN + 1, y)
      doc.text(lines, MARGIN + 6, y)
      y += lines.length * 4 + 1.5
    }
    y += 3
  }

  for (const t of report.tables) {
    if (y > doc.internal.pageSize.getHeight() - 30) {
      doc.addPage()
      y = 16
    }
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...NAVY)
    doc.text(pdfText(t.title), MARGIN, y)
    y += 2
    const numeric = (k: string) => t.columns.find((c) => c.key === k)?.kind !== 'text'
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN, top: 14 },
      head: [t.columns.map((c) => pdfText(c.label))],
      body: t.rows.length
        ? t.rows.map((r) => t.columns.map((c) => pdfText(cellText(r[c.key], c.kind))))
        : [[{ content: pdfText(t.empty ?? 'Nothing to show.'), colSpan: t.columns.length, styles: { textColor: SLATE, halign: 'left' } }]],
      foot: t.total ? [t.columns.map((c) => pdfText(cellText(t.total![c.key], c.kind)))] : undefined,
      showFoot: 'lastPage',
      theme: 'grid',
      styles: { fontSize: 7.5, cellPadding: 1.2, textColor: TEXT, lineColor: [226, 232, 240], lineWidth: 0.1, valign: 'middle' },
      headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: 'bold' },
      footStyles: { fillColor: [237, 242, 250], textColor: NAVY, fontStyle: 'bold' },
      columnStyles: Object.fromEntries(t.columns.map((c, i) => [i, numeric(c.key) ? { halign: 'right' as const } : {}])),
    })
    y = (doc as AutoTableDoc).lastAutoTable.finalY + 8
  }

  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...SLATE)
    const h = doc.internal.pageSize.getHeight()
    // a long name wraps upward, never toward the page edge
    const foot = doc.splitTextToSize(`${generatedLine(stamp)} • from finalized payroll and HR records`, pageW - MARGIN * 2 - 24) as string[]
    doc.text(foot, MARGIN, h - 7 - (foot.length - 1) * 3)
    doc.text(`Page ${p} of ${pages}`, pageW - MARGIN, h - 7, { align: 'right' })
  }
  doc.save(`${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${period.replace(/[^\w]+/g, '-')}.pdf`)
}
