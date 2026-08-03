# SESSION-0031: Connect Project через GitHub

## Цель
Подключить GitHub repository одной кнопкой через reviewable patch/PR и проверить реальное соединение.

## Зависимости
- SESSION-0030.

## Upstream Sources
- `https://github.com/octokit/octokit.js`.
- Клонировать/pin stable release, проверить MIT и использовать официальный client/auth strategy.
- Не писать GitHub API/signature verification вручную без необходимости.

## Scope
- GitHub App install flow с минимальными permissions.
- Получение analyzer plan, preview diff, branch/commit/PR после confirmation.
- Добавление SDK client, env references, generated types и MCP config.
- Build/typecheck/smoke test в sandbox и rollback manifest.

## Out of Scope
- Автоматический merge, arbitrary framework support и Vercel secret write.

## Acceptance Criteria
1. Supported repository получает PR без secrets.
2. Повторный connect идемпотентен.
3. Existing user changes не перезаписываются молча.
4. Failed build показывает actionable diagnostics.

## Security
- Webhook signature, installation/repo binding, least permissions, no hidden push.

## Tests
- Webhook/auth, diff, conflict, rerun, secret scan и end-to-end fixture.

## Deliverables
- GitHub integration, Studio flow, tests и Session Log.
