// Independent consultants (not employees), per client: kept off payroll —
// no SSS, PhilHealth, Pag-IBIG, 13th month or leave. Each has a contract and
// fee, an employee-or-contractor checklist the client signs off before the
// first billing, and a yearly sworn declaration of gross income. Each
// billing is withheld expanded withholding tax (EWT) by the database at the
// rate of the EWT table in force; the BIR tab gives the quarter's 1601-EQ
// figures (and the 0619-E of its first two months), the Quarterly Alphalist
// of Payees and the 2307 figures per payee. Marking a quarter's 1601-EQ
// filed locks its billings.

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BadgeCheck, Briefcase, Download, FileText, Landmark, Lock, Pencil, Plus, Printer, ReceiptText, Trash2, Unlock, Wallet } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadFailed,
  Modal,
  NoClient,
  PageHeader,
  Segmented,
  Select,
  Spinner,
  StatCard,
  StatGroup,
  Tabs,
  Textarea,
  Toggle,
} from '../../components/ui'
import { useToast } from '../../components/toast'
import { downloadCsv } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import {
  BILLING_LABELS,
  CONTRACTOR_CHECKLIST,
  FEE_BASIS_LABELS,
  PAYEE_TYPE_LABELS,
  checklistComplete,
  checklistConcerns,
  ewtReasonText,
} from '../../lib/consultants'
import type { Consultant, ConsultantBilling, ConsultantDeclaration, Entity, EwtQuarterFiling } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { errorMessage } from '../../lib/errors'
import { fetchAll } from '../../lib/fetchAll'
import { fmtDate, fmtDateTime, fmtTin, money } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import {
  ewtAmount,
  ewtRuleFor,
  ewtVersionOn,
  form2307Rows,
  payeeName,
  qapRows,
  quarterOf,
  return1601Eq,
  type EwtVersion,
  type Quarter,
} from '../../payroll/ewt'
import { ewtDueDates } from '../../payroll/ewtDueDates'
import { round2 } from '../../payroll/types'

interface Data {
  consultants: Consultant[]
  declarations: ConsultantDeclaration[]
  billings: ConsultantBilling[]
  filings: EwtQuarterFiling[]
  versions: EwtVersion[]
}

const pct = (r: number) => `${round2(Number(r) * 100)}%`

export default function Consultants() {
  const { entity } = useEntity()
  const { isCompanyAdmin } = useAuth()
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  return <ConsultantsPage key={entity.id} entity={entity} />
}

function ConsultantsPage({ entity }: { entity: Entity }) {
  const toast = useToast()
  const [data, setData] = useState<Data | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [tab, setTab] = useState('consultants')
  const [editing, setEditing] = useState<{ consultant: Consultant | null } | null>(null)
  const [declaring, setDeclaring] = useState<Consultant | null>(null)
  const [billing, setBilling] = useState<{ billing: ConsultantBilling | null; consultantId?: string } | null>(null)
  const today = todayManila()
  const [quarterStart, setQuarterStart] = useState(() => quarterOf(today).start)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetchAll<Consultant>((from, to) => supabase.from('consultants').select('*').eq('entity_id', entity.id).order('id').range(from, to)),
      fetchAll<ConsultantDeclaration>((from, to) =>
        supabase.from('consultant_declarations').select('*').eq('entity_id', entity.id).order('id').range(from, to),
      ),
      fetchAll<ConsultantBilling>((from, to) =>
        supabase.from('consultant_billings').select('*').eq('entity_id', entity.id).order('billed_on', { ascending: false }).order('id').range(from, to),
      ),
      fetchAll<EwtQuarterFiling>((from, to) => supabase.from('ewt_quarter_filings').select('*').eq('entity_id', entity.id).order('id').range(from, to)),
      fetchAll<EwtVersion>((from, to) => supabase.from('ewt_versions').select('*').order('effective_from').range(from, to)),
    ])
      .then(([consultants, declarations, billings, filings, versions]) => {
        if (!cancelled) setData({ consultants, declarations, billings, filings, versions })
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err, 'Failed to load'))
      })
    return () => {
      cancelled = true
    }
  }, [entity.id, reload])

  const refresh = () => setReload((n) => n + 1)
  const quarter = quarterOf(quarterStart)

  if (loadError) {
    return (
      <LoadFailed
        message={loadError}
        onRetry={() => {
          setLoadError('')
          refresh()
        }}
      />
    )
  }
  if (!data) return <Spinner />

  const active = data.consultants.filter((c) => c.active)
  const toSignOff = active.filter((c) => !c.signed_off_at)
  const inQuarter = data.billings.filter((b) => b.billed_on >= quarter.start && b.billed_on <= quarter.end)
  const billed = round2(inQuarter.reduce((s, b) => s + Number(b.gross_amount), 0))
  const withheld = round2(inQuarter.reduce((s, b) => s + Number(b.ewt_amount), 0))
  const filedQuarter = (date: string) => data.filings.find((f) => f.quarter === quarterOf(date).start)

  return (
    <div>
      <PageHeader
        title="Consultants"
        subtitle="Independent consultants, not employees: kept off payroll (no SSS, PhilHealth, Pag-IBIG, 13th month or leave) and paid on their billings, with expanded withholding tax withheld on the fees. Consultants on an employee retainer belong in Employees (fixed salary, output pay)."
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing({ consultant: null })}>
              <Plus className="size-4" /> Add consultant
            </Button>
            <Button onClick={() => setBilling({ billing: null })} disabled={active.length === 0}>
              <ReceiptText className="size-4" /> Record billing
            </Button>
          </>
        }
      />

      <StatGroup className="mb-6">
        <StatCard label="Active consultants" value={active.length} sub={`${data.consultants.length - active.length} ended`} icon={<Briefcase />} />
        <StatCard label={`Billed in ${quarter.label}`} value={money(billed)} sub={`${inQuarter.length} billing${inQuarter.length === 1 ? '' : 's'}`} icon={<Wallet />} />
        <StatCard label={`EWT withheld in ${quarter.label}`} value={money(withheld)} sub="remitted with 0619-E and 1601-EQ" icon={<Landmark />} />
        <StatCard
          label="Checklists to sign off"
          value={toSignOff.length}
          sub={toSignOff.length ? 'needed before billing' : 'all signed off'}
          icon={<BadgeCheck />}
          tone={toSignOff.length ? 'warn' : 'default'}
        />
      </StatGroup>

      <Tabs
        tabs={[
          { key: 'consultants', label: 'Consultants', icon: <Briefcase /> },
          { key: 'billings', label: 'Billings', icon: <ReceiptText /> },
          { key: 'bir', label: 'BIR (EWT)', icon: <Landmark /> },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'consultants' && (
        <ConsultantList
          data={data}
          onEdit={(c) => setEditing({ consultant: c })}
          onDeclare={setDeclaring}
          onBill={(c) => setBilling({ billing: null, consultantId: c.id })}
        />
      )}
      {tab === 'billings' && (
        <BillingList
          data={data}
          quarter={quarter}
          onQuarter={setQuarterStart}
          filed={!!filedQuarter(quarter.start)}
          onEdit={(b) => setBilling({ billing: b })}
          onChanged={refresh}
        />
      )}
      {tab === 'bir' && (
        <BirTab
          entity={entity}
          data={data}
          quarter={quarter}
          onQuarter={setQuarterStart}
          filing={filedQuarter(quarter.start)}
          onChanged={refresh}
        />
      )}

      <ConsultantModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        entity={entity}
        consultant={editing?.consultant ?? null}
        onSaved={() => {
          setEditing(null)
          refresh()
        }}
      />
      {declaring && (
        <DeclarationModal
          key={declaring.id}
          onClose={() => setDeclaring(null)}
          consultant={declaring}
          declarations={data.declarations}
          versions={data.versions}
          onChanged={refresh}
        />
      )}
      <BillingModal
        open={billing !== null}
        onClose={() => setBilling(null)}
        data={data}
        editing={billing?.billing ?? null}
        consultantId={billing?.consultantId}
        onSaved={() => {
          setBilling(null)
          toast('success', 'Billing saved: the EWT is withheld at the rate shown.')
          refresh()
        }}
      />
    </div>
  )
}

