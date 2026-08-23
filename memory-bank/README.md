# Memory Bank

Running memory for AI assistants (and humans) working on Payslip-HR, so separate
sessions have self-reinforcing context.

## Rules

1. **One lesson per file.** The first line of every note is a one-line summary
   (a `> ` blockquote right under the title).
2. **Record corrections and confirmed approaches alike**, and always say *why
   the lesson mattered* — a note without consequences teaches nothing.
3. **Don't save what the repo or chat history already records.** Code, schema
   and README explain themselves; notes are for the non-obvious: gotchas,
   corrections, verified external facts, and decisions with reasons.
4. **Update an existing note rather than creating a duplicate.** Search this
   directory first (`grep -ril <topic> memory-bank/`).
5. **Delete notes that turn out to be wrong.** A stale "lesson" is worse than
   none.
6. Name files `kebab-case-topic.md`. Keep each note short — a screenful.

## Index (update when adding/removing notes)

| Note | One-liner |
|---|---|
| `statutory-figures-2026.md` | Verified 2026 PH statutory figures, sources, and what to re-verify when |
| `philhealth-odd-centavo-split.md` | PhilHealth odd centavo goes to the employer, not the employee |
| `sss-ec-keys-off-msc.md` | SSS EC ₱10/₱30 threshold applies to the mapped MSC, not raw salary |
| `monthly-paid-divisor-semantics.md` | Divisor-261 monthly pay already covers unworked holidays — premiums are extras only |
| `statutory-tables-are-data.md` | Law changes are new `statutory_versions` rows, never code edits |
| `supabase-rls-recursion.md` | Cross-referencing RLS policies recurse — use security-definer helpers |
| `anti-buddy-punching-design.md` | Punch integrity comes from RPC + auth.uid, not UI checks |
| `manila-timezone-handling.md` | All attendance math is fixed UTC+8; convert form inputs as Manila wall time |
| `supabase-security-advisors.md` | Run security advisors after every DDL change; pin search_path, revoke anon EXECUTE |
| `edge-function-admin-provisioning.md` | Employee logins are provisioned by the admin-users edge function; first signup becomes admin |
| `research-verification-workflow.md` | How PH statutory figures were verified and the sandbox limits hit doing it |
