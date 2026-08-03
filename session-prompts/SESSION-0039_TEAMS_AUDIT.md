# SESSION-0039: Teams, roles и audit

## Цель
Добавить organization collaboration, approvals и tamper-evident privileged audit trail.

## Зависимости
- SESSION-0002, SESSION-0019, SESSION-0038.

## Upstream Sources
- Pinned Supabase Studio organization/team UI можно использовать как visual reference.
- Новый backend upstream не требуется.

## Scope
- Owner/admin/developer/viewer roles, invitations и membership lifecycle.
- Approval policies для production migration/MCP.
- Append-only authoritative audit outside project database с hash chaining.

## Out of Scope
- SSO/SCIM.

## Acceptance Criteria
1. Role matrix применяется server-side.
2. Last owner нельзя удалить без transfer.
3. Audit tampering/reconciliation обнаруживается.

## Security
- Invitation expiry/replay, privilege escalation и operator action audit.

## Tests
- Role/invitation/approval matrix, tenant isolation и audit integrity.

## Deliverables
- Team/audit feature, Studio UI, tests и Session Log.
