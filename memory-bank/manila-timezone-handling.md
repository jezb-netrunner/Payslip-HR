# Manila time is fixed UTC+8 — but convert deliberately

> The Philippines has no DST, so all attendance math uses fixed +8h arithmetic (`src/lib/manila.ts`); the trap is HTML datetime-local inputs, which `new Date(value)` interprets in the *browser's* timezone — convert them as Manila wall time explicitly.

Rules established:
- `work_date` is derived server-side in the clock RPCs:
  `(now() at time zone company_settings.timezone)::date`.
- The engine converts timestamptz → Manila minutes-of-day via `toManilaParts`
  (shift by 8h, read UTC fields) — display uses
  `toLocaleString(..., { timeZone: 'Asia/Manila' })`.
- Form inputs (correction requests, manual entries): value `"2026-08-23T09:30"`
  must become `new Date("2026-08-23T09:30:00Z") - 8h`, NOT `new Date(value)`.
  Done in `MyAttendance.tsx` (`manilaLocalToIso`) and Attendance.tsx's manual
  entry modal. An admin filing from a non-PH browser would otherwise write
  shifted timestamps.
- Night differential window 22:00–06:00 is computed by overlapping the punch
  interval with per-date Manila windows; ND minutes are capped at net worked
  minutes so unpaid breaks don't earn ND.

Why it mattered: the user may run this from anywhere (this session's browser
may not be UTC+8); silent browser-TZ interpretation is the classic way payroll
hours drift by a working day.
