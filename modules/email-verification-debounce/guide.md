# Email Verification: Debounce

Adds [Debounce](https://debounce.com) mailbox checks to the Email Verification module. It needs that module enabled.

## Setup

1. Create a Debounce account and copy a private API key from the API section of the dashboard. Do not use a `public_` key; those allow 20 checks per IP per day.
2. Enable this module and paste the key into its settings. The key is stored encrypted.
3. Optionally set **Checks per day**, and turn on **Detect Google Workspace catch-alls** (Debounce's `gsuite` option).
4. On the Email Verification page, click **Give domain-level results a mailbox check** to check addresses that were only given the free checks.

## How answers map

| Debounce code | Result | Reason |
|---|---|---|
| 5 Valid | valid | mailbox_ok (risky, role when Debounce flags a role address) |
| 4 Accept-All | risky | accept_all |
| 7 Unknown | risky | unknown |
| 6 Invalid | invalid | mailbox_not_found |
| 1 Syntax | invalid | syntax |
| 2 Spam Trap | invalid | spam_trap |
| 3 Disposable | invalid | disposable |

A wrong key or empty balance stops Debounce for the rest of the run, and the next provider (if any) takes over. Debounce allows 5 calls at once per key.
