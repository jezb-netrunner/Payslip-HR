# Statutory tables are versioned data, not code

> Confirmed approach: every legal rate lives in the `statutory_versions` table keyed by `(kind, effective_from)`; payroll runs load the version in force for their period end, so a law change is an INSERT, never a deploy.

Mechanics:
- Kinds: `sss`, `philhealth`, `pagibig`, `bir_wht`, `bir_annual`; `data` is a
  JSONB whose shape matches the TS types in `src/payroll/types.ts`.
- `getStatutoryTables(asOf)` in `src/lib/api.ts` picks, per kind, the newest
  row with `effective_from <= asOf` (the run's `period_end`).
- `src/payroll/defaults.ts` mirrors the seeds for unit tests only — the DB is
  the runtime source of truth. If a new version is seeded, add it to defaults
  too *only if* tests should cover it.
- Admins add versions in the UI (Statutory page → "Add new version") by copying
  the current JSON shape; recomputing an old draft run still uses the tables
  that were in force for that period.

Why it mattered: SSS rates stepped up every ~2 years through 2025 and wage
orders/holiday proclamations change annually; an MSME admin must be able to
apply a new circular without a developer. It also gives historically correct
recomputation of past periods.
