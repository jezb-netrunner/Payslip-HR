// What a reviewer checks before posting a payroll: who is on it compared
// with the last payroll of the same kind, whose pay moved a lot, and who
// the run covers but did not pay. Pure: the page loads the rows.

import { round2 } from '../payroll/types'

export interface ReviewPerson {
  id: string
  name: string
}

export interface ReviewSlip extends ReviewPerson {
  net: number
}

export interface NetChange extends ReviewPerson {
  before: number
  now: number
  /** signed share of the earlier net pay; null when that was zero */
  pct: number | null
}

export interface RunReview {
  /** employees the run covers (client, pay frequency, employment dates) without a payslip */
  leftOut: ReviewPerson[]
  /** on this payroll, not on the previous one */
  added: ReviewPerson[]
  /** on the previous payroll, not on this one */
  dropped: ReviewPerson[]
  /** net pay moved by the threshold or more, largest move first */
  changed: NetChange[]
  /** whether there was a previous payroll to compare with */
  compared: boolean
}

/** A move of this share of the earlier net pay, and at least this many pesos, is worth a look. */
export const REVIEW_CHANGE_SHARE = 0.2
export const REVIEW_CHANGE_PESOS = 500

const byName = (a: ReviewPerson, b: ReviewPerson) => a.name.localeCompare(b.name)

export function reviewRun(params: {
  slips: ReviewSlip[]
  /** employees the run covers; omitted = not checked (a posted run: the employee list has moved on) */
  covered?: ReviewPerson[]
  /** the previous payroll's payslips; null = none to compare with */
  previous: ReviewSlip[] | null
}): RunReview {
  const { slips, covered, previous } = params
  const here = new Map(slips.map((s) => [s.id, s]))
  const leftOut = (covered ?? []).filter((e) => !here.has(e.id)).sort(byName)
  if (!previous) return { leftOut, added: [], dropped: [], changed: [], compared: false }
  const before = new Map(previous.map((s) => [s.id, s]))
  const added = slips.filter((s) => !before.has(s.id)).map(({ id, name }) => ({ id, name })).sort(byName)
  const dropped = previous.filter((s) => !here.has(s.id)).map(({ id, name }) => ({ id, name })).sort(byName)
  const changed: NetChange[] = []
  for (const s of slips) {
    const p = before.get(s.id)
    if (!p) continue
    const diff = round2(s.net - p.net)
    if (Math.abs(diff) < REVIEW_CHANGE_PESOS) continue
    const pct = p.net > 0 ? diff / p.net : null
    if (pct !== null && Math.abs(pct) < REVIEW_CHANGE_SHARE) continue
    changed.push({ id: s.id, name: s.name, before: p.net, now: s.net, pct })
  }
  changed.sort((a, b) => Math.abs(b.now - b.before) - Math.abs(a.now - a.before) || byName(a, b))
  return { leftOut, added, dropped, changed, compared: true }
}

/** Whether the review found anything to look at. */
export function reviewIsClean(r: RunReview): boolean {
  return r.leftOut.length === 0 && r.added.length === 0 && r.dropped.length === 0 && r.changed.length === 0
}
