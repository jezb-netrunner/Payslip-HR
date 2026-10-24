// How work schedules read on screen and in printouts (plain ASCII times:
// PDFs print them too).

import { patternOn, patternFromWorkSchedule, shiftWorkMinutes, type ScheduleVersion } from '../payroll/schedule'
import type { Shift, WeekPattern, WorkSchedule } from '../payroll/types'
import { clock12, fmtHours } from './format'
import { addDays } from './manila'

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** "08:30" -> "8:30a", "17:00" -> "5p" (roster cells, printed tables) */
export function clockShort(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'a' : 'p'}`
}

/** "8a–5p", or "Rest" */
export function shiftShort(s: Shift | null | undefined): string {
  return s ? `${clockShort(s.start)}–${clockShort(s.end)}` : 'Rest'
}

/** "8:00 AM–5:00 PM", or "Rest day" */
export function shiftLabel(s: Shift | null | undefined): string {
  return s ? `${clock12(s.start)}–${clock12(s.end)}` : 'Rest day'
}

/** "8h of work, 1h unpaid break · flexible start until 9:00 AM · compressed workweek" */
export function shiftDetail(s: Shift): string {
  const brk = s.break_minutes >= 60
    ? `${fmtHours(s.break_minutes)} unpaid break`
    : s.break_minutes > 0
      ? `${fmtHours(s.break_minutes)} paid break`
      : 'no break'
  const parts = [`${fmtHours(shiftWorkMinutes(s))} of work, ${brk}`]
  if (s.flex_minutes) {
    const latest = (Number(s.start.slice(0, 2)) * 60 + Number(s.start.slice(3, 5)) + s.flex_minutes) % 1440
    parts.push(`flexible start until ${clock12(`${String(Math.floor(latest / 60)).padStart(2, '0')}:${String(latest % 60).padStart(2, '0')}`)}`)
  }
  if (s.compressed) parts.push('compressed workweek')
  return parts.join(' · ')
}

/** Weekdays with the same shift grouped: "Mon–Fri 8:00 AM–5:00 PM · Sat 8:00 AM–12:00 PM". */
export function patternSummary(p: WeekPattern): string {
  const groups: { days: number[]; label: string }[] = []
  p.forEach((s, i) => {
    if (!s) return
    const label = shiftLabel(s)
    const g = groups.find((x) => x.label === label)
    if (g) g.days.push(i)
    else groups.push({ days: [i], label })
  })
  if (groups.length === 0) return 'No workdays'
  return groups.map((g) => `${dayRanges(g.days)} ${g.label}`).join(' · ')
}

/** [0,1,2,3,4] -> "Mon–Fri"; [0,2,4] -> "Mon, Wed, Fri" */
export function dayRanges(days: number[]): string {
  const runs: number[][] = []
  for (const d of [...days].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1]
    if (last && d === last[last.length - 1] + 1) last.push(d)
    else runs.push([d])
  }
  return runs
    .flatMap((r) => (r.length >= 3 ? [`${DAY_LABELS[r[0]]}–${DAY_LABELS[r[r.length - 1]]}`] : r.map((d) => DAY_LABELS[d])))
    .join(', ')
}

/** What an employee is scheduled across a range: one pattern's summary, or a note that it changes. */
export function scheduleSummary(base: WorkSchedule, versions: Pick<ScheduleVersion, 'effective_from' | 'pattern'>[], from: string, to: string): string {
  const basePattern = patternFromWorkSchedule(base)
  const first = patternOn(basePattern, versions, from)
  const changes = versions.filter((v) => v.effective_from > from && v.effective_from <= to)
  const summary = patternSummary(first)
  return changes.length ? `${summary} (changes ${changes.map((c) => c.effective_from).join(', ')})` : summary
}

/** The first date a schedule change may start: the day after the last paid day, and not before the hire. */
export function earliestScheduleChange(hireDate: string, lastPaid: string | null): string {
  const after = lastPaid ? addDays(lastPaid, 1) : hireDate
  return after > hireDate ? after : hireDate
}
