# SESSION-0040: Observability и operations baseline

## Цель
Сделать production paths диагностируемыми через logs, metrics, traces, SLO и runbooks.

## Зависимости
- Основные services до SESSION-0039.

## Upstream Sources
- `https://github.com/open-telemetry/opentelemetry-js`.
- Клонировать/pin stable packages, проверить Apache-2.0; использовать официальные SDK/exporter contracts.

## Scope
- Correlation IDs, trace propagation, service metrics и redaction boundary.
- Project-facing logs/usage views и internal alerts.
- Initial SLO, backup/restore/incident runbooks и status-page integration.

## Out of Scope
- Собственная telemetry database и full SOC process.

## Acceptance Criteria
1. Failed user request трассируется между router/service/storage.
2. Logs не содержат known secret fixtures.
3. SLO metrics и alert thresholds вычисляются.

## Security
- PII redaction, access control, retention и bounded cardinality.

## Tests
- Trace/log integration, redaction regression и alert calculation tests.

## Deliverables
- Telemetry package/config, runbooks, tests и Session Log.