/** Quarters with billings, the current one and the selected one, newest first. */
function quarterOptions(data: Data, selected: string): Quarter[] {
  const starts = new Set([quarterOf(todayManila()).start, selected, ...data.billings.map((b) => quarterOf(b.billed_on).start)])
  return [...starts].sort().reverse().map((s) => quarterOf(s))
}

function QuarterSelect({ data, quarter, onQuarter }: { data: Data; quarter: Quarter; onQuarter: (start: string) => void }) {
  return (
    <Select aria-label="Quarter" className="w-36" value={quarter.start} onChange={(e) => onQuarter(e.target.value)}>
      {quarterOptions(data, quarter.start).map((q) => (
        <option key={q.start} value={q.start}>
          {q.label}
        </option>
      ))}
    </Select>
  )
}

// ---------- the list ----------

function ConsultantList({
  data,
  onEdit,
  onDeclare,
  onBill,
}: {
  data: Data
  onEdit: (c: Consultant) => void
  onDeclare: (c: Consultant) => void
  onBill: (c: Consultant) => void
}) {
  const today = todayManila()
  const year = Number(today.slice(0, 4))
  const version = ewtVersionOn(data.versions, today)
  const sorted = [...data.consultants].sort((a, b) => Number(b.active) - Number(a.active) || payeeName(a).localeCompare(payeeName(b)))
  if (sorted.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No consultants yet"
          sub="Add each independent consultant with their TIN, contract and fee. Before the first billing, answer the employee-or-contractor checklist and sign it off."
        />
      </Card>
    )
  }
  return (
    <div className="space-y-3">
      {sorted.map((c) => {
        const declaration = data.declarations.find((d) => d.consultant_id === c.id && d.year === year)
        const rule = version ? ewtRuleFor(version.data, c, declaration) : null
        const concerns = checklistConcerns(c.checklist)
        return (
          <Card key={c.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-semibold text-ink-900">
                  {payeeName(c)} {!c.active && <Badge tone="slate">Ended</Badge>}
                </p>
                <p className="text-xs text-slate-500">
                  {PAYEE_TYPE_LABELS[c.payee_type]} · TIN {fmtTin(c.tin, c.tin_branch_code)}
                  {c.vat_registered ? ' · VAT-registered' : ''}
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  {c.service} · {c.fee_amount ? `${money(Number(c.fee_amount))} ${c.fee_basis === 'retainer' ? 'a month' : 'a deliverable'}` : FEE_BASIS_LABELS[c.fee_basis]} ·{' '}
                  {BILLING_LABELS[c.billing].toLowerCase()}
                </p>
                <p className="text-xs text-slate-500">
                  Contract {c.contract_ref ? `${c.contract_ref}, ` : ''}
                  {fmtDate(c.contract_start)} – {c.contract_end ? fmtDate(c.contract_end) : 'open'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => onDeclare(c)}>
                  <FileText className="size-4" /> Declarations
                </Button>
                <Button size="sm" variant="secondary" onClick={() => onEdit(c)}>
                  <Pencil className="size-4" /> Edit
                </Button>
                {c.active && c.signed_off_at && (
                  <Button size="sm" onClick={() => onBill(c)}>
                    <ReceiptText className="size-4" /> Record billing
                  </Button>
                )}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {c.signed_off_at ? (
                <Badge tone={concerns.length ? 'amber' : 'green'}>
                  Signed off by {c.signed_off_by}, {fmtDate(c.signed_off_at.slice(0, 10))}
                  {concerns.length ? ` · ${concerns.length} answer${concerns.length === 1 ? '' : 's'} pointing to employment` : ''}
                </Badge>
              ) : (
                <Badge tone="red">Checklist not signed off: no billing yet</Badge>
              )}
              {rule && (
                <Badge tone="blue">
                  EWT {pct(rule.rate)} ({rule.atc}) in {year}: {ewtReasonText(rule.reason, rule.threshold)}
                </Badge>
              )}
            </div>
          </Card>
        )
      })}
    </div>
  )
}

// ---------- adding and editing a consultant ----------

interface ConsultantForm {
  payee_type: Consultant['payee_type']
  last_name: string
  first_name: string
  middle_name: string
  registered_name: string
  tin: string
  tin_branch_code: string
  address: string
  zip_code: string
  vat_registered: boolean
  service: string
  fee_basis: Consultant['fee_basis']
  fee_amount: string
  billing: Consultant['billing']
  contract_ref: string
  contract_start: string
  contract_end: string
  active: boolean
  notes: string
  checklist: Record<string, boolean>
  checklist_note: string
  sign: boolean
  signed_off_by: string
}

