# SESSION-0006: SQLite SELECT compiler

## Цель
Компилировать validated query AST в parameterized SQLite SELECT.

## Зависимости
- SESSION-0003, SESSION-0004, SESSION-0005.

## Upstream Sources
- Не копировать ORM query builders.
- Использовать официальную SQLite syntax documentation как reference.

## Scope
- Compile projection, filters, boolean groups, order и pagination.
- Возвращать SQL, parameters и cost metadata.
- Реализовать strict identifier quoting через schema references.

## Out of Scope
- Mutations, joins/embed и policies.

## Acceptance Criteria
1. Values всегда находятся в parameters.
2. AST не может обратиться к identifier вне manifest.
3. Query result соответствует golden fixtures.

## Security
- Injection corpus и bounded parameter/list counts.

## Tests
- Unit compiler snapshots и integration queries на temporary database.

## Deliverables
- Compiler, tests, docs и Session Log.
