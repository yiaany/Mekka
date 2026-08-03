# SESSION-0043: Security release gate

## Цель
Провести системный security hardening перед production launch и закрыть Critical/High findings.

## Зависимости
- SESSION-0001-0042 completed или явно waived с owner/date.

## Upstream Sources
- `https://github.com/OWASP/ASVS` как release checklist reference.
- Клонировать/pin release, проверить license и выбрать применимые controls.
- Security scanners выбираются только после license/maintenance review.

## Scope
- Обновить threat model всех trust boundaries.
- Tenant isolation, auth, MCP, Studio, Functions, Storage, backup и supply-chain review.
- SAST/dependency/container/secret scans и external pentest preparation.
- Исправить найденные Critical/High defects с regression tests.

## Out of Scope
- Формальная сертификация SOC 2.

## Acceptance Criteria
1. Нет известных unaccepted Critical/High findings.
2. Every accepted Medium risk имеет owner/deadline.
3. Restore, key rotation и incident tabletop выполнены.

## Security
- Эта сессия является security gate; нельзя ослаблять checks ради launch date.

## Tests
- Full security/tenant suite, restore drill, scanners и targeted penetration cases.

## Deliverables
- Threat model, findings register, fixes, release decision и Session Log.
