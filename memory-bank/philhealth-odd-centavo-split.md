# PhilHealth odd-centavo split direction

> When the 50/50 PhilHealth split produces a fractional centavo, the EMPLOYEE share rounds DOWN and the employer carries the extra centavo — my first implementation had it reversed.

Official PhilHealth sample computations (Advisory 2018-0003 era, still the
operative rounding convention): total ₱618.75 → employee ₱309.37, employer
₱309.38. Implementation in `src/payroll/statutory.ts` `computePhilHealth`:

```ts
ee = Math.floor((total / 2) * 100) / 100
er = round2(total - ee)
```

A plain `round2(total/2)` gives EE ₱309.38 — half-up rounding overcharges the
employee by a centavo and understates the employer share. Covered by a unit
test using the official sample (via MBS 12,375 at 5%).

Why it mattered: statutory remittances must tie out to the centavo; consistent
misrounding across employees/months creates reconciliation discrepancies with
PhilHealth's own computations.
