# CLAUDE.md — working on Payslip-HR

Single-entity PH HR & Payroll system. React+TS+Tailwind front end, Supabase
backend (project ref `ruuhpghcgccvezkjhisy`, ap-southeast-1).

## Read MEMORY.md first

`MEMORY.md` is the single running memory log: a dated session log of what
previous instances did and found, the current deployed-backend state, and
one-entry-per-lesson notes (corrections, verified legal facts, design
decisions with reasons). **Read it before changing code.** Maintain it as you
work:

- Append a dated session-log entry for each session that changed something.
- Record new corrections and confirmed approaches as lesson entries with a
  one-line summary and *why it mattered*.
- Don't save what the repo or chat history already records.
- Update an existing entry rather than adding a near-duplicate; delete
  entries that turn out to be wrong. Keep the deployed-state section current.

## Commands

- `npm test` — vitest (payroll engine; keep it green, add vectors for any
  statutory change)
- `npm run build` — `tsc -b && vite build` (must pass before pushing)
- `npm run lint` — oxlint

## Ground rules

- **Statutory figures are data, not code**: rates live in the
  `statutory_versions` table (and mirrored in `src/payroll/defaults.ts` for
  tests). Never hardcode a rate in the engine. Never seed a statutory figure
  from memory — verify against current official sources first
  (see `memory-bank/statutory-figures-2026.md` for what's verified and when to
  re-verify).
- Database schema changes go through Supabase migrations AND a matching file in
  `supabase/migrations/`. After any DDL, run the Supabase security advisors and
  fix findings (see `memory-bank/supabase-security-advisors.md`).
- All attendance math is Asia/Manila (fixed UTC+8) — use `src/lib/manila.ts`
  helpers; never interpret datetime-local form values with `new Date(value)`.
- Employees must never gain direct write access to `time_entries` or payslips;
  punch flow goes through the `clock_in`/`clock_out` RPCs only.
- Money is `numeric` in the DB and rounded with `round2` at line-item level;
  PhilHealth splits give the odd centavo to the employer.
