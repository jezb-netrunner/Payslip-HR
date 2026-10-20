import { useCallback, useEffect, useState } from 'react'
import { Pencil, Plus, ShieldCheck } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, TableShell, Td, Th, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { callAdminUsers } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import type { EntityAdmin, Profile } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { ROLE_LABELS } from '../../lib/labels'
import { supabase } from '../../lib/supabase'

export default function Users() {
  const { profile: me } = useAuth()
  const { entities } = useEntity()
  const [admins, setAdmins] = useState<Profile[]>([])
  const [links, setLinks] = useState<EntityAdmin[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Profile | null>(null)

  const load = useCallback(async () => {
    const [{ data: profs }, { data: ea }] = await Promise.all([
      supabase.from('profiles').select('*').in('role', ['company_admin', 'entity_admin']).order('full_name'),
      supabase.from('entity_admins').select('*'),
    ])
    setAdmins((profs ?? []) as Profile[])
    setLinks((ea ?? []) as EntityAdmin[])
    setLoading(false)
  }, [])

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
                    <p className="font-semibold text-slate-800">{a.full_name || '—'}{a.id === me?.id && ' (you)'}</p>
                    <p className="text-xs text-slate-400">{a.email}</p>
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
                  <Td>{a.is_active ? <Badge tone="green">active</Badge> : <Badge tone="red">deactivated</Badge>}</Td>
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
      <Card className="mt-6" title="Employees">
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

  async function save() {
    setBusy(true)
    try {
      const res = await callAdminUsers({ action: 'create_admin', ...f })
      if (res.error) throw new Error(res.error)
      toast('success', 'Admin account created. Share the temporary password securely.')
      setF({ full_name: '', email: '', password: '', role: 'entity_admin', entity_ids: [] })
      await onSaved()
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed')
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
        <Field label="Temporary password (min 8 characters)" hint="They can change it from the key icon after signing in.">
          <Input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
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
        <Button className="w-full" disabled={busy || f.password.length < 8} onClick={save}>
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
      toast('error', err instanceof Error ? err.message : 'Failed')
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
        <Field label="Reset password (leave blank to keep)">
          <Input value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {!isSelf && <Toggle checked={active} onChange={setActive} label="Account active" />}
        <Button className="w-full" disabled={busy || (password.length > 0 && password.length < 8)} onClick={save}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </Modal>
  )
}
