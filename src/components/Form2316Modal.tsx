// BIR Form 2316 figures for one employee and tax year (from the alphalist
// row): issued by January 31 of the next year, or at final pay for an
// employee who leaves (spec T8).
import { Printer } from 'lucide-react'
import { Button, Modal } from './ui'
import type { Entity } from '../lib/db'
import { fmtDate, fmtTin, fullName, money } from '../lib/format'
import type { AlphalistRow } from '../payroll/alphalist'

export default function Form2316Modal({ row, entity, year, onClose }: { row: AlphalistRow; entity: Entity; year: number; onClose: () => void }) {
  const s = row.summary
  const e = row.employee
  const groups: [string, [string, number | string][]][] = [
    [
      'Part IV-A — Summary',
      [
        ['Gross compensation income from present employer', s.gross],
        ['Less: total non-taxable / exempt compensation (present employer)', s.totalNonTaxable],
        ['Taxable compensation income from present employer', s.totalTaxablePresent],
        ['Add: taxable compensation income from previous employer', s.prevTaxable],
        ['Gross taxable compensation income', s.totalTaxable],
        ['Tax due', s.taxDue],
        ['Taxes withheld — present employer (as adjusted)', s.withheldAsAdjusted],
        // the shortfall the year-end pay couldn't cover: the employer paid it for the employee (spec T8)
        ...(s.paidByEmployer > 0 ? ([['Of which paid by the employer at the year-end adjustment (an advance to the employee)', s.paidByEmployer]] as [string, number][]) : []),
        ['Taxes withheld — previous employer', s.prevTaxWithheld],
        ['Total amount of taxes withheld as adjusted', s.withheldAsAdjusted + s.prevTaxWithheld],
        ['5% tax credit (PERA Act of 2008)', s.peraCredit],
        ['Total taxes withheld', s.withheldAsAdjusted + s.prevTaxWithheld + s.peraCredit],
      ],
    ],
    [
      'Part IV-B — Non-taxable / exempt compensation',
      [
        ['Basic salary / statutory minimum wage (MWE)', s.mweBasic],
        ['Holiday pay (MWE)', s.mweHoliday],
        ['Overtime pay (MWE)', s.mweOvertime],
        ['Night shift differential (MWE)', s.mweNightDiff],
        ['Hazard pay (MWE)', s.mweHazard],
        ['13th month pay and other benefits', s.thirteenthOtherBenefitsExempt],
        ['De minimis benefits', s.deMinimis],
        ['SSS, GSIS, PHIC & Pag-IBIG contributions and union dues (employee share)', s.contributions],
        ['Salaries and other forms of compensation', s.otherNonTaxable],
        ['Total non-taxable / exempt compensation', s.totalNonTaxable],
      ],
    ],
    [
      'Part IV-B — Taxable compensation',
      [
        ['Basic salary', s.taxableBasic],
        ['Representation', s.taxableRepresentation],
        ['Transportation', s.taxableTransportation],
        ['Cost of living allowance (COLA)', s.taxableCola],
        ['Fixed housing allowance', s.taxableHousing],
        ['Others (regular)', s.taxableOtherRegular],
        ['Taxable 13th month benefits and other benefits', s.taxable13thOtherBenefits],
        ['Hazard pay', s.taxableHazard],
        ['Overtime pay', s.taxableOvertime],
        ['Others (supplementary: holiday/premium pay, night differential)', s.taxableOtherSupplementary],
        ['Total taxable compensation (present employer)', s.totalTaxablePresent],
      ],
    ],
  ]

  function print() {
    const w = window.open('', '_blank', 'width=760,height=900')
    if (!w) return
    const esc = (v: string) =>
      v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
    const val = (v: number | string) => (typeof v === 'number' ? v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : esc(v))
    const sections = groups
      .map(
        ([title, items]) =>
          `<h3 style="margin:18px 0 6px;font-size:13px">${esc(title)}</h3><table style="width:100%;border-collapse:collapse;font-size:12px">${items
            .map(([k, v]) => `<tr><td style="padding:3px 0;border-bottom:1px solid #e2e8f0">${esc(k)}</td><td style="text-align:right;border-bottom:1px solid #e2e8f0">${val(v)}</td></tr>`)
            .join('')}</table>`,
      )
      .join('')
    w.document.write(
      `<html><head><title>BIR 2316 data — ${esc(fullName(e))}</title></head><body style="font-family:sans-serif;padding:24px;color:#0f172a">
      <h2 style="margin:0">BIR Form 2316 figures — ${year}</h2>
      <p style="font-size:12px;color:#475569">Working figures for the official BIR Form 2316 (Certificate of Compensation Payment / Tax Withheld).</p>
      <p style="font-size:12px"><b>Employee:</b> ${esc(`${e.last_name}, ${e.first_name} ${e.middle_name ?? ''}`)} · TIN ${esc(e.tin ?? '—')} · Born ${esc(e.birth_date ?? '—')}<br/>
      <b>Address:</b> ${esc(e.address ?? '—')} ${esc(e.zip_code ?? '')} · <b>Period:</b> ${esc(row.from)} to ${esc(row.to)}${row.schedule === 2 ? ` · <b>MWE</b> ${esc(row.region)} SMW ₱${val(row.smwPerDay)}/day` : ''}<br/>
      <b>Employer:</b> ${esc(entity.name)} · TIN ${esc(fmtTin(entity.tin, entity.tin_branch_code))} · ${esc(entity.registered_address)} ${esc(entity.zip_code)}
      ${row.prevEmployerTin ? `<br/><b>Previous employer:</b> ${esc(row.prevEmployerName)} · TIN ${esc(row.prevEmployerTin)}` : ''}</p>
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
        {groups.map(([title, items]) => (
          <div key={title}>
            <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">{title}</p>
            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 px-4">
              {items.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 py-1.5 text-sm">
                  <span className="text-slate-600">{k}</span>
                  <span className="font-semibold text-slate-800">{typeof v === 'number' ? money(v) : v}</span>
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
