# How the statutory figures were verified (and the sandbox limits hit)

> PH statutory data was verified with a parallel research workflow (one agent per domain: BIR / SSS / PhilHealth / Pag-IBIG / labor standards) each followed by an adversarial fact-checker agent told to refute the findings — worth repeating whenever tables are due for re-verification.

Findings from the process itself:
- The sandbox egress proxy also blocks `*.supabase.co` from local processes
  (curl/browser get CONNECT 403), so end-to-end login tests can't run inside
  the remote session — backend verification must go through the Supabase MCP
  tools, and UI smoke tests can only confirm rendering, not live auth.
- The sandbox egress proxy blocked ALL direct fetches of .gov.ph sites
  (philhealth.gov.ph, sss.gov.ph, dole.gov.ph, officialgazette.gov.ph…);
  research had to rely on server-side WebSearch extraction cross-checked
  across multiple independent sources. Every agent flagged this in caveats —
  so before betting the company on a figure, a human should eyeball the actual
  circular PDF once.
- The adversarial verify pass is not decoration: it caught a date nuance
  (RR 4-2025 effectivity Feb 14 2025, not Jan 30) and confirmed all 24 WHT
  brackets digit-by-digit. One verify agent died on a session limit — the
  research result still stood on its own caveats.
- Two of my from-memory values were wrong before research: NCR minimum wage
  (was ₱755 under WO NCR-27, I had ₱695 from NCR-26) and the PhilHealth
  odd-centavo direction. Never seed statutory data from memory alone.

Why it mattered: "double-check that all legal tables are up to date" was an
explicit user requirement; the workflow pattern (research → adversarial
verify → reconcile with code/tests) is the repeatable way to honor it next
January.
