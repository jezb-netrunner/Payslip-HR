# Anti-buddy-punching: enforce identity in the database, not the UI

> Employees have zero INSERT/UPDATE/DELETE grants on time_entries; the only way to punch is the `clock_in()`/`clock_out()` SECURITY DEFINER RPCs, which derive the employee from `auth.uid()` server-side — so punching for a teammate is impossible by construction, not by front-end discipline.

Layers (all in `time_clock_rpcs` migration + `TimeClock.tsx`):
1. Identity: RPC resolves `current_employee_id()` from the JWT; there is no
   employee_id parameter to spoof.
2. Time: `now()` from the DB clock; client timestamps are never trusted.
3. One open entry per employee (partial unique index on `clock_out is null`).
4. Evidence per punch: selfie (required by default, stored in the private
   `punch-selfies` bucket, employee can only upload into their own folder),
   device fingerprint (persistent localStorage UUID + UA), IP from
   `request.headers` x-forwarded-for, optional geolocation.
5. Anomaly flags computed in the RPC: `no_selfie`, `no_location`,
   `new_device`, `device_mismatch` (out-device ≠ in-device), `overlong_shift`
   (>16h). Admin reviews flags with selfies side by side and clears them.
6. Immutability: employees can't edit entries; fixes go through
   `time_correction_requests` → admin `review_time_correction()` RPC; entries
   get `manually_edited` + a `corrected` flag; UPDATE/DELETE on time_entries is
   audit-logged by trigger.

Residual risk (documented, accepted): shared credentials + shared device +
willing accomplice selfie — mitigated by the selfie evidence trail, not
prevented. The remaining honest-path gap is timezone-fixed (see
manila-timezone-handling.md).

Why it mattered: the user's core requirement — "strong internal control to
prevent other employees timing in for the other employee but still leaving it
accessible" — is satisfied server-side; any alternative UI (or curl) hits the
same wall.
