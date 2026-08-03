# SESSION-0002: Tenant identity и protocol

## Результат
COMPLETED

## Что сделано
- Добавлены branded identifiers для organization, project, environment, branch, generation и correlation ID.
- Добавлен полный immutable `TenantIdentity`; parsing не допускает пустой или неполный tuple и требует положительный safe-integer `generation`.
- Добавлены HTTP headers и parser tenant tuple на boundary, а также correlation ID: корректный входящий UUID сохраняется, для отсутствующего или некорректного создается новый.
- Добавлены immutable `TenantContext`, actor и capability contracts. Capability с tenant tuple, отличающимся хотя бы generation, отклоняется с `forbidden`.
- Добавлен generation-aware cache key, принимающий только полный typed tenant tuple.
- Добавлен стабильный public error envelope и статусы для `validation`, `auth`, `forbidden`, `conflict`, `quota`, `unsupported` и `infrastructure`.
- Добавлены unit/property-style tests, документация пакета и обновлен root test script.

## Upstream
- Upstream sources не требовались и не использовались.

## Архитектурные решения
- IDs являются opaque lowercase identifiers, а не UUID: control plane может выбирать собственную схему выдачи ID без изменения protocol contract.
- `generation` является отдельным branded positive integer и включается в cache key, чтобы удаленный и затем созданный заново логический resource не получил старый cache entry.
- JWT verification сознательно остается за пределами пакета. HTTP adapter передает в `createTenantContextFromHeaders` уже проверенные actor и capabilities; protocol проверяет их tenant scope и не делает authorization fallback.
- Неожиданные exceptions преобразуются только в generic `infrastructure` envelope. Их message, stack trace и потенциальные PII не сериализуются клиенту.

## Измененные файлы
- `packages/protocol/src/index.ts`: typed IDs, tenant parsing, request context, capabilities, correlation IDs, cache keys и error contract.
- `packages/protocol/test/protocol.test.ts`: positive и negative protocol tests.
- `packages/protocol/README.md`: transport and security contract documentation.
- `package.json`: protocol tests добавлены в root test script.
- `README.md`: уточнено назначение protocol package.

## Безопасность
- Неполный tenant tuple, некорректные IDs и отсутствующий generation отклоняются до routing/authorization.
- Capability нельзя использовать для другого organization/project/environment/branch/generation; несоответствие fail-closed.
- Cache keys всегда привязаны к полному tuple и generation.
- Public error envelope не включает исходный error text, stack trace или PII.
- Нет fallback на неизвестный tenant; JWT и database authorization не добавлялись, так как исключены из scope.

## Проверки
- `C:\Users\ilyaa\.bun\bin\bun.exe run check`: PASSED, format check, lint, typecheck, 11 tests, build и health smoke test.
- `git diff --check`: PASSED.

## Совместимость
- Package остается transport-neutral и использует стандартный `Headers` API для HTTP boundary.
- Поддерживается только внутренний Mekka protocol. JWT verification, token claims и database authorization отсутствуют по scope.

## Ограничения и риски
- Actor/capability authenticity и expiry enforcement кроме локальной time check остаются обязанностью будущего auth/capability issuer.
- HTTP adapter должен вызвать `toErrorResponse` для исключений parser/authorization boundary, чтобы применить public redaction contract.

## Следующая рекомендуемая сессия
- `SESSION-0003`: реализовать `StorageAdapter` и conformance contract, используя полный tenant context для routing.
