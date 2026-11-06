// The employee's opening balances for a tax year: what THIS employer paid and
// withheld before the client went live on the app (its payroll ran
// elsewhere). Year-end and separation annualization, the ₱90,000 exemption,
// the 13th month and the alphalist / BIR Form 2316 count them like payslips.

import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { Button, Card, Field, Input, Spinner, Textarea, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { getStatutoryTables } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { fmtDate, money } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import type { Employee, EmployeeOpeningBalance } from '../../lib/db'
import { summarizeYear, type AnnualSummary } from '../../payroll/annual'
import { blankOpening, OPENING_AMOUNT_KEYS, OPENING_EARNINGS, openingFact, openingOverlaps, type OpeningGroup } from '../../payroll/opening'
import type { BirAnnualData } from '../../payroll/types'

type AmountKey = (typeof OPENING_AMOUNT_KEYS)[number]
/** The form: amounts as typed (strings), the rest as stored. */
type Form = { paid_through: string; minimum_wage_earner: boolean; notes: string; periods_paid: string } & Record<AmountKey, string>

const GROUPS: { group: OpeningGroup; title: string; hint: string }[] = [
  { group: 'regular', title: 'Regular pay', hint: 'Gross, before contributions and tax (2316 items 39–44).' },
  { group: 'supplementary', title: 'Supplementary pay', hint: 'Taxable for everyone except the exempt pay of a minimum wage earner (items 45–51).' },
  { group: 'benefits', title: 'Benefits and non-taxable pay', hint: 'Enter the 13th month and bonuses in full: the year\'s ₱90,000 exemption is applied to them.' },
]

function toForm(o: EmployeeOpeningBalance): Form {
  const amounts = Object.fromEntries(OPENING_AMOUNT_KEYS.map((k) => [k, String(Number(o[k] ?? 0))])) as Record<AmountKey, string>
  return {
    paid_through: o.paid_through,
    minimum_wage_earner: !!o.minimum_wage_earner,
    notes: o.notes ?? '',
    periods_paid: o.periods_paid === null || o.periods_paid === undefined ? '' : String(o.periods_paid),
    ...amounts,
  }
}

function fromForm(employeeId: string, year: number, f: Form): EmployeeOpeningBalance {
  const o = blankOpening(employeeId, year, f.paid_through)
  for (const k of OPENING_AMOUNT_KEYS) o[k] = Number(f[k] || 0)
  return {
    ...o,
    minimum_wage_earner: f.minimum_wage_earner,
    notes: f.notes,
    periods_paid: f.periods_paid.trim() === '' ? null : Number(f.periods_paid),
  }
}

/** What is wrong with the form, or ''. */
function formProblem(f: Form, year: number): string {
  if (!f.paid_through) return 'Enter the last pay date the old payroll covers.'
  if (f.paid_through.slice(0, 4) !== String(year)) return `The last pay date must be in ${year}: the tax year follows the pay date.`
  for (const k of OPENING_AMOUNT_KEYS) {
    const v = Number(f[k] || 0)
    if (!Number.isFinite(v) || v < 0) return 'Amounts must be zero or more.'
    if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) return 'Amounts take at most two decimals.'
  }
  if (Number(f.thirteenth_installments || 0) > Number(f.thirteenth_month || 0)) {
    return `This year's 13th month paid in advance can't be more than the 13th month pay entered above.`
  }
  if (f.periods_paid.trim() !== '' && !/^\d{1,2}$/.test(f.periods_paid.trim())) return 'Payroll periods paid: a whole number from 0 to 60, or blank.'
  if (Number(f.periods_paid || 0) > 60) return 'Payroll periods paid: a whole number from 0 to 60, or blank.'
  return ''
}

