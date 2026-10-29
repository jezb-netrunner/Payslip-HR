import { useEffect, useState } from 'react'
import { Banknote, Building2, Coins, FileText, Hash, Scale, SlidersHorizontal } from 'lucide-react'
import { Button, Card, Field, Input, NoClient, PageHeader, Select, Textarea, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { useAuth } from '../../lib/auth'
import type { Entity } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { CONTRIBUTION_TIMING_LABELS, FREQUENCY_LABELS, PH_REGIONS, ROUNDING_LABELS } from '../../lib/labels'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errors'
import { splitClientTin } from '../../lib/format'
import { holidayPayExemptProblem } from '../../payroll/engine'
import { HOURS } from '../../payroll/law'

export default function Settings() {
  const { entity, reload } = useEntity()
  const { isCompanyAdmin } = useAuth()
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  return <SettingsForm key={entity.id} initial={entity} onSaved={reload} />
}

/** Mirrors the entities CHECK constraints so the admin gets a plain message. */
function settingsRangeProblem(s: Entity): string | null {
  const n = (v: unknown) => Number(v)
  const int = (v: unknown) => Number.isInteger(Number(v))
  if (!(n(s.minimum_wage_daily) >= 0)) return 'Minimum wage cannot be negative.'
  if (!(n(s.working_days_divisor) > 0 && n(s.working_days_divisor) <= 366)) return 'Days-per-year factor must be between 1 and 366.'
  // normal hours of work are 8 a day at most (Labor Code Art. 83); longer days are compressed-workweek shifts
  if (!(n(s.standard_hours_per_day) > 0 && n(s.standard_hours_per_day) <= HOURS.normalHoursPerDay.value))
    return `Standard hours per day must be above 0 and at most ${HOURS.normalHoursPerDay.value} (Labor Code Art. 83).`
  if (!int(s.grace_period_minutes) || n(s.grace_period_minutes) < 0 || n(s.grace_period_minutes) > 240)
    return 'Grace period must be a whole number of minutes, 0–240.'
  if (!(n(s.night_diff_rate) >= HOURS.nightDifferentialMinimum.value && n(s.night_diff_rate) <= 1))
    return 'Night differential rate must be at least 0.10 (Labor Code Art. 86) and at most 1.'
  if (!int(s.pay_date_lag_days) || n(s.pay_date_lag_days) < 0 || n(s.pay_date_lag_days) > 31)
    return 'Days from period end to pay date must be a whole number, 0–31.'
  if (!(n(s.paid_vl_days_per_year) >= 0 && n(s.paid_vl_days_per_year) <= 365)) return 'Paid vacation leave days must be between 0 and 365.'
  if (s.maternity_differential_exempt && (!s.dole_exemption_ref.trim() || !s.dole_exemption_valid_until))
    return "A DOLE exemption from the maternity salary differential needs the exemption's reference and the date it is valid until."
  if (s.bir_filing_method === 'efps' && !s.efps_group) return 'Pick the eFPS group (A to E): it sets the 1601-C due date.'
  const pagibigDay = s.pagibig_due_day === null || String(s.pagibig_due_day) === '' ? null : n(s.pagibig_due_day)
  if (pagibigDay !== null && !(int(pagibigDay) && pagibigDay >= 1 && pagibigDay <= 31)) return 'The Pag-IBIG due day must be a day of the month, 1–31.'
  const workers = s.regular_workers === null || String(s.regular_workers) === '' ? null : n(s.regular_workers)
  if (workers !== null && !(int(workers) && workers >= 0)) return 'Workers regularly employed must be a whole number.'
  if (s.holiday_pay_exempt) {
    const problem = holidayPayExemptProblem({ retailOrService: s.retail_service_establishment, regularWorkers: workers })
    if (problem) return problem
  }
  return null
}

function SettingsForm({ initial, onSaved }: { initial: Entity; onSaved: () => Promise<void> }) {
  const toast = useToast()
  const [s, setS] = useState<Entity>(initial)
  const [busy, setBusy] = useState(false)
  useEffect(() => setS(initial), [initial])

  const set = <K extends keyof Entity>(k: K, v: Entity[K]) => setS({ ...s, [k]: v })

  async function save() {
    const tin = splitClientTin(s.tin, s.tin_branch_code)
    const problem = !s.name.trim()
      ? 'Registered name is required.'
      : !tin
        ? 'TIN: 9 digits (000-000-000); branch code: 3–5 digits (e.g. 00000).'
        : settingsRangeProblem(s)
    if (problem || !tin) {
      toast('error', problem ?? 'Check the TIN.')
      return
    }
    setBusy(true)
    try {
      const { error } = await supabase
        .from('entities')
        .update({
          name: s.name.trim(),
          trade_name: s.trade_name,
          tin: tin.tin,
          tin_branch_code: tin.branch,
          vat_registered: s.vat_registered,
          rdo_code: s.rdo_code,
          registered_address: s.registered_address,
          zip_code: s.zip_code,
          contact_number: s.contact_number,
          contact_email: s.contact_email,
          withholding_agent_category: s.withholding_agent_category,
          is_top_withholding_agent: s.is_top_withholding_agent,
          sss_employer_no: s.sss_employer_no,
          philhealth_employer_no: s.philhealth_employer_no,
          pagibig_employer_no: s.pagibig_employer_no,
          default_pay_frequency: s.default_pay_frequency,
          minimum_wage_region: s.minimum_wage_region,
          minimum_wage_daily: Number(s.minimum_wage_daily),
          minimum_wage_reference: s.minimum_wage_reference,
          standard_hours_per_day: Number(s.standard_hours_per_day),
          working_days_divisor: Number(s.working_days_divisor),
          grace_period_minutes: Number(s.grace_period_minutes),
          night_diff_rate: Number(s.night_diff_rate),
          contribution_deduction_timing: s.contribution_deduction_timing,
          net_pay_rounding: s.net_pay_rounding,
          rounding_scope: s.rounding_scope,
          pay_date_lag_days: Number(s.pay_date_lag_days),
          payslip_footer_note: s.payslip_footer_note,
          mwe_rh_restday_premium_taxable: s.mwe_rh_restday_premium_taxable,
          paid_vl_days_per_year: Number(s.paid_vl_days_per_year),
          sil_conversion_taxable: s.sil_conversion_taxable,
          sss_include_13th_month: s.sss_include_13th_month,
          maternity_differential_exempt: s.maternity_differential_exempt,
          dole_exemption_ref: s.maternity_differential_exempt ? s.dole_exemption_ref.trim() : '',
          dole_exemption_valid_until: s.maternity_differential_exempt ? s.dole_exemption_valid_until || null : null,
          holiday_absence_rule: s.holiday_absence_rule,
          retail_service_establishment: s.retail_service_establishment,
          regular_workers: s.regular_workers === null || String(s.regular_workers) === '' ? null : Number(s.regular_workers),
          holiday_pay_exempt: s.holiday_pay_exempt,
          bir_filing_method: s.bir_filing_method,
          efps_group: s.bir_filing_method === 'efps' ? s.efps_group : null,
          pagibig_due_day: s.pagibig_due_day === null || String(s.pagibig_due_day) === '' ? null : Number(s.pagibig_due_day),
        })
        .eq('id', s.id)
      if (error) throw error
      toast('success', 'Settings saved (audit-logged).')
      await onSaved()
    } catch (err) {
      toast('error', errorMessage(err, 'Save failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Client Settings"
        subtitle={
          <>
            {s.name} · client code <span className="font-mono font-semibold">{s.code}</span> (prefix of employee login codes)
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Employer identity (BIR withholding agent)" icon={<Building2 />}>
          <div className="space-y-3">
            <Field label="Registered name">
              <Input value={s.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Trade / business name">
              <Input value={s.trade_name} onChange={(e) => set('trade_name', e.target.value)} />
            </Field>
            <Field label="Registered address">
              <Textarea rows={2} value={s.registered_address} onChange={(e) => set('registered_address', e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="TIN" className="col-span-2">
                <Input value={s.tin} placeholder="000-000-000" onChange={(e) => set('tin', e.target.value)} />
              </Field>
              <Field label="Branch code">
                <Input value={s.tin_branch_code} onChange={(e) => set('tin_branch_code', e.target.value)} />
              </Field>
              <Field label="RDO code">
                <Input value={s.rdo_code} onChange={(e) => set('rdo_code', e.target.value)} />
              </Field>
              <Field label="VAT registration" className="col-span-2 sm:col-span-4" hint="Printed with the TIN on every report: VAT REG TIN or NON-VAT REG TIN (BIR RMO 9-2021).">
                <Select
                  value={s.vat_registered === null ? '' : s.vat_registered ? 'vat' : 'non_vat'}
                  onChange={(e) => set('vat_registered', e.target.value === '' ? null : e.target.value === 'vat')}
                >
                  <option value="">Not set: reports print "TIN" only</option>
                  <option value="vat">VAT-registered</option>
                  <option value="non_vat">Non-VAT (percentage tax or exempt)</option>
                </Select>
              </Field>
              <Field label="ZIP code">
                <Input value={s.zip_code} onChange={(e) => set('zip_code', e.target.value)} />
              </Field>
              <Field label="Contact number" className="col-span-2 sm:col-span-3">
                <Input value={s.contact_number} onChange={(e) => set('contact_number', e.target.value)} />
              </Field>
              <Field label="Email" className="col-span-2 sm:col-span-4">
                <Input value={s.contact_email} onChange={(e) => set('contact_email', e.target.value)} />
              </Field>
              <Field label="Withholding agent" className="col-span-2">
                <Select
                  value={s.withholding_agent_category}
                  onChange={(e) => set('withholding_agent_category', e.target.value as Entity['withholding_agent_category'])}
                >
                  <option value="private">Private</option>
                  <option value="government">Government</option>
                </Select>
              </Field>
            </div>
            <Toggle
              checked={s.is_top_withholding_agent}
              onChange={(v) => set('is_top_withholding_agent', v)}
              label="Classified by the BIR as a top withholding agent"
            />
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="Employer numbers" icon={<Hash />}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="SSS employer no.">
                <Input value={s.sss_employer_no} onChange={(e) => set('sss_employer_no', e.target.value)} />
              </Field>
              <Field label="PhilHealth employer no.">
                <Input value={s.philhealth_employer_no} onChange={(e) => set('philhealth_employer_no', e.target.value)} />
              </Field>
              <Field label="Pag-IBIG employer no.">
                <Input value={s.pagibig_employer_no} onChange={(e) => set('pagibig_employer_no', e.target.value)} />
              </Field>
            </div>
          </Card>
          <Card title="Minimum wage" icon={<Coins />}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Wage region">
                <Select value={s.minimum_wage_region} onChange={(e) => set('minimum_wage_region', e.target.value)}>
                  <option value="">Select…</option>
                  {PH_REGIONS.map((r) => (
                    <option key={r.code} value={r.code}>{r.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Daily minimum wage (PHP)" hint="Update when a new wage order takes effect">
                <Input
                  type="number"
                  step="0.01"
                  value={s.minimum_wage_daily}
                  onChange={(e) => set('minimum_wage_daily', e.target.value as unknown as number)}
                />
              </Field>
              <Field label="Wage order reference" className="sm:col-span-2">
                <Input value={s.minimum_wage_reference} onChange={(e) => set('minimum_wage_reference', e.target.value)} />
              </Field>
            </div>
          </Card>
        </div>

        <Card title="Payroll policy" icon={<SlidersHorizontal />}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Default pay frequency" hint="For new employees; set per employee on their record">
              <Select
                value={s.default_pay_frequency}
                onChange={(e) => set('default_pay_frequency', e.target.value as Entity['default_pay_frequency'])}
              >
                {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label="Contribution deduction timing" hint="How monthly SSS / PhilHealth / Pag-IBIG are spread">
              <Select
                value={s.contribution_deduction_timing}
                onChange={(e) => set('contribution_deduction_timing', e.target.value as Entity['contribution_deduction_timing'])}
              >
                {Object.entries(CONTRIBUTION_TIMING_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label="Days-per-year factor" hint="261 (Mon–Fri), 313 (6-day week), 365; overridable per employee">
              <Input type="number" value={s.working_days_divisor} onChange={(e) => set('working_days_divisor', e.target.value as unknown as number)} />
            </Field>
            <Field label="Standard hours per day" hint="8 at most (Art. 83); a longer day is a compressed-workweek shift">
              <Input type="number" min={1} max={8} value={s.standard_hours_per_day} onChange={(e) => set('standard_hours_per_day', e.target.value as unknown as number)} />
            </Field>
            <Field label="Grace period (minutes)">
              <Input type="number" value={s.grace_period_minutes} onChange={(e) => set('grace_period_minutes', e.target.value as unknown as number)} />
            </Field>
            <Field label="Night differential rate" hint="At least 0.10 (10%) for 10pm–6am">
              <Input type="number" step="0.01" value={s.night_diff_rate} onChange={(e) => set('night_diff_rate', e.target.value as unknown as number)} />
            </Field>
            <Field label="Days from period end to pay date" hint="Used to suggest the pay date of new runs">
              <Input type="number" value={s.pay_date_lag_days} onChange={(e) => set('pay_date_lag_days', e.target.value as unknown as number)} />
            </Field>
            <Field label="BIR 1601-C filing" hint="Sets the due dates under BIR & Reports">
              <Select value={s.bir_filing_method} onChange={(e) => set('bir_filing_method', e.target.value as Entity['bir_filing_method'])}>
                <option value="manual">Manual / eBIRForms (10th of the next month)</option>
                <option value="efps">eFPS</option>
              </Select>
            </Field>
            {s.bir_filing_method === 'efps' && (
              <Field label="eFPS group">
                <Select value={s.efps_group ?? ''} onChange={(e) => set('efps_group', (e.target.value || null) as Entity['efps_group'])}>
                  <option value="">Pick the group…</option>
                  {(['A', 'B', 'C', 'D', 'E'] as const).map((g) => (
                    <option key={g} value={g}>Group {g}</option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Pag-IBIG due day (next month)" hint="As your Pag-IBIG branch sets it; blank until entered">
              <Input type="number" min={1} max={31} value={s.pagibig_due_day ?? ''} onChange={(e) => set('pagibig_due_day', e.target.value as unknown as number)} />
            </Field>
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="Cash payroll — whole-peso net pay" icon={<Banknote />}>
            <div className="space-y-3">
              <Field label="Net pay rounding">
                <Select value={s.net_pay_rounding} onChange={(e) => set('net_pay_rounding', e.target.value as Entity['net_pay_rounding'])}>
                  {Object.entries(ROUNDING_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Apply to">
                <Select value={s.rounding_scope} onChange={(e) => set('rounding_scope', e.target.value as Entity['rounding_scope'])}>
                  <option value="cash_only">Employees paid in cash only</option>
                  <option value="all">Every employee</option>
                </Select>
              </Field>
              <p className="text-xs text-slate-400">
                Statutory contributions and tax keep their exact centavos; only the cash handed over is rounded.
                Rounding down is not offered: keeping an employee's centavos would be an unauthorized wage
                deduction. Carried centavos are always paid out on the final pay.
              </p>
            </div>
          </Card>
          <Card title="Tax and labor rules" icon={<Scale />}>
            <div className="space-y-3">
              <Toggle
                checked={s.mwe_rh_restday_premium_taxable}
                onChange={(v) => set('mwe_rh_restday_premium_taxable', v)}
                label="Tax a minimum wage earner's extra 30% for a regular holiday worked on the rest day"
              />
              <p className="text-xs text-slate-400">
                A minimum wage earner's rest-day and special-day premiums are taxable; the minimum wage, holiday pay,
                overtime, night differential and certified hazard pay stay exempt (NIRC Sec. 24(A)(2)).
              </p>
              <Field
                label="Paid vacation leave days a year"
                hint="5 or more: the client is outside the service incentive leave (Art. 95(b)), and unused VL converted to cash is de minimis up to the yearly ceiling"
              >
                <Input type="number" min={0} max={365} value={s.paid_vl_days_per_year} onChange={(e) => set('paid_vl_days_per_year', e.target.value as unknown as number)} />
              </Field>
              <Toggle
                checked={s.sss_include_13th_month}
                onChange={(v) => set('sss_include_13th_month', v)}
                label="Count the 13th month pay as SSS compensation of its month"
              />
              <Toggle
                checked={s.sil_conversion_taxable}
                onChange={(v) => set('sil_conversion_taxable', v)}
                label="Tax service incentive leave converted to cash (a client giving only the 5-day SIL)"
              />
              <Toggle
                checked={s.maternity_differential_exempt}
                onChange={(v) => set('maternity_differential_exempt', v)}
                label="DOLE exempted this client from the maternity salary differential"
              />
              {s.maternity_differential_exempt && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="DOLE exemption reference">
                    <Input value={s.dole_exemption_ref} onChange={(e) => set('dole_exemption_ref', e.target.value)} />
                  </Field>
                  <Field label="Valid until" hint="A leave starting after it is not exempt">
                    <Input type="date" value={s.dole_exemption_valid_until ?? ''} onChange={(e) => set('dole_exemption_valid_until', e.target.value)} />
                  </Field>
                </div>
              )}
              <Toggle
                checked={s.holiday_absence_rule}
                onChange={(v) => set('holiday_absence_rule', v)}
                label="No regular holiday pay after an unpaid absence on the workday before (unless the holiday is worked)"
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle
                  checked={s.retail_service_establishment}
                  onChange={(v) => set('retail_service_establishment', v)}
                  label="Retail or service establishment"
                />
                <Field label="Workers regularly employed" hint="All the establishment's workers, not only those on this payroll">
                  <Input type="number" min={0} value={s.regular_workers ?? ''} onChange={(e) => set('regular_workers', e.target.value as unknown as number)} />
                </Field>
              </div>
              <Toggle
                checked={s.holiday_pay_exempt}
                onChange={(v) => set('holiday_pay_exempt', v)}
                label="Exempt from holiday pay (retail or service establishment regularly employing less than 10 workers, Art. 94)"
              />
            </div>
          </Card>
          <Card title="Payslip" icon={<FileText />}>
            <Field label="Footer note">
              <Textarea rows={2} value={s.payslip_footer_note} onChange={(e) => set('payslip_footer_note', e.target.value)} />
            </Field>
          </Card>
        </div>
      </div>
      <div className="mt-6">
        <Button disabled={busy} onClick={save} className="w-full lg:w-auto">
          {busy ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </div>
  )
}
