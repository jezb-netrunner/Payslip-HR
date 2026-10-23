import { describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import type { Payslip } from '../lib/db'
import { buildPayslipsDoc, buildPayslipsZip, payslipFileName } from './payslipPdf'

const run = { run_type: 'regular' as const, period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05', status: 'finalized' as const }
const company = { name: 'Acme Trading Corporation', registered_address: 'Makati City', tin: '123-456-789-000', tin_branch_code: '000', payslip_footer_note: '' }

function slip(no: string, name: string, lines = 3): Payslip {
  return {
    employee_snapshot: { name, employee_no: no, position: 'Staff', department: '', sss_no: '', philhealth_no: '', pagibig_no: '', tin: '' },
    earnings: Array.from({ length: lines }, (_, i) => ({ label: `Earning ${i + 1}`, amount: 1000, category: 'basic' })),
    deductions: [{ label: 'SSS', amount: 500 }],
    gross_pay: 1000 * lines, total_deductions: 500, net_pay: 1000 * lines - 500,
    rounding_adjustment: 0, rounding_carry_in: 0, rounding_carry_out: 0,
    days_worked: 11, hours_worked: 88, overtime_hours: 0, night_diff_hours: 0, late_minutes: 0, undertime_minutes: 0, absent_days: 0,
    sss_er: 1000, sss_mpf_er: 0, sss_ec_er: 10, philhealth_er: 400, pagibig_er: 200,
  } as unknown as Payslip
}

describe('bulk payslip PDFs', () => {
  it('puts each payslip on its own page, in order', async () => {
    const slips = [slip('A-001', 'Ana Reyes'), slip('A-002', 'Ben Cruz'), slip('A-003', 'Cora Diaz')]
    const progress: number[] = []
    const doc = await buildPayslipsDoc(slips, run, company, (n) => progress.push(n))
    expect(doc.getNumberOfPages()).toBe(3)
    const text = doc.output()
    expect(text.indexOf('Ana Reyes')).toBeLessThan(text.indexOf('Ben Cruz'))
    expect(text.indexOf('Ben Cruz')).toBeLessThan(text.indexOf('Cora Diaz'))
    expect(progress).toEqual([])
  })

  it('a long payslip spilling onto a second page still leaves the next one its own page', async () => {
    const long = slip('A-001', 'Ana Reyes', 60)
    const alone = (await buildPayslipsDoc([long], run, company)).getNumberOfPages()
    expect(alone).toBeGreaterThan(1)
    const doc = await buildPayslipsDoc([long, slip('A-002', 'Ben Cruz')], run, company)
    expect(doc.getNumberOfPages()).toBe(alone + 1)
    // the deductions table stays on the payslip's first page, beside the start of the earnings
    const page = (n: number) => (doc.internal as unknown as { pages: string[][] }).pages[n].join('\n')
    expect(page(1)).toContain('DEDUCTIONS')
    for (let n = 2; n <= alone; n++) expect(page(n)).not.toContain('DEDUCTIONS')
    expect(page(alone + 1)).toContain('Ben Cruz')
  })

  it('zips one PDF per employee, named by employee number and period', async () => {
    const slips = Array.from({ length: 12 }, (_, i) => slip(`A-${String(i + 1).padStart(3, '0')}`, `Person ${i + 1}`))
    const progress: number[] = []
    const files = unzipSync(await buildPayslipsZip(slips, run, company, (n) => progress.push(n)))
    expect(Object.keys(files)).toHaveLength(12)
    expect(files['payslip_A-001_2026-10-31.pdf']).toBeDefined()
    expect(new TextDecoder().decode(files['payslip_A-012_2026-10-31.pdf'].slice(0, 5))).toBe('%PDF-')
    expect(progress).toEqual([10])
  })

  it('marks draft payslips as drafts', async () => {
    const draft = (await buildPayslipsDoc([slip('A-001', 'Ana Reyes')], { ...run, status: 'draft' }, company)).output()
    const final = (await buildPayslipsDoc([slip('A-001', 'Ana Reyes')], run, company)).output()
    expect(draft).toContain('DRAFT PAYSLIP')
    expect(final).not.toContain('DRAFT')
  })

  it('names files safely', () => {
    expect(payslipFileName(slip('A/01 x', 'X'), run)).toBe('payslip_A_01_x_2026-10-31.pdf')
  })
})
