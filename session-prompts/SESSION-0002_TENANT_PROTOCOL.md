# SESSION-0002: Tenant identity и protocol

## Цель
Создать единые typed identifiers, request context и error contract для всех сервисов.

## Зависимости
- SESSION-0001.

## Upstream Sources
- Не требуется.

## Scope
- Реализовать branded IDs для organization/project/environment/branch/generation.
- Создать immutable `TenantContext`, actor/capability model и stable error envelope.
- Добавить parsing/validation на HTTP boundary и correlation ID.

## Out of Scope
- JWT verification и database authorization.

## Acceptance Criteria
1. Невалидный или неполный tuple отклоняется.
2. Generation обязателен для resource access/cache key.
3. Validation, forbidden, conflict, quota, unsupported и infrastructure errors различимы.

## Security
- Запрещен fallback на неизвестный tenant.
- Public errors не содержат stack trace/PII.

## Tests
- Unit/property tests identifiers, serialization и error redaction.

## Deliverables
- `packages/protocol`, tests, docs и Session Log.
