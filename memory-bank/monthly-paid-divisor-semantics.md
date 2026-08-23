# Monthly-paid divisor semantics (261) and holiday premiums

> Under the DOLE divisor-261 convention, a monthly-paid employee's rate already pays for unworked regular holidays and special days — the engine must add only the *extra* premium for worked ones, or it double-pays.

The engine (`src/payroll/engine.ts`) encodes this as `BUILT_IN_MULT`:
- regular workday: 1.0 built-in (worked or absent decides deductions)
- regular holiday (scheduled day): 1.0 built-in → working it adds +100%
  (extra 1.0 × hourly × hours), unworked adds nothing and deducts nothing
- special day (scheduled): 1.0 built-in → working adds +30%
- rest-day types: 0 built-in → working pays the full multiplier as extra

Daily-paid is the opposite regime: no work, no pay; each worked day pays
`DAY_MULT × daily`, and an unworked regular holiday pays 100% of the daily wage
as its own line (subject to the presence-on-the-preceding-workday condition,
which the engine simplifies to "not on unpaid leave" — noted in the trace).

`working_days_divisor` is a company setting (261 Mon–Fri, 313 six-day week,
365) used for monthly↔daily conversion: `daily = monthly × 12 / divisor`.

Why it mattered: the most common PH payroll bug is paying holiday pay *on top*
of an already-holiday-inclusive monthly rate (or deducting an unworked regular
holiday from monthly-paid staff). The split multiplier table makes the
convention explicit and testable.
