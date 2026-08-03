# SESSION-0030: Connect Project analyzer

## Цель
Безопасно анализировать существующий repository и строить детерминированный integration plan без изменения файлов.

## Зависимости
- SESSION-0014, SESSION-0019, SESSION-0028.

## Upstream Sources
- `https://github.com/vercel/vercel` как reference framework detection/build conventions.
- Временно клонировать с `--filter=blob:none`, проверить LICENSE, pin commit; изучить только framework metadata/detection tests.
- Не переносить Vercel deployment platform.

## Scope
- Определять Next.js, Vite/React, package manager, env examples и существующие Supabase/database clients.
- Формировать typed plan: packages, files, env, MCP config, migrations и smoke checks.
- Scanner работает read-only в sandbox и имеет size/time/file limits.

## Out of Scope
- Запись файлов, GitHub App и deployment provider secrets.

## Acceptance Criteria
1. Supported fixture получает deterministic plan.
2. Existing integration дает conflict/merge proposal, а не overwrite.
3. Binary, symlink escape и malicious scripts не исполняются.

## Security
- No project code execution; path traversal/symlink protection; secret-like values redacted.

## Tests
- Framework fixtures, monorepo, conflicting env, oversized/malicious repository.

## Deliverables
- Analyzer/plan schema, tests, provenance и Session Log.
