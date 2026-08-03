# Security Policy

## Reporting a Vulnerability

Do not report suspected vulnerabilities through a public issue, discussion, pull request, or
commit message.

Use GitHub's private security advisory flow for `yiaany/mekka`. If private reporting is not
available, contact the repository owner directly through GitHub and include:

- a concise description of the impact;
- affected paths, versions, or configurations;
- reproducible steps or a proof of concept;
- suggested mitigation, if known.

Please do not include secrets, customer data, access tokens, or production database contents in a
report.

## Response Goals

Reports are triaged privately. The project will acknowledge receipt, assess impact, prepare a
fix, and coordinate disclosure where appropriate. No response-time or bounty commitment is made
at the current pre-alpha stage.

## Security Boundaries

The project is designed around tenant-scoped authorization, deny-by-default routing, short-lived
capabilities, prepared SQL statements, schema identifier allowlists, and audit events for
privileged actions. These are design goals, not a claim that the pre-alpha implementation is safe
for production use.
