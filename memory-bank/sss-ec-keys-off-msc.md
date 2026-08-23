# SSS EC threshold applies to the MSC, not the raw salary

> The ₱10/₱30 Employees' Compensation split keys off the *mapped Monthly Salary Credit*; a ₱14,999 salary maps to MSC 15,000 (bracket 14,750–15,249.99) and therefore pays EC ₱30, not ₱10.

I initially wrote a test asserting `EC(14,999) = 10` and it failed — correctly.
The salary→MSC mapping is `MSC = clamp(500 * floor((salary + 250) / 500), 5000, 35000)`
(bracket bounds are `MSC ± 250`), and *then* every MSC-derived amount (EE/ER
shares, MPF split, EC tier) uses that MSC.

Why it mattered: off-by-one-bracket errors around ₱14,750–₱15,000 salaries
would misstate the employer's EC by ₱20/month per affected employee, and the
same mapping mistake would shift the entire contribution row.
