import { describe, expect, it } from 'vitest'
import { reviewIsClean, reviewRun } from './runReview'

const slip = (id: string, net: number, name = `Emp ${id}`) => ({ id, name, net })

describe('reviewRun', () => {
  it('lists who was added, who dropped off and whose net pay moved a lot', () => {
    const r = reviewRun({
      slips: [slip('a', 10000), slip('b', 13000), slip('c', 9000), slip('n', 8000)],
      previous: [slip('a', 10000), slip('b', 10000), slip('c', 9300), slip('x', 7000)],
    })
    expect(r.compared).toBe(true)
    expect(r.added.map((p) => p.id)).toEqual(['n'])
    expect(r.dropped.map((p) => p.id)).toEqual(['x'])
    // b: +30%; c: -3.2% (under the threshold); a: no change
    expect(r.changed).toEqual([{ id: 'b', name: 'Emp b', before: 10000, now: 13000, pct: 0.3 }])
    expect(reviewIsClean(r)).toBe(false)
  })

  it('ignores a large share that is only a few pesos, and a large amount that is a small share', () => {
    const r = reviewRun({
      slips: [slip('a', 1300), slip('b', 100600)],
      previous: [slip('a', 1000), slip('b', 100000)],
    })
    expect(r.changed).toEqual([])
  })

  it('flags a move from zero net pay without a percentage', () => {
    const r = reviewRun({ slips: [slip('a', 5000)], previous: [slip('a', 0)] })
    expect(r.changed).toEqual([{ id: 'a', name: 'Emp a', before: 0, now: 5000, pct: null }])
  })

  it('orders the largest move first', () => {
    const r = reviewRun({
      slips: [slip('a', 4000), slip('b', 20000)],
      previous: [slip('a', 8000), slip('b', 10000)],
    })
    expect(r.changed.map((c) => c.id)).toEqual(['b', 'a'])
  })

  it('names employees the run covers but did not pay', () => {
    const r = reviewRun({
      slips: [slip('a', 10000)],
      covered: [{ id: 'a', name: 'Emp a' }, { id: 'z', name: 'Zed' }, { id: 'm', name: 'Mia' }],
      previous: null,
    })
    expect(r.leftOut.map((p) => p.name)).toEqual(['Mia', 'Zed'])
    expect(r.compared).toBe(false)
    expect(r.added).toEqual([])
  })

  it('is clean when nothing changed', () => {
    const r = reviewRun({ slips: [slip('a', 10000)], covered: [{ id: 'a', name: 'Emp a' }], previous: [slip('a', 10100)] })
    expect(reviewIsClean(r)).toBe(true)
  })
})
