import { useCallback, useEffect, useState } from 'react'
import { LockOpen, Pencil, Plus, ShieldCheck, Users as UsersIcon } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, TableShell, Td, Th, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { callAdminUsers } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import type { EntityAdmin, Profile } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { ROLE_LABELS } from '../../lib/labels'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errors'
import { fmtDateTime } from '../../lib/format'
import { PASSWORD_RULE, passwordProblem } from '../../lib/password'

/** The sign-in guard's record of an admin account (admin-users: admin_security). */
interface AccountSecurity {
  user_id: string
  failed_attempts?: number
  locked_until?: string | null
  last_sign_in_at?: string | null
  password_changed_at?: string | null
}

export default function Users() {
  const { profile: me } = useAuth()
  const { entities } = useEntity()
  const [admins, setAdmins] = useState<Profile[]>([])
  const [links, setLinks] = useState<EntityAdmin[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Profile | null>(null)
  const [security, setSecurity] = useState<Map<string, AccountSecurity>>(new Map())
  const [unlocking, setUnlocking] = useState<string | null>(null)
  const notify = useToast()

  const load = useCallback(async () => {
    try {
      const [{ data: profs }, { data: ea }, sec] = await Promise.all([
        supabase.from('profiles').select('*').in('role', ['company_admin', 'entity_admin']).order('full_name'),
        supabase.from('entity_admins').select('*'),
        // the lock status is extra: the list shows without it
        (callAdminUsers({ action: 'admin_security' }) as Promise<{ accounts?: AccountSecurity[]; error?: string }>).catch(
          () => ({ accounts: undefined }),
        ),
      ])
      setAdmins((profs ?? []) as Profile[])
      setLinks((ea ?? []) as EntityAdmin[])
      setSecurity(new Map((sec.accounts ?? []).map((a) => [a.user_id, a])))
    } finally {
      setLoading(false)
    }
  }, [])

  async function unlock(a: Profile) {
    setUnlocking(a.id)
    try {
      const res = await callAdminUsers({ action: 'unlock_admin', user_id: a.id })
      if (res.error) throw new Error(res.error)
      notify('success', `${a.full_name || a.email} can sign in again.`)
      await load()
    } catch (err) {
      notify('error', errorMessage(err, 'Could not unlock the account'))
    } finally {
      setUnlocking(null)
    }
  }

  useEffect(() => {
    load()
  }, [load])

  const clientNames = (profileId: string) =>
    links
      .filter((l) => l.profile_id === profileId)
      .map((l) => entities.find((e) => e.id === l.entity_id)?.code ?? '?')

  return (
    <div>
      <PageHeader
        title="Admin Users"
        subtitle="Company admins see every client and maintain statutory tables. Entity admins run HR and payroll for the clients assigned to them."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Add admin
          </Button>
        }
      />
      {loading ? (
        <Spinner />
      ) : (
        <TableShell>
          <thead className="bg-slate-50">
            <tr>
              <Th>Name</Th>
              <Th>Role</Th>
              <Th>Clients</Th>
              <Th>Status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {admins.map((a) => {
              const isOtherCompanyAdmin = a.role === 'company_admin' && a.id !== me?.id
              return (
                <tr key={a.id} className="hover:bg-slate-50">
                  <Td>
                    <p className="font-semibold text-slate-800">{a.full_name || a.email || '—'}{a.id === me?.id && ' (you)'}</p>
                    {a.full_name && <p className="text-xs text-slate-400">{a.email}</p>}
                  </Td>
                  <Td>
                    <Badge tone={a.role === 'company_admin' ? 'violet' : 'blue'}>{ROLE_LABELS[a.role]}</Badge>
                  </Td>
                  <Td className="text-xs">
                    {a.role === 'company_admin' ? (
                      <span className="text-slate-400">all clients</span>
                    ) : clientNames(a.id).length ? (
                      <span className="font-mono">{clientNames(a.id).join(', ')}</span>
                    ) : (
                      <span className="text-amber-600">none assigned</span>
                    )}
                  </Td>
                  <Td>
                    {(() => {
                      const sec = security.get(a.id)
                      const locked = !!sec?.locked_until && new Date(sec.locked_until) > new Date()
                      return (
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {a.is_active ? <Badge tone="green">active</Badge> : <Badge tone="red">deactivated</Badge>}
                            {locked && <Badge tone="red">locked until {fmtDateTime(sec!.locked_until!)}</Badge>}
                            {locked && (
                              <button
                                type="button"
                                disabled={unlocking === a.id}
                                onClick={() => unlock(a)}
                                className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800"
                              >
                                <LockOpen className="size-3.5" /> Unlock
                              </button>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400">
                            {sec?.last_sign_in_at ? `Signed in ${fmtDateTime(sec.last_sign_in_at)}` : 'No guarded sign-in yet'}
                            {' · '}
                            {sec?.password_changed_at ? `password changed ${fmtDateTime(sec.password_changed_at)}` : 'temporary password'}
                            {!!sec?.failed_attempts && !locked && ` · ${sec.failed_attempts} failed sign-in${sec.failed_attempts === 1 ? '' : 's'}`}
                          </p>
                        </div>
                      )
                    })()}
                  </Td>
                  <Td>
                    {isOtherCompanyAdmin ? (
                      <span className="flex items-center gap-1 text-[11px] text-slate-400" title="Company admins can only manage their own account">
                        <ShieldCheck className="size-3.5" /> protected
                      </span>
                    ) : (
                      <button
                        onClick={() => setEditing(a)}
                        className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800"
                      >
                        <Pencil className="size-3.5" /> Manage
                      </button>
                    )}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </TableShell>
      )}
      <Card className="mt-6" title="Employees" icon={<UsersIcon />}>
        <p className="text-sm text-slate-600">
          Employees don't have email accounts. Their entity admin issues each one a personal login code
          (Employees → employee → Login Code), shaped like <span className="font-mono font-semibold">CLIENTCODE-XXXXXXXX</span>.
        </p>
      </Card>

      <CreateAdminModal open={creating} onClose={() => setCreating(false)} onSaved={async () => { setCreating(false); await load() }} />
      {editing && (
        <EditAdminModal
          admin={editing}
          assigned={links.filter((l) => l.profile_id === editing.id).map((l) => l.entity_id)}
          isSelf={editing.id === me?.id}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

function ClientPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { entities } = useEntity()
  const active = entities.filter((e) => e.is_active)
  if (active.length === 0) return <p className="text-xs text-slate-400">Add a client first.</p>
  return (
    <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-slate-200 p-3">
      {active.map((e) => (
        <label key={e.id} className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={value.includes(e.id)}
            onChange={(ev) => onChange(ev.target.checked ? [...value, e.id] : value.filter((x) => x !== e.id))}
            className="rounded border-slate-300"
          />
          {e.name} <span className="font-mono text-xs text-slate-400">{e.code}</span>
        </label>
      ))}
    </div>
  )
}

function CreateAdminModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({ full_name: '', email: '', password: '', role: 'entity_admin', entity_ids: [] as string[] })

  const problem = f.password ? passwordProblem(f.password, f.email) : 'Enter a temporary password.'

  async function save() {
    setBusy(true)
    try {
      const res = await callAdminUsers({ action: 'create_admin', ...f })
      if (res.error) throw new Error(res.error)
      toast('success', 'Admin account created. Share the temporary password securely.')
      setF({ full_name: '', email: '', password: '', role: 'entity_admin', entity_ids: [] })
      await onSaved()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add admin">
      <div className="space-y-4">
        <Field label="Full name">
          <Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
        </Field>
        <Field label="Email (used to sign in)">
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Temporary password" hint={`${PASSWORD_RULE} They choose their own at the first sign-in.`}>
          <Input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
        {f.password && problem && <p className="text-xs text-rose-600">{problem}</p>}
        <Field label="Role">
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="entity_admin">Entity admin — HR & payroll for assigned clients</option>
            <option value="company_admin">Company admin — every client, statutory tables, users</option>
          </Select>
        </Field>
        {f.role === 'entity_admin' && (
          <Field label="Clients">
            <ClientPicker value={f.entity_ids} onChange={(ids) => setF({ ...f, entity_ids: ids })} />
          </Field>
        )}
        <Button className="w-full" disabled={busy || !!problem} onClick={save}>
          {busy ? 'Creating…' : 'Create admin'}
        </Button>
      </div>
    </Modal>
  )
}

function EditAdminModal({
  admin,
  assigned,
  isSelf,
  onClose,
  onSaved,
}: {
  admin: Profile
  assigned: string[]
  isSelf: boolean
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [fullName, setFullName] = useState(admin.full_name)
  const [ids, setIds] = useState<string[]>(assigned)
  const [password, setPassword] = useState('')
  const [active, setActive] = useState(admin.is_active)
  const problem = password ? passwordProblem(password, admin.email ?? '') : null

  async function save() {
    setBusy(true)
    try {
      const body: Record<string, unknown> = { action: 'update_admin', user_id: admin.id, full_name: fullName }
      if (admin.role === 'entity_admin') body.entity_ids = ids
      if (password) body.password = password
      if (!isSelf && active !== admin.is_active) body.active = active
      const res = await callAdminUsers(body)
      if (res.error) throw new Error(res.error)
      toast('success', 'Saved.')
      await onSaved()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`Manage ${admin.full_name || admin.email}`}>
      <div className="space-y-4">
        <Field label="Full name">
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        {admin.role === 'entity_admin' && (
          <Field label="Clients">
            <ClientPicker value={ids} onChange={setIds} />
          </Field>
        )}
        {isSelf ? (
          <p className="text-xs text-slate-500">To change your own password, use the key icon by your name: it asks for the current one first.</p>
        ) : (
          <>
            <Field
              label="Reset password (leave blank to keep)"
              hint={`${PASSWORD_RULE} A password you set for someone else is temporary: their sessions end now, and they choose their own at the next sign-in.`}
            >
              <Input value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {problem && <p className="text-xs text-rose-600">{problem}</p>}
          </>
        )}
        {!isSelf && <Toggle checked={active} onChange={setActive} label="Account active" />}
        <Button className="w-full" disabled={busy || !!problem} onClick={save}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </Modal>
  )
}
