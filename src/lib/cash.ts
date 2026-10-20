// Cash payroll helpers: how many bills and coins to put in each pay
// envelope. Philippine peso denominations in circulation: ₱1000, ₱500,
// ₱200, ₱100, ₱50 and ₱20 bills (₱20 also as a coin), ₱10, ₱5, ₱1 coins.

export const PESO_DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1] as const

export interface CashBreakdown {
  counts: Record<number, number>
  /** Centavos that can't be paid in peso bills/coins (only when not rounded). */
  centavos: number
}

/** Greedy split of a net pay into the fewest bills and coins. */
export function denominationBreakdown(amount: number): CashBreakdown {
  const totalCents = Math.max(0, Math.round(amount * 100))
  let pesos = Math.floor(totalCents / 100)
  const counts: Record<number, number> = {}
  for (const d of PESO_DENOMINATIONS) {
    counts[d] = Math.floor(pesos / d)
    pesos -= counts[d] * d
  }
  return { counts, centavos: (totalCents % 100) / 100 }
}

export function sumBreakdowns(list: CashBreakdown[]): CashBreakdown {
  const counts: Record<number, number> = {}
  for (const d of PESO_DENOMINATIONS) counts[d] = list.reduce((s, b) => s + (b.counts[d] ?? 0), 0)
  return { counts, centavos: Math.round(list.reduce((s, b) => s + b.centavos, 0) * 100) / 100 }
}
