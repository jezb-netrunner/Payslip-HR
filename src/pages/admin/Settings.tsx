import { useEffect, useState } from 'react'
import { Baby, Banknote, Building2, CalendarClock, Coins, FileText, Hash, SlidersHorizontal } from 'lucide-react'
import { Button, Card, Field, Input, NoClient, PageHeader, PendingBadge, Select, Textarea, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { useAuth } from '../../lib/auth'
import type { Entity, MaternityExemptionCategory } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { CONTRIBUTION_TIMING_LABELS, EFPS_GROUP_LABELS, FILING_MODE_LABELS, FREQUENCY_LABELS, MATERNITY_EXEMPTION_LABELS, PH_REGIONS, ROUNDING_LABELS } from '../../lib/labels'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errors'
import { money, splitClientTin } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { minimumWageFor, useMinimumWages } from '../../lib/useMinimumWages'

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
  if (!(n(s.standard_hours_per_day) > 0 && n(s.standard_hours_per_day) <= 8)) return 'Standard hours per day must be above 0 and at most 8 (Labor Code Art. 83).'
  if (!int(s.grace_period_minutes) || n(s.grace_period_minutes) < 0 || n(s.grace_period_minutes) > 240)
    return 'Grace period must be a whole number of minutes, 0–240.'
  if (!(n(s.night_diff_rate) >= 0.1 && n(s.night_diff_rate) <= 1))
    return 'Night differential rate must be at least 0.10 (Labor Code Art. 86) and at most 1.'
  if (!int(s.pay_date_lag_days) || n(s.pay_date_lag_days) < 0 || n(s.pay_date_lag_days) > 31)
    return 'Days from period end to pay date must be a whole number, 0–31.'
  if (s.maternity_exemption_category && (!s.maternity_exemption_dole_ref?.trim() || !int(s.maternity_exemption_year) || n(s.maternity_exemption_year) < 2019))
    return 'Maternity differential exemption: enter the DOLE approval reference and the year it covers.'
  if (s.filing_mode === 'efps' && !s.efps_group) return 'Choose the eFPS filing group.'
  for (const [label, v] of [['SSS', s.sss_due_day], ['PhilHealth', s.philhealth_due_day], ['Pag-IBIG', s.pagibig_due_day]] as const) {
    if (v !== null && v !== undefined && String(v) !== '' && !(int(v) && n(v) >= 1 && n(v) <= 31)) {
      return `${label} due date: a day of the month, 1–31 (or blank).`
    }
  }
  return null
}

/** A contribution due day from the form: blank = not set. */
function dueDay(v: number | string | null | undefined): number | null {
  return v === null || v === undefined || String(v) === '' ? null : Number(v)
}