function ConsultantModal({
  open,
  onClose,
  entity,
  consultant,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  entity: Entity
  consultant: Consultant | null
  onSaved: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState<ConsultantForm>(() => blank())
  function blank(): ConsultantForm {
    const c = consultant
    return {
      payee_type: c?.payee_type ?? 'individual',
      last_name: c?.last_name ?? '',
      first_name: c?.first_name ?? '',
      middle_name: c?.middle_name ?? '',
      registered_name: c?.registered_name ?? '',
      tin: c?.tin ?? '',
      tin_branch_code: c?.tin_branch_code ?? '00000',
      address: c?.address ?? '',
      zip_code: c?.zip_code ?? '',
      vat_registered: c?.vat_registered ?? false,
      service: c?.service ?? '',
      fee_basis: c?.fee_basis ?? 'retainer',
      fee_amount: c?.fee_amount ? String(c.fee_amount) : '',
      billing: c?.billing ?? 'monthly',
      contract_ref: c?.contract_ref ?? '',
      contract_start: c?.contract_start ?? todayManila(),
      contract_end: c?.contract_end ?? '',
      active: c?.active ?? true,
      notes: c?.notes ?? '',
      checklist: { ...(c?.checklist ?? {}) },
      checklist_note: c?.checklist_note ?? '',
      sign: !!c?.signed_off_at,
      signed_off_by: c?.signed_off_by ?? '',
    }
  }
  useEffect(() => {
    if (open) setF(blank())
    // a fresh form each time it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, consultant?.id])

  const concerns = checklistConcerns(f.checklist)
  const answersChanged =
    !!consultant &&
    (JSON.stringify(CONTRACTOR_CHECKLIST.map((q) => f.checklist[q.key])) !== JSON.stringify(CONTRACTOR_CHECKLIST.map((q) => consultant.checklist[q.key])) ||
      f.checklist_note.trim() !== consultant.checklist_note)

  async function save() {
    const individual = f.payee_type === 'individual'
    if (individual ? !f.last_name.trim() || !f.first_name.trim() : !f.registered_name.trim()) {
      return toast('error', individual ? "Enter the consultant's last and first name." : "Enter the firm's registered name.")
    }
    if (!/^\d{3}-?\d{3}-?\d{3}$/.test(f.tin.trim())) return toast('error', 'Enter the TIN as 9 digits (e.g. 123-456-789); the branch code goes in its own field.')
    if (!/^\d{3,5}$/.test(f.tin_branch_code.trim())) return toast('error', 'The TIN branch code is 3 to 5 digits (00000 for the head office).')
    if (f.zip_code && !/^\d{4}$/.test(f.zip_code)) return toast('error', 'The ZIP code is 4 digits.')
    if (!f.service.trim()) return toast('error', 'Describe the service (the nature of the income payment on the BIR forms).')
    if (f.fee_amount && !(Number(f.fee_amount) > 0)) return toast('error', 'The fee must be above zero (or blank).')
    if (!f.contract_start) return toast('error', 'Enter the contract start date.')
    if (f.contract_end && f.contract_end < f.contract_start) return toast('error', 'The contract ends before it starts.')
    if (f.sign) {
      if (!checklistComplete(f.checklist)) return toast('error', 'Answer every question of the checklist before signing it off.')
      if (concerns.length > 0 && !f.checklist_note.trim()) {
        return toast('error', 'Some answers point to an employment: explain in the note why this is still an independent contractor, or treat the person as an employee.')
      }
      if (!f.signed_off_by.trim()) return toast('error', 'Enter who signs off the checklist.')
    }
    setBusy(true)
    try {
      const row = {
        payee_type: f.payee_type,
        last_name: individual ? f.last_name.trim() : '',
        first_name: individual ? f.first_name.trim() : '',
        middle_name: individual ? f.middle_name.trim() : '',
        registered_name: individual ? '' : f.registered_name.trim(),
        tin: f.tin.trim(),
        tin_branch_code: f.tin_branch_code.trim(),
        address: f.address.trim(),
        zip_code: f.zip_code.trim(),
        vat_registered: f.vat_registered,
        service: f.service.trim(),
        fee_basis: f.fee_basis,
        fee_amount: f.fee_amount ? Number(f.fee_amount) : null,
        billing: f.billing,
        contract_ref: f.contract_ref.trim(),
        contract_start: f.contract_start,
        contract_end: f.contract_end || null,
        active: f.active,
        notes: f.notes.trim(),
        checklist: f.checklist,
        checklist_note: f.checklist_note.trim(),
      }
      const signedBy = f.sign ? f.signed_off_by.trim() : null
      if (!consultant) {
        const { error } = await supabase.from('consultants').insert({ ...row, entity_id: entity.id, signed_off_by: signedBy })
        if (error) throw error
      } else {
        // changed answers need a fresh sign-off: save them, then sign
        const { error } = await supabase
          .from('consultants')
          .update({ ...row, ...(answersChanged ? { signed_off_by: null } : { signed_off_by: signedBy }) })
          .eq('id', consultant.id)
        if (error) throw error
        if (answersChanged && signedBy) {
          const { error: signError } = await supabase.from('consultants').update({ signed_off_by: signedBy }).eq('id', consultant.id)
          if (signError) throw signError
        }
      }
      toast('success', consultant ? 'Consultant updated (audit-logged).' : 'Consultant added.')
      onSaved()
    } catch (err) {
      const msg = errorMessage(err, 'Save failed')
      toast('error', /consultants_tin_unique/.test(msg) ? 'This client already has a consultant with that TIN and branch code.' : msg)
    } finally {
      setBusy(false)
    }
  }

  const individual = f.payee_type === 'individual'
  return (
    <Modal open={open} onClose={onClose} title={consultant ? 'Edit consultant' : 'Add a consultant'} wide>
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Payee" group className="sm:col-span-3">
            <Segmented
              label="Payee"
              value={f.payee_type}
              onChange={(payee_type) => setF({ ...f, payee_type })}
              options={[
                { key: 'individual', label: 'Individual' },
                { key: 'juridical', label: 'Firm' },
              ]}
            />
          </Field>
          {individual ? (
            <>
              <Field label="Last name">
                <Input maxLength={80} value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} />
              </Field>
              <Field label="First name">
                <Input maxLength={80} value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} />
              </Field>
              <Field label="Middle name">
                <Input maxLength={80} value={f.middle_name} onChange={(e) => setF({ ...f, middle_name: e.target.value })} />
              </Field>
            </>
          ) : (
            <Field label="Registered name" className="sm:col-span-3">
              <Input maxLength={200} value={f.registered_name} onChange={(e) => setF({ ...f, registered_name: e.target.value })} />
            </Field>
          )}
          <Field label="TIN">
            <Input inputMode="numeric" placeholder="123-456-789" value={f.tin} onChange={(e) => setF({ ...f, tin: e.target.value })} />
          </Field>
          <Field label="Branch code">
            <Input inputMode="numeric" maxLength={5} value={f.tin_branch_code} onChange={(e) => setF({ ...f, tin_branch_code: e.target.value })} />
          </Field>
          <Field label="ZIP code">
            <Input inputMode="numeric" maxLength={4} value={f.zip_code} onChange={(e) => setF({ ...f, zip_code: e.target.value })} />
          </Field>
          <Field label="Registered address" className="sm:col-span-3">
            <Input maxLength={300} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
          </Field>
          <div className="sm:col-span-3">
            <Toggle checked={f.vat_registered} onChange={(v) => setF({ ...f, vat_registered: v })} label="VAT-registered (the fee's VAT is not withheld on)" />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Service" hint="The nature of the income payment on the BIR forms" className="sm:col-span-3">
            <Input maxLength={200} placeholder="e.g. Management consultancy" value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })} />
          </Field>
          <Field label="Fee">
            <Select value={f.fee_basis} onChange={(e) => setF({ ...f, fee_basis: e.target.value as Consultant['fee_basis'] })}>
              {Object.entries(FEE_BASIS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label={f.fee_basis === 'retainer' ? 'Monthly fee (PHP)' : 'Usual fee per deliverable (PHP)'}>
            <Input type="number" min={0} step="0.01" value={f.fee_amount} onChange={(e) => setF({ ...f, fee_amount: e.target.value })} />
          </Field>
          <Field label="Bills">
            <Select value={f.billing} onChange={(e) => setF({ ...f, billing: e.target.value as Consultant['billing'] })}>
              {Object.entries(BILLING_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="Contract reference">
            <Input maxLength={120} value={f.contract_ref} onChange={(e) => setF({ ...f, contract_ref: e.target.value })} />
          </Field>
          <Field label="Contract start">
            <Input type="date" value={f.contract_start} onChange={(e) => setF({ ...f, contract_start: e.target.value })} />
          </Field>
          <Field label="Contract end (optional)">
            <Input type="date" min={f.contract_start} value={f.contract_end} onChange={(e) => setF({ ...f, contract_end: e.target.value })} />
          </Field>
          {consultant && (
            <div className="sm:col-span-3">
              <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Active (an ended engagement keeps its billings and forms)" />
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 p-4">
          <p className="font-semibold text-ink-900">Employee or independent contractor?</p>
          <p className="mt-1 text-xs text-slate-500">
            Whoever the client controls in how the work is done is an employee, whatever the contract calls them — with SSS,
            PhilHealth, Pag-IBIG, 13th month pay and leave due (the four-fold test, the control test foremost: Sonza v. ABS-CBN,
            G.R. 138051, 2004). Answer for how the engagement works in practice.
          </p>
          <div className="mt-3 space-y-2">
            {CONTRACTOR_CHECKLIST.map((q) => (
              <div key={q.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
                <span className="min-w-0 flex-1 text-sm text-slate-700">{q.text}</span>
                <Segmented
                  label={q.text}
                  value={f.checklist[q.key] === true ? 'yes' : f.checklist[q.key] === false ? 'no' : ('' as 'yes' | 'no')}
                  onChange={(v) => setF({ ...f, checklist: { ...f.checklist, [q.key]: v === 'yes' } })}
                  options={[
                    { key: 'yes', label: 'Yes' },
                    { key: 'no', label: 'No' },
                  ]}
                />
              </div>
            ))}
          </div>
          {concerns.length > 0 && (
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {concerns.length === 1 ? 'One answer points' : `${concerns.length} answers point`} to an employment. If the client
              does control the work, add the person as an employee instead; otherwise explain below before signing off.
            </p>
          )}
          <Field label="Note (why this is an independent contractor)" className="mt-3">
            <Textarea rows={2} maxLength={1000} value={f.checklist_note} onChange={(e) => setF({ ...f, checklist_note: e.target.value })} />
          </Field>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="flex items-end">
              <Toggle checked={f.sign} onChange={(v) => setF({ ...f, sign: v })} label="I reviewed these answers and sign off" />
            </div>
            <Field label="Signed off by" hint={consultant?.signed_off_at && !answersChanged ? `Signed ${fmtDateTime(consultant.signed_off_at)}` : 'Name and position'}>
              <Input maxLength={120} disabled={!f.sign} value={f.signed_off_by} onChange={(e) => setF({ ...f, signed_off_by: e.target.value })} />
            </Field>
          </div>
          {answersChanged && consultant?.signed_off_at && (
            <p className="mt-2 text-xs text-amber-700">Changed answers need a new sign-off.</p>
          )}
        </div>

        <Field label="Notes (optional)">
          <Textarea rows={2} maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        <Button className="w-full" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : consultant ? 'Save changes' : 'Add consultant'}
        </Button>
      </div>
    </Modal>
  )
}

// ---------- the sworn declarations ----------

/** Mounted fresh (keyed by the consultant) each time it opens. */
function DeclarationModal({
  onClose,
  consultant,
  declarations,
  versions,
  onChanged,
}: {
  onClose: () => void
  consultant: Consultant
  declarations: ConsultantDeclaration[]
  versions: EwtVersion[]
  onChanged: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [year, setYear] = useState(() => Number(todayManila().slice(0, 4)))
  const [over, setOver] = useState(false)
  const [submitted, setSubmitted] = useState(todayManila())
  const mine = declarations.filter((d) => d.consultant_id === consultant.id).sort((a, b) => b.year - a.year)
  const version = ewtVersionOn(versions, `${year}-12-31`) ?? ewtVersionOn(versions, todayManila())
  const threshold = version?.data.professional_fees[consultant.payee_type].threshold
  const limit = threshold ? `₱${threshold.toLocaleString('en-PH')}` : 'the threshold'

  async function save() {
    setBusy(true)
    try {
      const existing = mine.find((d) => d.year === year)
      const row = { year, over_threshold: over, submitted_on: submitted }
      const { error } = existing
        ? await supabase.from('consultant_declarations').update(row).eq('id', existing.id)
        : await supabase.from('consultant_declarations').insert({ ...row, consultant_id: consultant.id })
      if (error) throw error
      toast('success', `Declaration for ${year} recorded: unpaid billings of ${year} take its rate.`)
      onChanged()
    } catch (err) {
      toast('error', errorMessage(err, 'Save failed'))
    } finally {
      setBusy(false)
    }
  }
  async function remove(d: ConsultantDeclaration) {
    if (!confirm(`Remove the ${d.year} declaration?`)) return
    const { error } = await supabase.from('consultant_declarations').delete().eq('id', d.id)
    if (error) return toast('error', errorMessage(error, 'Remove failed'))
    toast('success', 'Declaration removed.')
    onChanged()
  }

  return (
    <Modal open onClose={onClose} title={`Sworn declarations — ${payeeName(consultant)}`}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          The payee's sworn declaration of gross income for the year sets the EWT rate: {limit} or less gives the lower rate.
          Without one on file, or above it, the higher rate applies.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Year">
            <Input type="number" min={2018} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </Field>
          <Field label="Submitted on">
            <Input type="date" value={submitted} onChange={(e) => setSubmitted(e.target.value)} />
          </Field>
          <Field label="Declared gross income for the year" group className="sm:col-span-2">
            <Segmented
              label="Declared gross income for the year"
              value={over ? 'over' : 'within'}
              onChange={(v) => setOver(v === 'over')}
              options={[
                { key: 'within', label: `${limit} or less` },
                { key: 'over', label: `Above ${limit}` },
              ]}
            />
          </Field>
        </div>
        <Button className="w-full" disabled={busy || !submitted || !(year >= 2018)} onClick={save}>
          {busy ? 'Saving…' : 'Record declaration'}
        </Button>
        {mine.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {mine.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span>
                  <b className="text-ink-900">{d.year}</b>: {d.over_threshold ? `above ${limit}` : `${limit} or less`}
                  <span className="text-slate-500"> · submitted {fmtDate(d.submitted_on)}</span>
                </span>
                <IconButton label={`Remove the ${d.year} declaration`} onClick={() => remove(d)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

// ---------- billings ----------

function BillingList({
  data,
  quarter,
  onQuarter,
  filed,
  onEdit,
  onChanged,
}: {
  data: Data
  quarter: Quarter
  onQuarter: (start: string) => void
  filed: boolean
  onEdit: (b: ConsultantBilling) => void
  onChanged: () => void
}) {
  const toast = useToast()
  const byId = new Map(data.consultants.map((c) => [c.id, c]))
  const rows = data.billings.filter((b) => b.billed_on >= quarter.start && b.billed_on <= quarter.end)
  const sum = (k: 'gross_amount' | 'vat_amount' | 'ewt_amount' | 'net_amount') => round2(rows.reduce((s, b) => s + Number(b[k]), 0))

  async function remove(b: ConsultantBilling) {
    if (!confirm(`Remove invoice ${b.invoice_no} (${money(Number(b.gross_amount))})?`)) return
    const { error } = await supabase.from('consultant_billings').delete().eq('id', b.id)
    if (error) return toast('error', errorMessage(error, 'Remove failed'))
    toast('success', 'Billing removed.')
    onChanged()
  }
  async function markPaid(b: ConsultantBilling) {
    const { error } = await supabase.from('consultant_billings').update({ paid_on: todayManila() }).eq('id', b.id)
    if (error) return toast('error', errorMessage(error, 'Save failed'))
    toast('success', `Invoice ${b.invoice_no} marked paid today.`)
    onChanged()
  }

  return (
    <Card
      title={`Billings in ${quarter.label}`}
      icon={<ReceiptText />}
      actions={<QuarterSelect data={data} quarter={quarter} onQuarter={onQuarter} />}
    >
      {filed && (
        <p className="mb-3 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <Lock className="size-4" /> The quarter's 1601-EQ is marked filed: its billings are locked (BIR tab → Reopen to change one).
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">No billing in {quarter.label}.</p>
      ) : (
        <div className="scroll-thin overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="py-1.5 pr-4 font-semibold">Billed</th>
                <th className="py-1.5 pr-4 font-semibold">Consultant</th>
                <th className="py-1.5 pr-4 font-semibold">Invoice</th>
                <th className="py-1.5 pr-4 text-right font-semibold">Fee</th>
                <th className="py-1.5 pr-4 text-right font-semibold">VAT</th>
                <th className="py-1.5 pr-4 text-right font-semibold">EWT</th>
                <th className="py-1.5 pr-4 text-right font-semibold">Net payable</th>
                <th className="py-1.5 pr-4 font-semibold">Paid</th>
                <th className="py-1.5 font-semibold"> </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((b) => {
                const c = byId.get(b.consultant_id)
                return (
                  <tr key={b.id} className="align-top">
                    <td className="whitespace-nowrap py-2 pr-4 text-slate-700">{fmtDate(b.billed_on)}</td>
                    <td className="py-2 pr-4 text-ink-900">
                      {c ? payeeName(c) : '—'}
                      {b.description && <p className="text-xs text-slate-500">{b.description}</p>}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-slate-700">{b.invoice_no}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-ink-900">{money(Number(b.gross_amount))}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-slate-600">{Number(b.vat_amount) ? money(Number(b.vat_amount)) : '—'}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-slate-700">
                      {money(Number(b.ewt_amount))}
                      <p className="text-xs text-slate-500">
                        {pct(b.ewt_rate)} · {b.atc}
                      </p>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right font-semibold tabular-nums text-ink-900">{money(Number(b.net_amount))}</td>
                    <td className="whitespace-nowrap py-2 pr-4">
                      {b.paid_on ? (
                        <span className="text-slate-700">{fmtDate(b.paid_on)}</span>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={() => markPaid(b)}>
                          Mark paid
                        </Button>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2 text-right">
                      <IconButton label={`Edit invoice ${b.invoice_no}`} onClick={() => onEdit(b)}>
                        <Pencil className="size-4" />
                      </IconButton>
                      {!filed && (
                        <IconButton label={`Remove invoice ${b.invoice_no}`} onClick={() => remove(b)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 font-semibold text-ink-900">
                <td colSpan={3} className="py-2 pr-4 text-right text-xs text-slate-500">
                  Total
                </td>
                <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums">{money(sum('gross_amount'))}</td>
                <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums">{money(sum('vat_amount'))}</td>
                <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums">{money(sum('ewt_amount'))}</td>
                <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums">{money(sum('net_amount'))}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  )
}

interface BillingForm {
  consultant_id: string
  invoice_no: string
  billed_on: string
  service_from: string
  service_to: string
  description: string
  gross_amount: string
  vat_amount: string
  paid_on: string
  payment_ref: string
  note: string
}

function BillingModal({
  open,
  onClose,
  data,
  editing,
  consultantId,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  data: Data
  editing: ConsultantBilling | null
  consultantId?: string
  onSaved: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const billable = data.consultants.filter((c) => (c.active && c.signed_off_at) || c.id === editing?.consultant_id)
  const [f, setF] = useState<BillingForm>(() => blank())
  function feeFor(id: string): string {
    const c = data.consultants.find((x) => x.id === id)
    if (!c?.fee_amount) return ''
    return String(c.fee_basis === 'retainer' && c.billing === 'semi_monthly' ? round2(Number(c.fee_amount) / 2) : Number(c.fee_amount))
  }
  function blank(): BillingForm {
    if (editing) {
      return {
        consultant_id: editing.consultant_id,
        invoice_no: editing.invoice_no,
        billed_on: editing.billed_on,
        service_from: editing.service_from ?? '',
        service_to: editing.service_to ?? '',
        description: editing.description,
        gross_amount: String(editing.gross_amount),
        vat_amount: Number(editing.vat_amount) ? String(editing.vat_amount) : '',
        paid_on: editing.paid_on ?? '',
        payment_ref: editing.payment_ref,
        note: editing.note,
      }
    }
    const id = consultantId ?? (billable.length === 1 ? billable[0].id : '')
    return {
      consultant_id: id,
      invoice_no: '',
      billed_on: todayManila(),
      service_from: '',
      service_to: '',
      description: '',
      gross_amount: id ? feeFor(id) : '',
      vat_amount: '',
      paid_on: '',
      payment_ref: '',
      note: '',
    }
  }
  useEffect(() => {
    if (open) setF(blank())
    // a fresh form each time it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id, consultantId])

  const consultant = data.consultants.find((c) => c.id === f.consultant_id)
  const filed = !!editing && data.filings.some((x) => x.quarter === quarterOf(editing.billed_on).start)
  const gross = Number(f.gross_amount)
  const vat = Number(f.vat_amount || 0)
  const version = f.billed_on ? ewtVersionOn(data.versions, f.billed_on) : undefined
  const declaration = consultant && f.billed_on ? data.declarations.find((d) => d.consultant_id === consultant.id && d.year === Number(f.billed_on.slice(0, 4))) : undefined
  const rule = consultant && version ? ewtRuleFor(version.data, consultant, declaration) : null
  const ewt = rule && gross > 0 ? ewtAmount(gross, rule.rate) : 0

  async function save() {
    if (!consultant) return toast('error', 'Pick the consultant.')
    if (!filed) {
      if (!f.invoice_no.trim()) return toast('error', "Enter the consultant's invoice number.")
      if (!f.billed_on) return toast('error', 'Enter the date the fee became payable.')
      if (!(gross > 0)) return toast('error', 'Enter the fee, VAT excluded.')
      if (vat < 0) return toast('error', 'The VAT must be zero or more.')
      if (vat > 0 && !consultant.vat_registered) return toast('error', 'VAT on a billing needs a VAT-registered consultant.')
      if (f.service_from && f.service_to && f.service_to < f.service_from) return toast('error', 'The service period ends before it starts.')
      if (!version) return toast('error', `No EWT table is in force on ${fmtDate(f.billed_on)}.`)
    }
    setBusy(true)
    try {
      const row = {
        ...(filed
          ? {}
          : {
              invoice_no: f.invoice_no.trim(),
              billed_on: f.billed_on,
              gross_amount: gross,
              vat_amount: vat,
            }),
        service_from: f.service_from || null,
        service_to: f.service_to || null,
        description: f.description.trim(),
        paid_on: f.paid_on || null,
        payment_ref: f.payment_ref.trim(),
        note: f.note.trim(),
      }
      const { error } = editing
        ? await supabase.from('consultant_billings').update(row).eq('id', editing.id)
        : await supabase.from('consultant_billings').insert({ ...row, consultant_id: consultant.id })
      if (error) throw error
      onSaved()
    } catch (err) {
      const msg = errorMessage(err, 'Save failed')
      toast('error', /invoice_unique/.test(msg) ? 'This consultant already has a billing with that invoice number.' : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Invoice ${editing.invoice_no}` : 'Record a billing'}>
      <div className="space-y-4">
        {filed && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            The quarter's 1601-EQ is marked filed: the fee, its date and invoice are locked. The payment and notes can still change.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Consultant" className="sm:col-span-2">
            <Select
              value={f.consultant_id}
              disabled={!!editing}
              onChange={(e) => setF({ ...f, consultant_id: e.target.value, gross_amount: f.gross_amount || feeFor(e.target.value) })}
            >
              <option value="">Pick a consultant</option>
              {billable.map((c) => (
                <option key={c.id} value={c.id}>
                  {payeeName(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Invoice no.">
            <Input maxLength={60} disabled={filed} value={f.invoice_no} onChange={(e) => setF({ ...f, invoice_no: e.target.value })} />
          </Field>
          <Field label="Billed on" hint="When the fee became payable: its month and quarter carry the withholding">
            <Input type="date" disabled={filed} value={f.billed_on} onChange={(e) => setF({ ...f, billed_on: e.target.value })} />
          </Field>
          <Field label="Service from (optional)">
            <Input type="date" value={f.service_from} onChange={(e) => setF({ ...f, service_from: e.target.value })} />
          </Field>
          <Field label="Service to (optional)">
            <Input type="date" min={f.service_from || undefined} value={f.service_to} onChange={(e) => setF({ ...f, service_to: e.target.value })} />
          </Field>
          <Field label="Fee, VAT excluded (PHP)">
            <Input type="number" min={0} step="0.01" disabled={filed} value={f.gross_amount} onChange={(e) => setF({ ...f, gross_amount: e.target.value })} />
          </Field>
          <Field label="VAT on the invoice (PHP)" hint={consultant && !consultant.vat_registered ? 'None: the consultant is not VAT-registered' : undefined}>
            <Input
              type="number"
              min={0}
              step="0.01"
              disabled={filed || !consultant?.vat_registered}
              value={f.vat_amount}
              onChange={(e) => setF({ ...f, vat_amount: e.target.value })}
            />
          </Field>
          <Field label="Description (optional)" className="sm:col-span-2">
            <Input maxLength={200} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
          <Field label="Paid on (optional)">
            <Input type="date" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} />
          </Field>
          <Field label="Payment reference (optional)">
            <Input maxLength={120} value={f.payment_ref} onChange={(e) => setF({ ...f, payment_ref: e.target.value })} />
          </Field>
        </div>
        <Field label="Note (optional)">
          <Textarea rows={2} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        {consultant && rule && gross > 0 && (
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            <p>
              EWT <b className="text-ink-900">{money(ewt)}</b> at {pct(rule.rate)} ({rule.atc}): {ewtReasonText(rule.reason, rule.threshold)}.
            </p>
            <p>
              Net payable <b className="text-ink-900">{money(round2(gross + vat - ewt))}</b> ({money(gross)} fee{vat ? ` + ${money(vat)} VAT` : ''} − {money(ewt)} EWT).
            </p>
          </div>
        )}
        {consultant && !version && f.billed_on && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">No EWT table is in force on {fmtDate(f.billed_on)}: the system maintainer publishes it.</p>
        )}
        <Button className="w-full" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Record billing'}
        </Button>
      </div>
    </Modal>
  )
}

// ---------- the BIR outputs ----------

function BirTab({
  entity,
  data,
  quarter,
  onQuarter,
  filing,
  onChanged,
}: {
  entity: Entity
  data: Data
  quarter: Quarter
  onQuarter: (start: string) => void
  filing: EwtQuarterFiling | undefined
  onChanged: () => void
}) {
  const toast = useToast()
  const [marking, setMarking] = useState(false)
  const [filedOn, setFiledOn] = useState(todayManila())
  const [reference, setReference] = useState('')
  const facts = useMemo(
    () =>
      data.billings.map((b) => ({
        consultant_id: b.consultant_id,
        billed_on: b.billed_on,
        gross_amount: Number(b.gross_amount),
        atc: b.atc,
        ewt_rate: Number(b.ewt_rate),
        ewt_amount: Number(b.ewt_amount),
      })),
    [data.billings],
  )
  const ret = return1601Eq(facts, quarter)
  const payees = data.consultants.filter((c) => facts.some((b) => b.consultant_id === c.id && b.billed_on >= quarter.start && b.billed_on <= quarter.end))
  const qap = qapRows(payees, facts, quarter)
  const due = ewtDueDates(quarter)
  const unpaid = data.billings.filter((b) => b.billed_on >= quarter.start && b.billed_on <= quarter.end && !b.paid_on).length

  async function markFiled() {
    const { error } = await supabase.from('ewt_quarter_filings').insert({ entity_id: entity.id, quarter: quarter.start, filed_on: filedOn, reference: reference.trim() })
    if (error) return toast('error', errorMessage(error, 'Save failed'))
    toast('success', `${quarter.label} marked filed: its billings are locked.`)
    setMarking(false)
    onChanged()
  }
  async function reopen() {
    if (!filing || !confirm(`Reopen ${quarter.label}? Its billings can change again; an amended 1601-EQ may be needed.`)) return
    const { error } = await supabase.from('ewt_quarter_filings').delete().eq('id', filing.id)
    if (error) return toast('error', errorMessage(error, 'Reopen failed'))
    toast('success', `${quarter.label} reopened.`)
    onChanged()
  }
  function exportQap() {
    downloadCsv(`qap-${entity.code}-${quarter.label.replace(' ', '-')}.csv`, [
      ['Seq', 'TIN', 'Branch code', 'Registered name', 'Last name', 'First name', 'Middle name', 'ATC', 'Nature of income payment', 'Income payment', 'Rate', 'Tax withheld'],
      ...qap.map((r) => [r.seq, r.tin, r.branch, r.registeredName, r.lastName, r.firstName, r.middleName, r.atc, r.nature, r.income, r.rate, r.withheld]),
    ])
  }

  return (
    <div className="space-y-6">
      <Card
        title={`BIR 1601-EQ — ${quarter.label}`}
        icon={<Landmark />}
        actions={<QuarterSelect data={data} quarter={quarter} onQuarter={onQuarter} />}
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">
          {filing ? (
            <>
              <span className="flex items-center gap-2 text-slate-700">
                <Lock className="size-4" /> Filed {fmtDate(filing.filed_on)}
                {filing.reference ? ` · ${filing.reference}` : ''}: the quarter's billings are locked.
              </span>
              <Button size="sm" variant="secondary" onClick={reopen}>
                <Unlock className="size-4" /> Reopen
              </Button>
            </>
          ) : (
            <>
              <span className="text-slate-600">
                Not marked filed. Due {fmtDate(due.return1601eq)}, with the Quarterly Alphalist of Payees.
                {unpaid > 0 ? ` ${unpaid} billing${unpaid === 1 ? ' is' : 's are'} not marked paid yet.` : ''}
              </span>
              <Button size="sm" variant="secondary" onClick={() => setMarking(true)} disabled={ret.rows.length === 0}>
                <Lock className="size-4" /> Mark filed
              </Button>
            </>
          )}
        </div>
        {ret.rows.length === 0 ? (
          <p className="text-sm text-slate-400">No billing in {quarter.label}.</p>
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1.5 pr-4 font-semibold">ATC</th>
                  <th className="py-1.5 pr-4 text-right font-semibold">Tax base</th>
                  <th className="py-1.5 pr-4 text-right font-semibold">Rate</th>
                  <th className="py-1.5 text-right font-semibold">Tax withheld</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ret.rows.map((r) => (
                  <tr key={`${r.atc}${r.rate}`}>
                    <td className="py-2 pr-4 text-ink-900">{r.atc}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{money(r.base)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{pct(r.rate)}</td>
                    <td className="py-2 text-right tabular-nums">{money(r.withheld)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200 font-semibold text-ink-900">
                  <td colSpan={3} className="py-2 pr-4 text-right text-xs text-slate-500">
                    Total withheld in the quarter
                  </td>
                  <td className="py-2 text-right tabular-nums">{money(ret.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          {quarter.months.map((m, k) => (
            <div key={m} className="rounded-lg border border-slate-200 px-3 py-2">
              <dt className="text-xs text-slate-500">
                {fmtDate(`${m}-01`).replace(/ 1,/, '')} withheld
              </dt>
              <dd className="font-semibold text-ink-900">{money(ret.byMonth[k])}</dd>
              <dd className="text-xs text-slate-500">
                {k < 2 ? `0619-E due ${fmtDate(due.monthly[k])}` : 'remitted with the 1601-EQ'}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-slate-500">{due.note}</p>
      </Card>

      <Card
        title={`BIR 2307 and Quarterly Alphalist of Payees — ${quarter.label}`}
        icon={<FileText />}
        actions={
          qap.length > 0 && (
            <>
              <Button size="sm" variant="secondary" onClick={exportQap}>
                <Download className="size-4" /> QAP CSV
              </Button>
              <Button size="sm" variant="secondary" onClick={() => print2307(entity, payees, facts, quarter)}>
                <Printer className="size-4" /> Print all 2307 figures
              </Button>
            </>
          )
        }
      >
        {payees.length === 0 ? (
          <p className="text-sm text-slate-400">No payee in {quarter.label}.</p>
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1.5 pr-4 font-semibold">Payee</th>
                  <th className="py-1.5 pr-4 font-semibold">ATC</th>
                  {quarter.months.map((m) => (
                    <th key={m} className="py-1.5 pr-4 text-right font-semibold">
                      {fmtDate(`${m}-01`).replace(/ 1,/, '')}
                    </th>
                  ))}
                  <th className="py-1.5 pr-4 text-right font-semibold">Total</th>
                  <th className="py-1.5 pr-4 text-right font-semibold">Withheld</th>
                  <th className="py-1.5 font-semibold"> </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payees.flatMap((p) =>
                  form2307Rows(facts.filter((b) => b.consultant_id === p.id), quarter).map((r, i) => (
                    <tr key={`${p.id}${r.atc}`}>
                      <td className="py-2 pr-4 text-ink-900">
                        {i === 0 && (
                          <>
                            {payeeName(p)}
                            <p className="text-xs text-slate-500">TIN {fmtTin(p.tin, p.tin_branch_code)}</p>
                          </>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-slate-700">{r.atc}</td>
                      {r.months.map((v, k) => (
                        <td key={k} className="whitespace-nowrap py-2 pr-4 text-right tabular-nums">{v ? money(v) : '—'}</td>
                      ))}
                      <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums">{money(r.total)}</td>
                      <td className="whitespace-nowrap py-2 pr-4 text-right font-semibold tabular-nums">{money(r.withheld)}</td>
                      <td className="py-2 text-right">
                        {i === 0 && (
                          <IconButton label={`Print the 2307 figures of ${payeeName(p)}`} onClick={() => print2307(entity, [p], facts, quarter)}>
                            <Printer className="size-4" />
                          </IconButton>
                        )}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Working figures for the official forms: give each payee a signed BIR Form 2307 by {fmtDate(due.form2307)}; the alphalist is
          prepared in the BIR's alphalist module from these rows. Consultants never appear in the 1601-C, 2316 or 1604-C.
        </p>
      </Card>

      <Modal open={marking} onClose={() => setMarking(false)} title={`Mark ${quarter.label} filed`}>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">The quarter's billings lock: a change after filing needs the quarter reopened (and an amended return).</p>
          <Field label="Filed on">
            <Input type="date" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} />
          </Field>
          <Field label="Reference (optional)" hint="e.g. the filing reference number">
            <Input maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Button className="w-full" disabled={!filedOn} onClick={markFiled}>
            Mark filed
          </Button>
        </div>
      </Modal>
    </div>
  )
}

/** The 2307 working figures of the payees for a quarter, printed one per page. */
function print2307(entity: Entity, payees: Consultant[], facts: Parameters<typeof form2307Rows>[0], quarter: Quarter) {
  const w = window.open('', '_blank', 'width=760,height=900')
  if (!w) return
  const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
  const val = (v: number) => v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const month = (m: string) => fmtDate(`${m}-01`).replace(/ 1,/, '')
  const sheet = (p: Consultant) => {
    const rows = form2307Rows(facts.filter((b) => b.consultant_id === p.id), quarter)
    const cells = rows
      .map(
        (r) =>
          `<tr><td>${esc(r.atc)}</td>${r.months.map((v) => `<td style="text-align:right">${val(v)}</td>`).join('')}<td style="text-align:right">${val(r.total)}</td><td style="text-align:right">${val(r.withheld)}</td></tr>`,
      )
      .join('')
    return `<section style="page-break-after:always">
      <h2 style="margin:0">BIR Form 2307 figures — ${esc(quarter.label)}</h2>
      <p style="font-size:12px;color:#475569">Working figures for the official BIR Form 2307 (Certificate of Creditable Tax Withheld at Source), period ${esc(fmtDate(quarter.start))} to ${esc(fmtDate(quarter.end))}.</p>
      <p style="font-size:12px"><b>Payee:</b> ${esc(payeeName(p))} · TIN ${esc(fmtTin(p.tin, p.tin_branch_code))}<br/>
      <b>Registered address:</b> ${esc(p.address || '—')} ${esc(p.zip_code)}<br/>
      <b>Payor:</b> ${esc(entity.name)} · TIN ${esc(fmtTin(entity.tin, entity.tin_branch_code))} · ${esc(entity.registered_address)} ${esc(entity.zip_code)}</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px" border="1" cellpadding="4">
        <tr><th>ATC</th>${quarter.months.map((m) => `<th>${esc(month(m))}</th>`).join('')}<th>Total</th><th>Tax withheld</th></tr>
        ${cells}
      </table>
      <p style="font-size:12px">Income payment: ${esc(p.service)}</p></section>`
  }
  w.document.write(
    `<html><head><title>BIR 2307 figures — ${esc(entity.name)} ${esc(quarter.label)}</title></head><body style="font-family:sans-serif;padding:24px;color:#0f172a">${payees.map(sheet).join('')}</body></html>`,
  )
  w.document.close()
  w.print()
}
