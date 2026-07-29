# Security Policy

## Reporting a vulnerability

Do not report security vulnerabilities through public GitHub issues, pull
requests, or discussions.

Report privately instead:

1. **GitHub private vulnerability reporting (preferred).** Open the
   [Security tab](https://github.com/gatewaze/gatewaze-modules/security/advisories/new) and choose
   "Report a vulnerability". This creates a private advisory.
2. **Email.** Send details to the project security contact.
   <!-- MAINTAINERS: replace with the confirmed disclosure address. -->

Include the affected component/version or commit, the impact, and steps to
reproduce or the affected code path.

## What to expect

- Acknowledgement within about 3 business days.
- Coordinated disclosure: please allow time for a fix before going public.
- Credit in the advisory unless you prefer otherwise.

## Scope

This repository holds Gatewaze platform modules (edge functions, API handlers, migrations, and workers). Vulnerabilities in that module code are in scope. It is open source and public — treat any committed credential as compromised and report it.

If your report involves a leaked credential, say so immediately and do not use
it — we rotate exposed credentials first. This repository runs gitleaks secret
scanning in CI and a pre-push hook to reduce the chance of a secret reaching the
remote.
