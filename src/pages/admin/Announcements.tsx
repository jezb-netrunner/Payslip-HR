import { useCallback, useEffect, useState } from 'react'
import { Megaphone, Pencil, Pin, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, NoClient, PageHeader, Spinner, Textarea, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { useAuth } from '../../lib/auth'
import type { Announcement, Entity } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDateTime } from '../../lib/format'
import { supabase } from '../../lib/supabase'

export default function Announcements() {
  const { entity } = useEntity()
  const { isCompanyAdmin } = useAuth()
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  return <AnnouncementList key={entity.id} entity={entity} />
}

/** datetime-local value in Manila wall time <-> ISO instant. */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  return new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16)
}
function fromLocalInput(v: string): string | null {
  if (!v) return null
  return new Date(new Date(`${v}:00Z`).getTime() - 8 * 3600 * 1000).toISOString()
}

function status(a: Announcement): { label: string; tone: string } {
  const now = Date.now()
  if (new Date(a.published_at).getTime() > now) return { label: 'scheduled', tone: 'blue' }
  if (a.expires_at && new Date(a.expires_at).getTime() <= now) return { label: 'expired', tone: 'slate' }
  return { label: 'live', tone: 'green' }
}

function AnnouncementList({ entity }: { entity: Entity }) {
  const toast = useToast()
  const [items, setItems] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Partial<Announcement> | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('announcements')
      .select('*')
      .eq('entity_id', entity.id)
      .order('pinned', { ascending: false })
      .order('published_at', { ascending: false })
    setItems((data ?? []) as Announcement[])
    setLoading(false)
  }, [entity.id])

  useEffect(() => {
    load()
  }, [load])

  async function remove(a: Announcement) {
    if (!confirm(`Delete "${a.title}"?`)) return
    const { error } = await supabase.from('announcements').delete().eq('id', a.id)
    if (error) toast('error', error.message)
    else await load()
  }

  return (
    <div>
      <PageHeader
        title="Announcements"
        subtitle={`Shown on the employee portal of ${entity.name}. Pinned posts stay on top.`}
        actions={
          <Button onClick={() => setEditing({ pinned: false, published_at: new Date().toISOString() })}>
            <Plus className="size-4" /> New announcement
          </Button>
        }
      />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState title="No announcements yet" sub="Post payday changes, holiday schedules, policy reminders and the like." />
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((a) => {
            const st = status(a)
            return (
              <Card key={a.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex gap-3">
                    <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-50">
                      {a.pinned ? <Pin className="size-4 text-accent-600" /> : <Megaphone className="size-4 text-accent-600" />}
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-800">
                        {a.title} <Badge tone={st.tone}>{st.label}</Badge>
                      </p>
                      <p className="text-xs text-slate-400">
                        {fmtDateTime(a.published_at)}
                        {a.expires_at && ` · until ${fmtDateTime(a.expires_at)}`}
                      </p>
                      <p className="mt-2 whitespace-pre-line text-sm text-slate-600">{a.body}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => setEditing(a)} className="text-slate-400 hover:text-brand-700" title="Edit">
                      <Pencil className="size-4" />
                    </button>
                    <button onClick={() => remove(a)} className="text-slate-300 hover:text-rose-500" title="Delete">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {editing && (
        <EditModal
          entity={entity}
          initial={editing}
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

function EditModal({
  entity,
  initial,
  onClose,
  onSaved,
}: {
  entity: Entity
  initial: Partial<Announcement>
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [f, setF] = useState({
    title: initial.title ?? '',
    body: initial.body ?? '',
    pinned: initial.pinned ?? false,
    published: toLocalInput(initial.published_at ?? null),
    expires: toLocalInput(initial.expires_at ?? null),
  })
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!f.title.trim()) return toast('error', 'A title is required.')
    setBusy(true)
    const { data: userData } = await supabase.auth.getUser()
    const payload = {
      entity_id: entity.id,
      title: f.title.trim(),
      body: f.body,
      pinned: f.pinned,
      published_at: fromLocalInput(f.published) ?? new Date().toISOString(),
      expires_at: fromLocalInput(f.expires),
    }
    const { error } = initial.id
      ? await supabase.from('announcements').update(payload).eq('id', initial.id)
      : await supabase.from('announcements').insert({ ...payload, created_by: userData.user?.id ?? null })
    setBusy(false)
    if (error) toast('error', /expires_at/.test(error.message) ? 'The expiry must be after the publish time.' : error.message)
    else {
      toast('success', 'Announcement saved.')
      await onSaved()
    }
  }

  return (
    <Modal open onClose={onClose} title={initial.id ? 'Edit announcement' : 'New announcement'}>
      <div className="space-y-4">
        <Field label="Title">
          <Input value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Message">
          <Textarea rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Publish at (PH time)">
            <Input type="datetime-local" value={f.published} onChange={(e) => setF({ ...f, published: e.target.value })} />
          </Field>
          <Field label="Hide after (optional)">
            <Input type="datetime-local" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} />
          </Field>
        </div>
        <Toggle checked={f.pinned} onChange={(v) => setF({ ...f, pinned: v })} label="Pin to the top of the employee dashboard" />
        <Button className="w-full" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </Modal>
  )
}
