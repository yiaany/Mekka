# SESSION-0044: Production launch и YC demo

## Цель
Подготовить работающий subscription product и воспроизводимое двухминутное YC demo.

## Зависимости
- SESSION-0043 passed.

## Upstream Sources
- Не клонировать новые runtime components на launch gate.
- Использовать только уже pinned/reviewed dependencies.

## Scope
- Production deployment checklist, domains, emails, billing, support и status page.
- Terms/Privacy/DPA/license notices placeholders должны быть заменены юридически проверенными документами.
- End-to-end demo: create backend, Connect Project, Studio table/Auth/Storage, MCP preview change, approval и working app.
- Activation/retention/COGS dashboards и rollback plan.

## Out of Scope
- Новые крупные features и неподтвержденная compatibility.

## Acceptance Criteria
1. Новый пользователь оплачивает план и запускает supported app.
2. Demo воспроизводится из clean account по script.
3. Backup/restore, billing webhook и incident contacts проверены.
4. Compatibility/limits честно опубликованы.

## Security
- Release gate остается зеленым; no demo/admin bypass в production.

## Tests
- Full CI/E2E, production smoke, restore drill, subscription lifecycle и rollback rehearsal.

## Deliverables
- Launch checklist, demo script, metrics snapshot и Session Log.