function SettingsForm({ initial, onSaved }: { initial: Entity; onSaved: () => Promise<void> }) {
  const toast = useToast()
  const [s, setS] = useState<Entity>(initial)
  const [busy, setBusy] = useState(false)
  useEffect(() => setS(initial), [initial])

  const set = <K extends keyof Entity>(k: K, v: Entity[K]) => setS({ ...s, [k]: v })
  const wages = useMinimumWages()
  const inForce = minimumWageFor(s, todayManila(), wages)

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
          leave_policy: s.leave_policy,
          holiday_pay_after_absence: s.holiday_pay_after_absence,
          minimum_wage_sector: (s.minimum_wage_sector ?? '').trim(),
          net_pay_rounding: s.net_pay_rounding,
          rounding_scope: s.rounding_scope,
          pay_date_lag_days: Number(s.pay_date_lag_days),
          payslip_footer_note: s.payslip_footer_note,
          maternity_exemption_category: s.maternity_exemption_category || null,
          maternity_exemption_dole_ref: s.maternity_exemption_category ? s.maternity_exemption_dole_ref?.trim() : null,
          maternity_exemption_year: s.maternity_exemption_category ? Number(s.maternity_exemption_year) : null,
          filing_mode: s.filing_mode || null,
          efps_group: s.filing_mode === 'efps' ? s.efps_group : null,
          sss_due_day: dueDay(s.sss_due_day),
          philhealth_due_day: dueDay(s.philhealth_due_day),
          pagibig_due_day: dueDay(s.pagibig_due_day),
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
              <Field label="Sector" hint="As the wage order names it; blank = the region's general rate">
                <Input
                  value={s.minimum_wage_sector ?? ''}
                  maxLength={100}
                  list="minimum-wage-sectors"
                  onChange={(e) => set('minimum_wage_sector', e.target.value)}
                />
                <datalist id="minimum-wage-sectors">
                  {[...new Set((wages ?? []).filter((w) => w.region === s.minimum_wage_region && w.sector).map((w) => w.sector))].map((x) => (
                    <option key={x} value={x} />
                  ))}
                </datalist>
              </Field>
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 sm:col-span-2">
                {inForce.daily ? (
                  <>
                    Payroll uses <b>{money(inForce.daily)}</b> a day today ({inForce.source}).
                  </>
                ) : (
                  'No minimum wage today: set the region, or the daily rate below.'
                )}{' '}
                Company admins keep the rates by region under Statutory Tables → Minimum wages.
              </p>
              <Field label="Own daily minimum wage (PHP)" hint="Used only while no rate for the region is on file">
                <Input
                  type="number"
                  step="0.01"
                  value={s.minimum_wage_daily}
                  onChange={(e) => set('minimum_wage_daily', e.target.value as unknown as number)}
                />
              </Field>
              <Field label="Wage order reference">
                <Input value={s.minimum_wage_reference} onChange={(e) => set('minimum_wage_reference', e.target.value)} />
              </Field>
            </div>
          </Card>
          <Card title="Filing and due dates" icon={<CalendarClock />}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="BIR filing" hint="Sets the 1601-C due dates (BIR & Reports → Due dates)">
                <Select
                  value={s.filing_mode ?? ''}
                  onChange={(e) => {
                    const mode = (e.target.value || null) as Entity['filing_mode']
                    setS({ ...s, filing_mode: mode, efps_group: mode === 'efps' ? s.efps_group : null })
                  }}
                >
                  <option value="">Not set</option>
                  {Object.entries(FILING_MODE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              {s.filing_mode === 'efps' && (
                <Field label="eFPS filing group">
                  <Select value={s.efps_group ?? ''} onChange={(e) => set('efps_group', (e.target.value || null) as Entity['efps_group'])}>
                    <option value="">Select…</option>
                    {Object.entries(EFPS_GROUP_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            <p className="mb-2 mt-4 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-600">
              Contribution due dates <PendingBadge />
            </p>
            <div className="grid grid-cols-3 gap-3">
              {(
                [
                  ['sss_due_day', 'SSS'],
                  ['philhealth_due_day', 'PhilHealth'],
                  ['pagibig_due_day', 'Pag-IBIG'],
                ] as const
              ).map(([k, label]) => (
                <Field key={k} label={label}>
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    placeholder="Not set"
                    aria-label={`${label}: day of the next month`}
                    value={s[k] ?? ''}
                    onChange={(e) => set(k, e.target.value === '' ? null : (e.target.value as unknown as number))}
                  />
                </Field>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              Day of the next month each agency's remittance for a month is due. The agencies set it by employer number or
              name: enter the day that applies to this client, or leave it blank. Dates never move for weekends or holidays;
              override a date under BIR &amp; Reports → Due dates.
            </p>
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
            <Field
              label="Leave policy"
              hint="Decides how unused leave paid in cash is taxed: de minimis up to 12 days a year (vacation leave in place of SIL), or taxable (SIL only). Changed during the year, the year-end adjustment applies it to the whole year's conversions"
            >
              <Select value={s.leave_policy} onChange={(e) => set('leave_policy', e.target.value as Entity['leave_policy'])}>
                <option value="vl_in_place_of_sil">Paid vacation leave of 5 days or more, in place of SIL</option>
                <option value="sil_only">Service incentive leave (SIL) only</option>
              </Select>
            </Field>
            <Field
              label="Regular holiday after an unpaid absence"
              hint="Labor Code IRR Book III, Rule IV, Sec. 6: no holiday pay without work or paid leave on the workday before it"
            >
              <Select value={s.holiday_pay_after_absence} onChange={(e) => set('holiday_pay_after_absence', e.target.value as Entity['holiday_pay_after_absence'])}>
                <option value="apply_rule">Apply the rule (not paid)</option>
                <option value="pay_anyway">Pay it anyway</option>
              </Select>
            </Field>
            <Field label="Days from period end to pay date" hint="Used to suggest the pay date of new runs">
              <Input type="number" value={s.pay_date_lag_days} onChange={(e) => set('pay_date_lag_days', e.target.value as unknown as number)} />
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
          <Card title="Maternity leave (RA 11210)" icon={<Baby />}>
            <div className="space-y-3">
              <Field label="DOLE exemption from the salary differential">
                <Select
                  value={s.maternity_exemption_category ?? ''}
                  onChange={(e) => set('maternity_exemption_category', (e.target.value || null) as MaternityExemptionCategory | null)}
                >
                  <option value="">None — the differential is paid</option>
                  {Object.entries(MATERNITY_EXEMPTION_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              {s.maternity_exemption_category && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="DOLE approval reference" className="sm:col-span-2">
                    <Input value={s.maternity_exemption_dole_ref ?? ''} onChange={(e) => set('maternity_exemption_dole_ref', e.target.value)} />
                  </Field>
                  <Field label="Year it covers">
                    <Input type="number" value={s.maternity_exemption_year ?? ''} onChange={(e) => set('maternity_exemption_year', e.target.value as unknown as number)} />
                  </Field>
                </div>
              )}
              <p className="text-xs text-slate-400">
                Each exemption needs DOLE approval every year (RA 11210 Sec. 5(c)). Without one for the payroll's year,
                a payroll that covers maternity leave won't finalize until the salary differential is on it (or was paid
                earlier in the leave).
              </p>
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
