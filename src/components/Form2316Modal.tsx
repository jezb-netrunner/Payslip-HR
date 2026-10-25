// BIR Form 2316 figures for one employee and tax year (from the alphalist
// row): issued by January 31 of the next year, or at final pay for an
// employee who leaves (spec T8, T10). The layout follows the form's parts:
// a minimum wage earner's exempt pay apart from taxable compensation, and
// the previous employer's data.
import { Printer } from 'lucide-react'
import { Button, Modal } from './ui'
import type { Entity } from '../lib/db'
import { fmtDate, fullName, money } from '../lib/format'
import type { AlphalistRow } from '../payroll/alphalist'
import { form2316Parts } from '../payroll/form2316'

export default function Form2316Modal({ row, entity, year, onClose }: { row: AlphalistRow; entity: Entity; year: number; onClose: () => void }) {
  const e = row.employee
  const parts = form2316Parts(row, entity, year)

  function print() {
    const w = window.open('', '_blank', 'width=760,height=900')
    if (!w) return
    const esc = (v: string) =>
      v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
    const val = (v: number | string) => (typeof v === 'number' ? v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : esc(v))
    const sections = parts
      .map(
        (p) =>
          `<h3 style="margin:18px 0 6px;font-size:13px">${esc(p.title)}</h3><table style="width:100%;border-collapse:collapse;font-size:12px">${p.lines
            .map(
              (l) =>
                `<tr><td style="padding:3px 0;border-bottom:1px solid #e2e8f0${l.total ? ';font-weight:bold' : ''}">${esc(l.label)}</td><td style="text-align:right;border-bottom:1px solid #e2e8f0${l.total ? ';font-weight:bold' : ''}">${val(l.value)}</td></tr>`,
            )
            .join('')}</table>`,
      )
      .join('')
    w.document.write(
      `<html><head><title>BIR 2316 data — ${esc(fullName(e))}</title></head><body style="font-family:sans-serif;padding:24px;color:#0f172a">
      <h2 style="margin:0">BIR Form 2316 figures — ${year}</h2>
      <p style="font-size:12px;color:#475569">Working figures for the official BIR Form 2316 (Certificate of Compensation Payment / Tax Withheld, January 2018 ENCS).</p>
      ${sections}</body></html>`,
    )
    w.document.close()
    w.print()
  }

  return (
    <Modal open onClose={onClose} title={`BIR 2316 figures — ${fullName(e)} (${year})`} wide>
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          {e.last_name}, {e.first_name} · TIN {e.tin || '—'} · {fmtDate(row.from)} – {fmtDate(row.to)}
          {row.schedule === 2 && ` · MWE (${row.region}) ₱${row.smwPerDay}/day × ${row.factor} days`}
        </p>
        {parts.map((p) => (
          <div key={p.title}>
            <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">{p.title}</p>
            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 px-4">
              {p.lines.map((l) => (
                <div key={l.label} className="flex justify-between gap-4 py-1.5 text-sm">
                  <span className={l.total ? 'font-semibold text-slate-800' : 'text-slate-600'}>{l.label}</span>
                  <span className="shrink-0 font-semibold text-slate-800">{typeof l.value === 'number' ? money(l.value) : l.value || '—'}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        <Button variant="secondary" onClick={print}>
          <Printer className="size-4" /> Print
        </Button>
      </div>
    </Modal>
  )
}
