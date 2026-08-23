# Project state — what exists where (beyond what the repo shows)

> The Supabase backend is fully deployed and seeded (state the repo can't prove on its own); the app is built, tested and pushed; the only intentionally-unfinished pieces are listed below. Last updated: 2026-08-23.

## Deployed backend state (Supabase project `ruuhpghcgccvezkjhisy`, ap-southeast-1)

- All 7 migrations in `supabase/migrations/` are **applied** to the live
  project (verified via `list_migrations`; versions match the filenames).
- `statutory_versions`, 2026 `holidays`, `leave_types`, and `company_settings`
  (minimum wage ₱755, WO NCR-27) are **seeded**.
- Edge function **`admin-users` is deployed** (verify_jwt on), version 1 —
  source mirrored at `supabase/functions/admin-users/index.ts` (repo copy is
  the same code; the deployed unknown-action status code is 400).
- Storage buckets `punch-selfies` and `employee-photos` exist (private).
- Security advisors: clean except intentional WARNs on `clock_in`/`clock_out`/
  `review_time_correction` being callable by `authenticated` (that IS the
  punch API — do not "fix").
- **No auth users exist yet**: the first person to sign up in the app becomes
  the admin. Do not create throwaway accounts — that would steal the
  admin bootstrap from the owner.

## Verified working

- `npm run build`, `npm test` (32 engine tests), `npm run lint` all green.
- Login page renders correctly (Playwright screenshot); live auth could not be
  e2e-tested from the sandbox (egress blocks `*.supabase.co` — see
  research-verification-workflow.md).

## Known-open items (deliberate scope cuts, also in README disclaimers)

- Year-end tax annualization / BIR 2316 true-up not automated.
- Unworked-regular-holiday qualification simplified (pays unless on unpaid
  leave that day).
- Mid-period hires/separations on monthly pay are handled as absence
  deductions (≈ proration) rather than explicit proration lines.
- Special/final-pay runs recompute their period like a regular run — the UI
  warns about overlapping already-finalized periods.

Why it mattered: a fresh session can't tell from the repo alone whether the
migrations/seeds/edge function are actually applied to the live project, and
re-applying or re-seeding blindly would fail or duplicate data. Update this
note when the deployed state or open items change.
