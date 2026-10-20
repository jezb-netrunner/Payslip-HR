import { useEffect, useState } from 'react'
import { Megaphone, Pin } from 'lucide-react'
import { Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import type { Announcement } from '../../lib/db'
import { fmtDateTime } from '../../lib/format'
import { supabase } from '../../lib/supabase'

export default function MyAnnouncements() {
  const [items, setItems] = useState<Announcement[] | null>(null)

  useEffect(() => {
    // RLS returns only your company's published, unexpired announcements
    supabase
      .from('announcements')
      .select('*')
      .order('pinned', { ascending: false })
      .order('published_at', { ascending: false })
      .then(({ data }) => setItems((data ?? []) as Announcement[]))
  }, [])

  if (!items) return <Spinner />
  return (
    <div>
      <PageHeader title="Announcements" subtitle="News and reminders from your HR and payroll team" />
      {items.length === 0 ? (
        <Card>
          <EmptyState title="No announcements" />
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <Card key={a.id}>
              <div className="flex gap-3">
                <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-50">
                  {a.pinned ? <Pin className="size-4 text-accent-600" /> : <Megaphone className="size-4 text-accent-600" />}
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-800">{a.title}</p>
                  <p className="text-xs text-slate-400">{fmtDateTime(a.published_at)}</p>
                  <p className="mt-2 whitespace-pre-line text-sm text-slate-600">{a.body}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
