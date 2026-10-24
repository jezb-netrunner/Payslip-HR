// Picking a shift: a client's shift template, a rest day, or custom times
// with the options payroll understands — the unpaid meal break, a flexible
// start and the compressed workweek.

import { useId, useState } from 'react'
import { MAX_COMPRESSED_MINUTES, sameShift, shiftSpan, shiftWorkMinutes } from '../payroll/schedule'
import type { Shift } from '../payroll/types'
import type { ShiftTemplate } from '../lib/schedules'
import { shiftDetail, shiftLabel } from '../lib/shiftText'
import { Field, Input, Select, Toggle } from './ui'

export const NEW_SHIFT: Shift = { start: '08:00', end: '17:00', break_minutes: 60 }

/** Why a shift can't be saved ('' = fine); mirrors the database's valid_shift. */
export function shiftProblem(s: Shift): string {
  if (!/^\d{2}:\d{2}$/.test(s.start) || !/^\d{2}:\d{2}$/.test(s.end)) return 'Enter the start and end times.'
  if (!Number.isInteger(s.break_minutes) || s.break_minutes < 0 || s.break_minutes > 600) return 'The break is 0 to 600 minutes.'
  if (shiftSpan(s) <= s.break_minutes) return 'The break is longer than the shift.'
  const flex = s.flex_minutes ?? 0
  if (!Number.isInteger(flex) || flex < 0 || flex > 480) return 'A flexible start is 0 to 480 minutes.'
  if (s.compressed && shiftWorkMinutes(s) > MAX_COMPRESSED_MINUTES) return 'A compressed workweek day is 12 hours of work at most.'
  return ''
}

/** Only the keys the database stores: zero options left out. */
export function cleanShift(s: Shift, name?: string): Shift {
  return {
    start: s.start,
    end: s.end,
    break_minutes: s.break_minutes,
    ...(s.flex_minutes ? { flex_minutes: s.flex_minutes } : {}),
    ...(s.compressed ? { compressed: true } : {}),
    ...(name ? { name } : {}),
  }
}

/** Start, end, break and the options, edited in place. */
export function ShiftFields({ value, onChange }: { value: Shift; onChange: (s: Shift) => void }) {
  const problem = shiftProblem(value)
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Start">
          <Input type="time" value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} />
        </Field>
        <Field label="End" hint="Before the start = next day">
          <Input type="time" value={value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} />
        </Field>
        <Field label="Meal break (min)" hint="Under 60 = paid time">
          <Input
            type="number"
            min={0}
            max={600}
            value={String(value.break_minutes)}
            onChange={(e) => onChange({ ...value, break_minutes: Math.round(Number(e.target.value) || 0) })}
          />
        </Field>
      </div>
      <Field label="Flexible start (min)" hint="Time in up to this late is on time; the shift ends that much later. 0 = fixed start">
        <Input
          type="number"
          min={0}
          max={480}
          value={String(value.flex_minutes ?? 0)}
          onChange={(e) => onChange({ ...value, flex_minutes: Math.round(Number(e.target.value) || 0) })}
          className="w-32"
        />
      </Field>
      <div className="rounded-lg bg-slate-50 p-3">
        <Toggle
          checked={!!value.compressed}
          onChange={(v) => onChange({ ...value, compressed: v })}
          label="Compressed workweek: the whole shift is regular time"
        />
        <p className="mt-1 text-xs text-slate-500">
          For a compressed workweek agreed with the employees (DOLE Department Advisory 02-04): days of up to 12 hours
          without overtime pay; hours past the shift are overtime. Without it, overtime starts after 8 hours.
        </p>
      </div>
      <p className={`text-xs ${problem ? 'font-semibold text-rose-600' : 'text-slate-500'}`}>
        {problem || `${shiftLabel(value)} · ${shiftDetail(value)}`}
      </p>
    </div>
  )
}

/**
 * A shift for one weekday or date: rest day, a template, or custom times.
 * `value` null = rest day. Custom times show as one line until edited, so a
 * week of them stays readable.
 */
export function ShiftChooser({
  value,
  onChange,
  templates,
  label,
  allowRest = true,
}: {
  value: Shift | null
  onChange: (s: Shift | null) => void
  templates: ShiftTemplate[]
  label: string
  allowRest?: boolean
}) {
  const id = useId()
  const [editing, setEditing] = useState(false)
  const active = templates.filter((t) => t.active)
  // a template's shift carries its name; custom times never do (so equal times stay custom while edited)
  const matched = value?.name ? active.find((t) => t.name === value.name && sameShift(t.shift, value)) : undefined
  const mode = value === null ? 'rest' : matched ? `t:${matched.id}` : 'custom'
  return (
    <div className="space-y-2">
      <Select
        id={id}
        aria-label={label}
        value={mode}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'rest') onChange(null)
          else if (v === 'custom') {
            onChange(cleanShift(value ?? NEW_SHIFT))
            setEditing(true)
          } else {
            const t = active.find((x) => `t:${x.id}` === v)
            if (t) onChange(cleanShift(t.shift, t.name))
          }
        }}
      >
        {allowRest && <option value="rest">Rest day</option>}
        {active.map((t) => (
          <option key={t.id} value={`t:${t.id}`}>
            {t.name} · {shiftLabel(t.shift)}
          </option>
        ))}
        <option value="custom">{mode === 'custom' && value ? `Custom: ${shiftLabel(value)}` : 'Custom times…'}</option>
      </Select>
      {mode === 'custom' && value && (editing || shiftProblem(value) ? (
        <div className="rounded-lg border border-slate-200 p-3">
          <ShiftFields value={value} onChange={(s) => onChange(cleanShift(s))} />
          {!shiftProblem(value) && (
            <button type="button" onClick={() => setEditing(false)} className="mt-2 text-xs font-semibold text-brand-700 hover:underline">
              Done
            </button>
          )}
        </div>
      ) : (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
          {shiftDetail(value)}
          <button type="button" onClick={() => setEditing(true)} className="font-semibold text-brand-700 hover:underline">
            Edit times
          </button>
        </p>
      ))}
    </div>
  )
}
