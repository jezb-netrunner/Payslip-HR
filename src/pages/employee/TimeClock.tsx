import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, LogIn, LogOut, MapPin, ShieldCheck } from 'lucide-react'
import CameraCapture from '../../components/CameraCapture'
import { Badge, Button, Card, Modal, Spinner, StatCard } from '../../components/ui'
import { useToast } from '../../components/toast'
import { getDeviceInfo, getLocation, getSettings, uploadPunchSelfie } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import type { CompanySettings, TimeEntry } from '../../lib/db'
import { fmtDate, fmtHours, fmtTime } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'

export default function TimeClock() {
  const { employee } = useAuth()
  const toast = useToast()
  const [now, setNow] = useState(new Date())
  const [openEntry, setOpenEntry] = useState<TimeEntry | null>(null)
  const [recent, setRecent] = useState<TimeEntry[]>([])
  const [settings, setSettings] = useState<CompanySettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [punching, setPunching] = useState<'in' | 'out' | null>(null)
  const [selfieBlob, setSelfieBlob] = useState<Blob | null>(null)
  const [cameraDown, setCameraDown] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const load = useCallback(async () => {
    if (!employee) return
    const [{ data: open }, { data: rec }, s] = await Promise.all([
      supabase
        .from('time_entries')
        .select('*')
        .eq('employee_id', employee.id)
        .is('clock_out', null)
        .maybeSingle(),
      supabase
        .from('time_entries')
        .select('*')
        .eq('employee_id', employee.id)
        .order('clock_in', { ascending: false })
        .limit(7),
      getSettings(),
    ])
    setOpenEntry((open as TimeEntry) ?? null)
    setRecent((rec ?? []) as TimeEntry[])
    setSettings(s)
    setLoading(false)
  }, [employee])

  useEffect(() => {
    load()
  }, [load])

  async function punch(direction: 'in' | 'out') {
    if (!employee || !settings) return
    if (settings.require_selfie_on_punch && !selfieBlob && !cameraDown) {
      toast('error', 'Capture your verification selfie first.')
      return
    }
    setBusy(true)
    try {
      let selfiePath: string | null = null
      if (selfieBlob) {
        selfiePath = await uploadPunchSelfie(employee.id, selfieBlob, direction)
      }
      const device = getDeviceInfo()
      const location = await getLocation()
      const { error } = await supabase.rpc(direction === 'in' ? 'clock_in' : 'clock_out', {
        p_selfie_path: selfiePath,
        p_device: device,
        p_location: location,
      })
      if (error) throw error
      toast('success', direction === 'in' ? 'Clocked in. Have a great shift!' : 'Clocked out. See you!')
      setPunching(null)
      setSelfieBlob(null)
      await load()
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Punch failed')
    } finally {
      setBusy(false)
    }
  }

  if (loading || !employee) return <Spinner />

  const manilaTime = now.toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })
  const manilaDate = now.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const openMinutes = openEntry
    ? Math.max(0, (now.getTime() - new Date(openEntry.clock_in).getTime()) / 60000)
    : 0

  const today = todayManila()
  const todayMinutes = recent
    .filter((e) => e.work_date === today && e.clock_out)
    .reduce((s, e) => s + (new Date(e.clock_out!).getTime() - new Date(e.clock_in).getTime()) / 60000, 0)

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-gradient-to-br from-brand-900 to-brand-700 p-8 text-center text-white shadow-md">
        <p className="text-sm font-medium text-brand-200">{manilaDate}</p>
        <p className="my-2 font-mono text-5xl font-extrabold tracking-tight">{manilaTime}</p>
        <p className="mb-6 text-xs uppercase tracking-widest text-brand-300">Philippine Standard Time</p>
        {openEntry ? (
          <div className="space-y-3">
            <p className="text-sm">
              On the clock since <b>{fmtTime(openEntry.clock_in)}</b> ({fmtHours(openMinutes)})
            </p>
            <Button
              variant="accent"
              className="animate-pulse-ring px-8 py-3 text-base"
              onClick={() => setPunching('out')}
            >
              <LogOut className="size-5" /> Clock Out
            </Button>
          </div>
        ) : (
          <Button
            variant="accent"
            className="animate-pulse-ring px-8 py-3 text-base"
            onClick={() => setPunching('in')}
          >
            <LogIn className="size-5" /> Clock In
          </Button>
        )}
        <p className="mt-5 flex items-center justify-center gap-1.5 text-[11px] text-brand-300">
          <ShieldCheck className="size-3.5" />
          Punches are timestamped by the server and verified with selfie, device and location checks.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Hours today" value={fmtHours(todayMinutes + openMinutes)} />
        <StatCard
          label="Status"
          value={openEntry ? 'Clocked in' : 'Off the clock'}
          tone={openEntry ? 'good' : 'default'}
        />
        <StatCard
          label="Schedule"
          value={`${employee.work_schedule.start}–${employee.work_schedule.end}`}
          sub={`Break: ${employee.work_schedule.break_minutes} min`}
        />
      </div>

      <Card title="Recent punches">
        {recent.length === 0 ? (
          <p className="text-sm text-slate-400">No punches yet.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {recent.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div>
                  <p className="text-sm font-semibold text-slate-700">{fmtDate(e.work_date)}</p>
                  <p className="text-xs text-slate-500">
                    {fmtTime(e.clock_in)} → {e.clock_out ? fmtTime(e.clock_out) : 'in progress'}
                    {e.clock_out &&
                      ` · ${fmtHours((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 60000)}`}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {e.manually_edited && <Badge tone="violet">corrected</Badge>}
                  {e.flags.filter((f) => f !== 'corrected').length > 0 && (
                    <Badge tone="amber">
                      <AlertTriangle className="mr-1 size-3" />
                      {e.flags.filter((f) => f !== 'corrected').join(', ').replaceAll('_', ' ')}
                    </Badge>
                  )}
                  <Badge tone={e.clock_out ? 'slate' : 'green'}>{e.clock_out ? 'closed' : 'open'}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={punching !== null}
        onClose={() => {
          setPunching(null)
          setSelfieBlob(null)
        }}
        title={punching === 'in' ? 'Clock In — verify it’s you' : 'Clock Out — verify it’s you'}
      >
        <div className="space-y-4">
          <CameraCapture onCapture={setSelfieBlob} onUnavailable={() => setCameraDown(true)} />
          {settings?.require_location_on_punch && (
            <p className="flex items-center gap-1.5 text-xs text-slate-500">
              <MapPin className="size-3.5" /> Your location will be recorded with this punch.
            </p>
          )}
          <Button
            className="w-full"
            disabled={busy || (settings?.require_selfie_on_punch && !selfieBlob && !cameraDown)}
            onClick={() => punch(punching!)}
          >
            {busy ? 'Recording punch…' : punching === 'in' ? 'Confirm Clock In' : 'Confirm Clock Out'}
          </Button>
          <p className="text-center text-[11px] text-slate-400">
            Punching for another employee is a violation of company policy. Every punch records
            your selfie, device fingerprint, IP address and time from the server clock.
          </p>
        </div>
      </Modal>
    </div>
  )
}
