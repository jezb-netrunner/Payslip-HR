# CLAUDE.md — working on Payslip-HR

Multi-client PH HR & Payroll system (company admins → clients/entities →
entity admins → employees). React+TS+Tailwind front end, Supabase backend
(project ref `ruuhpghcgccvezkjhisy`, ap-southeast-1).

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
- `supabase/tests/run.sh` — replays all migrations on a local Postgres with a
  Supabase stub and runs the RLS suite (see the MEMORY.md lesson on the
  local replica); extend it when you change policies or RPCs

## Ground rules

- **Statutory figures are data, not code**: rates live in the
  `statutory_versions` table (and mirrored in `src/payroll/defaults.ts` for
  tests). Never hardcode a rate in the engine. Never seed a statutory figure
  from memory — verify against current official sources first
  (see MEMORY.md → *Verified 2026 PH statutory figures* for what's verified
  and when to re-verify).
- Database schema changes go through Supabase migrations AND a matching file in
  `supabase/migrations/`. After any DDL, run the Supabase security advisors and
  fix findings (see MEMORY.md → *Run Supabase security advisors after every
  DDL change*).
- All attendance math is Asia/Manila (fixed UTC+8) — use `src/lib/manila.ts`
  helpers; never interpret datetime-local form values with `new Date(value)`.
- Employees must never gain direct write access to `time_entries` or payslips;
  time in/out is entered by admins, employees only file correction/leave
  requests.
- Every client-scoped query filters by the selected client (`useEntity`):
  company admins can read all clients through RLS, so a missing filter mixes
  clients' data.
- Money is `numeric` in the DB and rounded with `round2` at line-item level;
  PhilHealth splits give the odd centavo to the employer.