export function OpeningBalancesCard({ employee, year }: { employee: Employee; year: number }) {
  const toast = useToast()
  // the year a row was loaded for travels with it: saving never writes one
  // year's figures under another
  const [loaded, setLoaded] = useState<{ year: number; exists: boolean; form: Form | null } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [annual, setAnnual] = useState<BirAnnualData | null>(null)
  // payslips paid on or before a "paid through" date, kept with that date
  const [overlapFor, setOverlapFor] = useState<{ date: string; dates: string[] }>({ date: '', dates: [] })

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setLoadError('')
    supabase
      .from('employee_opening_balances')
      .select('*')
      .eq('employee_id', employee.id)
      .eq('year', year)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        // a failed read is not "none yet": saving blanks would wipe the stored figures
        if (error) setLoadError(errorMessage(error, 'Failed to load'))
        else setLoaded({ year, exists: !!data, form: data ? toForm(data as EmployeeOpeningBalance) : null })
      })
    return () => {
      cancelled = true
    }
  }, [employee.id, year, reload])

  useEffect(() => {
    let cancelled = false
    getStatutoryTables(`${year}-12-31`).then(
      (t) => !cancelled && setAnnual(t.bir_annual),
      () => !cancelled && setAnnual(null),
    )
    return () => {
      cancelled = true
    }
  }, [year])

  // payslips of the app the old payroll's dates already cover
  const paidThrough = loaded?.form?.paid_through ?? ''
  useEffect(() => {
    let cancelled = false
    if (!paidThrough || paidThrough.slice(0, 4) !== String(year)) return
    supabase
      .from('payslips')
      .select('pay_date, payroll_runs!inner(status)')
      .eq('employee_id', employee.id)
      .in('payroll_runs.status', ['finalized', 'paid'])
      .gte('pay_date', `${year}-01-01`)
      .lte('pay_date', paidThrough)
      .then(({ data }) => {
        if (cancelled) return
        const dates = ((data ?? []) as { pay_date: string | null }[]).map((p) => p.pay_date)
        setOverlapFor({ date: paidThrough, dates: openingOverlaps({ paid_through: paidThrough } as EmployeeOpeningBalance, dates) })
      })
    return () => {
      cancelled = true
    }
  }, [employee.id, year, paidThrough])
  const overlaps = paidThrough && overlapFor.date === paidThrough ? overlapFor.dates : []

  const title = `Before going live on the app (${year})`
  if (loadError) {
    return (
      <Card title={title} icon={<History />} className="lg:col-span-2">
        <p className="text-sm text-rose-600">
          Couldn't load the opening balances: {loadError}{' '}
          <button type="button" onClick={() => setReload((n) => n + 1)} className="font-semibold underline">
            Try again
          </button>
        </p>
      </Card>
    )
  }
  if (!loaded || loaded.year !== year) {
    return (
      <Card title={title} icon={<History />} className="lg:col-span-2">
        <Spinner />
      </Card>
    )
  }
  const form = loaded.form
  // functional updates: a save or removal that finishes later (or after the
  // year changed) never writes back the form as it was when clicked
  const set = (k: keyof Form, v: string | boolean) =>
    setLoaded((cur) => (cur && cur.form ? { ...cur, form: { ...cur.form, [k]: v } } : cur))

  async function save() {
    if (!loaded || !loaded.form || loaded.year !== year) return
    const problem = formProblem(loaded.form, loaded.year)
    if (problem) {
      toast('error', problem)
      return
    }
    setBusy(true)
    try {
      const o = fromForm(employee.id, loaded.year, loaded.form)
      const payload: Record<string, unknown> = {
        employee_id: employee.id,
        year: loaded.year,
        paid_through: o.paid_through,
        minimum_wage_earner: o.minimum_wage_earner,
        periods_paid: o.periods_paid,
        notes: o.notes,
      }
      for (const k of OPENING_AMOUNT_KEYS) payload[k] = o[k]
      const { error } = await supabase.from('employee_opening_balances').upsert(payload, { onConflict: 'employee_id,year' })
      if (error) throw error
      const savedYear = loaded.year
      setLoaded((cur) => (cur && cur.year === savedYear ? { ...cur, exists: true } : cur))
      toast('success', `Opening balances for ${savedYear} saved. Recompute open drafts for this employee.`)
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!loaded) return
    if (!loaded.exists) {
      setLoaded((cur) => (cur ? { ...cur, form: null } : cur))
      return
    }
    if (!confirm(`Remove the ${loaded.year} opening balances? Annualization and the alphalist then count only payrolls in the app.`)) return
    setBusy(true)
    try {
      const { error } = await supabase.from('employee_opening_balances').delete().eq('employee_id', employee.id).eq('year', loaded.year)
      if (error) throw error
      const removedYear = loaded.year
      setLoaded((cur) => (cur && cur.year === removedYear ? { year: removedYear, exists: false, form: null } : cur))
      toast('success', `Opening balances for ${removedYear} removed.`)
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  if (!form) {
    return (
      <Card title={title} icon={<History />} className="lg:col-span-2">
        <p className="text-sm text-slate-600">
          If this client ran its payroll elsewhere earlier in {year}, enter what it paid and withheld for this employee
          before going live. Year-end and separation annualization, the 13th month, the ₱90,000 exemption and the
          alphalist / BIR Form 2316 then count the whole year with this employer. Not for a previous employer (use the
          section above).
        </p>
        <Button
          className="mt-4"
          variant="secondary"
          onClick={() =>
            setLoaded({
              ...loaded,
              form: toForm({ ...blankOpening(employee.id, year, ''), minimum_wage_earner: employee.is_minimum_wage_earner }),
            })
          }
        >
          Add opening balances
        </Button>
      </Card>
    )
  }

  const problem = formProblem(form, year)
  let summary: AnnualSummary | null = null
  if (annual && !problem) summary = summarizeYear([openingFact(fromForm(employee.id, year, form), { hazardCertified: !!employee.hazard_certification_ref })], annual)
  const hiredAfter = !!form.paid_through && employee.hire_date > form.paid_through
  const amount = (k: AmountKey, label: string, hint?: string) => (
    <Field key={k} label={label} hint={hint}>
      <Input type="number" inputMode="decimal" step="0.01" min="0" value={form[k]} onChange={(e) => set(k, e.target.value)} />
    </Field>
  )

  return (
    <Card title={title} icon={<History />} className="lg:col-span-2">
      <p className="text-sm text-slate-600">
        This employer's pay to {employee.first_name} from 1 January, released by the old payroll, as its payroll register
        totals it. Pay released after the last pay date below is paid in the app.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Last pay date the old payroll covers" hint={`Pay released on or before this date. Must be in ${year}.`}>
          <Input type="date" min={`${year}-01-01`} max={`${year}-12-31`} value={form.paid_through} onChange={(e) => set('paid_through', e.target.value)} />
        </Field>
        <div className="flex items-end pb-2 lg:col-span-2">
          <Toggle
            checked={form.minimum_wage_earner}
            onChange={(v) => set('minimum_wage_earner', v)}
            label="Paid as a minimum wage earner (SMW, holiday, overtime, night differential and hazard pay exempt)"
          />
        </div>
      </div>
      {overlaps.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Payrolls in the app were already paid on {overlaps.map((d) => fmtDate(d)).join(', ')} — on or before this date.
          Their pay and tax would be counted twice: move the date before them, or leave their amounts out here.
        </p>
      )}
      {hiredAfter && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {employee.first_name} was hired on {fmtDate(employee.hire_date)}, after this date: check the dates.
        </p>
      )}
      {GROUPS.map((g) => (
        <div key={g.group} className="mt-5">
          <h4 className="text-sm font-semibold text-ink-900">{g.title}</h4>
          <p className="text-xs text-slate-500">{g.hint}</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {OPENING_EARNINGS.filter((f) => f.group === g.group).map((f) => amount(f.key, f.label))}
          </div>
        </div>
      ))}
      <div className="mt-5">
        <h4 className="text-sm font-semibold text-ink-900">Deductions, tax and the 13th month</h4>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {amount('contributions', 'Employee SSS, PhilHealth, Pag-IBIG & union dues', 'The employee shares only; they come out of basic salary.')}
          {amount('tax_withheld', 'Tax withheld', 'As adjusted: net of any refund the old payroll paid.')}
          <Field
            label="Basic salary earned, for the 13th month"
            hint="From 1 January (PD 851): basic salary less absences and lateness, no overtime or premiums."
          >
            <div className="flex gap-2">
              <Input type="number" inputMode="decimal" step="0.01" min="0" value={form.thirteenth_basis} onChange={(e) => set('thirteenth_basis', e.target.value)} />
              <Button variant="secondary" size="sm" onClick={() => set('thirteenth_basis', form.basic_salary)} title="Copy the basic salary">
                = Basic
              </Button>
            </div>
          </Field>
          {amount(
            'thirteenth_installments',
            `Of the 13th month above: ${year}'s paid in advance`,
            "A mid-year half, say: this year's 13th month run deducts it. Leave 0 for last year's 13th month paid in January.",
          )}
          <Field
            label={`Payroll periods the old payroll paid in ${year}`}
            hint="Count a December period paid in January. Blank = counted from 1 January (or the hire date)."
          >
            <Input type="number" inputMode="numeric" step="1" min="0" max="60" value={form.periods_paid} onChange={(e) => set('periods_paid', e.target.value)} />
          </Field>
        </div>
        {Number(form.basic_salary || 0) > 0 && Number(form.thirteenth_basis || 0) === 0 && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            No basic salary earned is entered for the 13th month: the 13th month will count only the pay in the app. Use
            "= Basic" if the basic salary above is all earned basic pay.
          </p>
        )}
      </div>
      <Field label="Notes" className="mt-4">
        <Textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Source, e.g. the old payroll register Jan–Sep" />
      </Field>
      {summary && (
        <dl className="mt-4 grid gap-x-6 gap-y-1 rounded-lg bg-slate-50 px-4 py-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs text-slate-500">Gross pay</dt><dd className="font-semibold">{money(summary.gross)}</dd></div>
          <div><dt className="text-xs text-slate-500">Non-taxable / exempt</dt><dd className="font-semibold">{money(summary.totalNonTaxable)}</dd></div>
          <div><dt className="text-xs text-slate-500">Taxable</dt><dd className="font-semibold">{money(summary.totalTaxablePresent)}</dd></div>
          <div><dt className="text-xs text-slate-500">Tax withheld</dt><dd className="font-semibold">{money(Number(form.tax_withheld || 0))}</dd></div>
        </dl>
      )}
      {problem && <p className="mt-3 text-sm text-rose-600">{problem}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button disabled={busy || !!problem} onClick={save}>{busy ? 'Saving…' : 'Save opening balances'}</Button>
        <Button variant="ghost" disabled={busy} onClick={remove}>{loaded.exists ? 'Remove' : 'Cancel'}</Button>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Counted in annualization (December or separation), the cumulative average method, the 13th month, the ₱90,000
        exemption, and the alphalist / 2316 as this employer's pay. Not in the monthly 1601-C figures (the old payroll
        remitted those months) or the de minimis ceilings per benefit. A change sends this employee's open drafts back
        for recompute; a payroll already annualized keeps its tax until voided and reissued.
      </p>
    </Card>
  )
}
