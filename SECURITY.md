# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue, pull request or discussion.

Use the private vulnerability reporting feature of the site that hosts this repository (on GitHub: the
**Security** tab, then **Report a vulnerability**). If private reporting is not enabled there, contact the
maintainers through the contact details on their profile and ask for a private channel before sharing details.

Include what you can:

- the affected version or commit, and whether it runs on Cloudflare Workers or Node
- the steps to reproduce, or a proof of concept
- the impact you expect (for example data exposure, account takeover, booking tampering)

Do not include real personal data, secrets or tokens in a report. Use test accounts and placeholder values.

## Scope

In scope: the code in this repository (API, web UI, CLI, adapters, setup and deploy scripts). Out of scope:
weaknesses that need an already compromised server or Cloudflare account, and issues in third-party services
(Google, Cloudflare, Resend) that should be reported to those vendors.

## Operators

If you run your own instance, keep it updated, keep `ENCRYPTION_KEY` and other secrets out of version control,
and see the "Security notes" section of README.md.
