# SESSION-0001: Основа репозитория

## Цель
Создать минимальный Bun/TypeScript monorepo, в котором можно безопасно разрабатывать и проверять будущие сервисы.

## Зависимости
- Нет.

## Upstream Sources
- Не клонировать продуктовые upstream-компоненты.
- Использовать официальные Bun/Elysia packages только после проверки LICENSE и актуальной документации.

## Scope
- Создать workspace, strict TypeScript config, formatter, lint, test и build scripts.
- Создать только `packages/protocol`, `packages/testkit` и один health-check service.
- Добавить CI для install, lint, typecheck, tests и build.
- Добавить config validation, structured logging baseline и contribution conventions.

## Out of Scope
- Database, Studio, Auth и cloud deployment.

## Acceptance Criteria
1. Fresh checkout устанавливается одной документированной командой.
2. Health service запускается и завершается корректно.
3. CI выполняет одинаковые команды с local workflow.
4. Нет пустых future packages.

## Security
- Lockfile обязателен; secrets и production defaults отсутствуют.
- Dependency scripts и licenses проверены.

## Tests
- Lint, typecheck, unit test, build и startup smoke test.

## Deliverables
- Код, CI, краткий README и `docs/session-logs/SESSION-0001.md`.
