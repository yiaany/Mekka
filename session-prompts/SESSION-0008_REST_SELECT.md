# SESSION-0008: REST SELECT endpoint

## Цель
Предоставить production-like `GET /rest/v1/{table}` поверх parser, policy и compiler.

## Зависимости
- SESSION-0002-0007.

## Upstream Sources
- `https://github.com/PostgREST/postgrest` для status/headers/range/error semantics.
- Использовать ранее pinned clone или обновить provenance осознанно.

## Scope
- Elysia endpoint, authentication context, rate limit и query execution.
- JSON response, range/count subset, stable errors, metrics и request trace.
- Exact compatibility matrix для поддержанного behavior.

## Out of Scope
- Embedding, mutations и anonymous public policy editor.

## Acceptance Criteria
1. Authorized select работает через HTTP.
2. Policy, quota, timeout и invalid query дают ожидаемые responses.
3. Response size ограничен.

## Security
- Full tenant tuple; no stack traces; query timeout и result cap.

## Tests
- HTTP integration, cross-tenant, injection, range/count и load smoke test.

## Deliverables
- Endpoint, OpenAPI, tests, compatibility docs и Session Log.
