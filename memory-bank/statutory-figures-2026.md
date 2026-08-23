# Verified 2026 PH statutory figures

> As of 2026-08-23, all statutory figures seeded in `statutory_versions` were verified against current law via multi-source research + adversarial cross-check; this note records what was confirmed, the sources, and what must be re-verified later.

## Confirmed current (seeded in DB and `src/payroll/defaults.ts`)

- **BIR withholding tax**: Annex E of RR 11-2018 (TRAIN, RA 10963), "effective
  Jan 1, 2023 and onwards" version — still in force for 2026, all four period
  tables. Annual table likewise. **₱90,000** 13th-month/other-benefits cap
  unchanged (bills to raise it, incl. HB 7661 → ₱150k, remain unenacted).
- **SSS** (RA 11199, Circular 2024-006): 15% of MSC since Jan 2025 — **final
  step** of the escalation (no scheduled future increase). MSC ₱5,000–₱35,000,
  ₱500 steps; EE 5% / ER 10%; MSC above ₱20,000 → MPF/WISP; EC ₱10 (MSC <
  ₱15,000) / ₱30.
- **PhilHealth** (RA 11223): 5% of monthly basic salary, floor ₱10,000 /
  ceiling ₱100,000, 50/50 split — **terminal rate** of the UHC schedule;
  confirmed retained for 2026 (advisory of May 6, 2026). HB 11357 (3.5% cut)
  died with the 19th Congress.
- **Pag-IBIG** (Circular 460): max fund salary ₱10,000 since Feb 2024; EE 1%
  (≤₱1,500) / 2%; ER always 2%. Max ₱200 + ₱200.
- **Labor standards**: OT +25% ordinary / ×1.30 on the day's rate otherwise
  (169/195/260/338%); ND +10% (22:00–06:00), stacks multiplicatively; premiums
  130/150/200/260%; unworked regular holiday 100% (presence-on-preceding-workday
  condition); special days no-work-no-pay; 13th month = YTD basic ÷ 12, due
  Dec 24.
- **2026 holidays**: Proclamation 1006 (+1189 Eid'l Fitr Mar 20, +1264 Eid'l
  Adha May 27) — 12 regular, 8 special non-working, Feb 25 special *working*.
- **NCR minimum wage reference**: ₱755/day non-agri (WO NCR-27, eff. Jul 25,
  2026). It's an admin setting, not hardcoded.
- **De minimis** (RR 29-2025, eff. Jan 6, 2026): rice ₱2,500/mo, uniform
  ₱8,000/yr, laundry ₱400/mo, medical assistance ₱12,000/yr, gifts ₱6,000/yr,
  CBA+productivity ₱12,000/yr, OT meal 30% of regional minimum wage, monetized
  VL 12 days. The app treats de minimis as admin-flagged non-taxable allowance
  lines — ceilings are the admin's responsibility (documented in UI).

## Re-verify on these triggers

- **Every January**: PhilHealth/SSS/Pag-IBIG announcements, new BIR RRs, new
  de minimis RRs.
- **Wage orders**: each region's RTWPB moves on its own schedule — NCR's 2nd
  tranche (₱780) takes effect **Jan 20, 2027**; admin must update the setting.
- **Each year ~Aug–Oct**: next year's holiday proclamation; Eid dates arrive by
  separate proclamations only weeks ahead — seed them when issued.
- **Pending bills** that would change figures if enacted: 13th-month cap
  increases; PhilHealth premium reductions.

Why it mattered: the user's explicit requirement was that legal tables be
current; two of my from-memory values needed correcting (NCR wage ₱695→₱755;
PhilHealth centavo split direction), which only the research pass caught.
