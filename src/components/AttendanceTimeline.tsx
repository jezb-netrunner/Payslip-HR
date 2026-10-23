import { FilePen } from 'lucide-react'
import type { TimeEntry } from '../lib/db'
import { fmtHours, fmtTime } from '../lib/format'
import { eachDate, manilaInstant } from '../lib/manila'
import { dayTimeline, shiftOn, timelineWindow, type SegmentKind } from '../lib/timeline'
import type { WorkSchedule } from '../payroll/types'
import { Badge } from './ui'

const LOOK: Record<SegmentKind | 'leave', { label: string; bar: string }> = {
  late: { label: 'Late', bar: 'bg-late text-white' },
  work: { label: 'Working time', bar: 'bg-work text-white' },
  break: { label: 'Break', bar: 'bg-break text-ink-900' },
  overtime: { label: 'Overtime', bar: 'bg-overtime text-ink-900' },
  leave: { label: 'On leave', bar: 'stripes bg-dayoff text-ink-900' },
}

export interface TimelineLeave {
  start_date: string
  end_date: string
  label: string
}

function clock(min: number) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function dayTitle(date: string, today: string) {
  if (date === today) return 'Today'
  return manilaInstant(date, 12 * 60).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}

export function TimelineLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-500">
      {(['work', 'break', 'late', 'overtime', 'leave'] as const).map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className={`h-2.5 w-4 rounded-sm ${LOOK[k].bar}`} />
          {LOOK[k].label}
        </span>
      ))}
    </div>
  )
}

/**
 * One row per day (newest first): time in, a bar on a shared Manila clock axis
 * (work, breaks, a late start, overtime past the shift; leave days striped),
 * time out and hours. Days come from the entries plus approved leave up to
 * `today` inside [from, to].
 */
export default function AttendanceTimeline({
  entries,
  schedule,
  leaves = [],
  from,
  to,
  today,
  graceMinutes = 0,
  onRequestFix,
}: {
  entries: TimeEntry[]
  schedule: WorkSchedule | null | undefined
  /** the client's late grace period, so "late" matches payroll */
  graceMinutes?: number
  leaves?: TimelineLeave[]
  from: string
  to: string
  today: string
  onRequestFix?: (entry: TimeEntry) => void
}) {
  const last = to < today ? to : today
  const leaveOn = (date: string) => leaves.find((l) => l.start_date <= date && l.end_date >= date)
  const dates = new Set(entries.map((e) => e.work_date))
  if (last >= from) for (const d of eachDate(from, last)) if (leaveOn(d)) dates.add(d)
  const days = [...dates]
    .filter((d) => d >= from && d <= to)
    .sort()
    .reverse()
    .map((date) => {
      const mine = entries.filter((e) => e.work_date === date)
      const line = dayTimeline(date, mine, schedule, {
        now: date === today ? new Date().toISOString() : undefined,
        graceMinutes,
      })
      return { date, entries: mine, line, leave: mine.length ? undefined : leaveOn(date) }
    })
  const [lo, hi] = timelineWindow(
    days.map((d) => d.line),
    days.map((d) => shiftOn(d.date, schedule)),
  )
  const span = hi - lo
  const step = span > 1440 ? 240 : 120
  const ticks: number[] = []
  for (let m = lo; m <= hi; m += step) ticks.push(m)
  const pct = (m: number) => ((m - lo) / span) * 100

  if (days.length === 0) return null

  return (
    <div className="space-y-3">
      {days.map(({ date, entries: mine, line, leave }) => {
        const flags = [...new Set(mine.flatMap((e) => e.flags.filter((f) => f !== 'corrected')))]
        const corrected = mine.some((e) => e.manually_edited)
        const firstEntry = [...mine].sort((a, b) => a.clock_in.localeCompare(b.clock_in))[0]
        const lastOut = mine.filter((e) => e.clock_out).sort((a, b) => b.clock_out!.localeCompare(a.clock_out!))[0]
        return (
          <div key={date} className="rounded-xl border border-slate-200/80 bg-white p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="font-bold text-ink-900">{dayTitle(date, today)}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {line.late && <Badge tone="red">late</Badge>}
                {line.open && <Badge tone="amber">no time out</Badge>}
                {corrected && <Badge tone="violet">corrected</Badge>}
                {flags.map((f) => (
                  <Badge key={f} tone="amber">{f.replaceAll('_', ' ')}</Badge>
                ))}
                {leave && <Badge tone="amber">{leave.label}</Badge>}
                {onRequestFix &&
                  mine.map((e, i) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => onRequestFix(e)}
                      className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                    >
                      <FilePen className="size-3.5" /> Request fix{mine.length > 1 ? ` (${i + 1})` : ''}
                    </button>
                  ))}
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-[96px_minmax(0,1fr)_170px] md:items-end">
              <div className="flex gap-6 md:block">
                <div>
                  <p className="text-xs text-slate-500">Time in</p>
                  <p className="text-sm font-semibold text-ink-900">{firstEntry ? fmtTime(firstEntry.clock_in) : '—'}</p>
                </div>
                <div className="md:hidden">
                  <p className="text-xs text-slate-500">Time out</p>
                  <p className="text-sm font-semibold text-ink-900">{lastOut ? fmtTime(lastOut.clock_out) : '—'}</p>
                </div>
                <div className="md:hidden">
                  <p className="text-xs text-slate-500">Hours</p>
                  <p className="text-sm font-semibold text-ink-900">{line.workedMinutes ? fmtHours(line.workedMinutes) : '—'}</p>
                </div>
              </div>
              <div className="min-w-0 md:border-l md:border-slate-200 md:pl-4">
                <div aria-hidden="true" className="relative mb-1.5 hidden h-4 text-[11px] text-slate-400 sm:block">
                  {ticks.map((m, i) => (
                    <span
                      key={m}
                      className="absolute top-0 whitespace-nowrap"
                      style={{
                        left: `${pct(m)}%`,
                        transform: i === 0 ? undefined : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                      }}
                    >
                      {m === hi && m % 1440 === 0 ? '23:59' : clock(m)}
                    </span>
                  ))}
                </div>
                <div className="relative h-6 overflow-hidden rounded-md bg-slate-100">
                  {leave ? (
                    <span className={`absolute inset-0 flex items-center justify-center text-[11px] font-semibold ${LOOK.leave.bar}`}>
                      {leave.label}
                    </span>
                  ) : (
                    line.segments.map((s, i) => {
                      const w = pct(s.to) - pct(s.from)
                      return (
                        <span
                          key={i}
                          title={`${LOOK[s.kind].label} ${clock(s.from)}–${s.live ? 'now' : clock(s.to)}`}
                          className={`absolute inset-y-0 flex items-center justify-center overflow-hidden border-x border-white text-[10px] font-semibold ${LOOK[s.kind].bar} ${s.live ? 'opacity-60' : ''}`}
                          style={{ left: `${pct(s.from)}%`, width: `${w}%` }}
                        >
                          {w > 9 && <span className="truncate px-1">{s.live ? 'In progress' : LOOK[s.kind].label}</span>}
                        </span>
                      )
                    })
                  )}
                </div>
              </div>
              <div className="hidden gap-6 md:flex md:border-l md:border-slate-200 md:pl-4">
                <div>
                  <p className="text-xs text-slate-500">Time out</p>
                  <p className="text-sm font-semibold text-ink-900">{lastOut ? fmtTime(lastOut.clock_out) : '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Hours</p>
                  <p className="text-sm font-semibold text-ink-900">{line.workedMinutes ? fmtHours(line.workedMinutes) : '—'}</p>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
