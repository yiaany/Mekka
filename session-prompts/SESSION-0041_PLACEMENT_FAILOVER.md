# SESSION-0041: Multi-node placement и failover

## Цель
Безопасно размещать project databases на нескольких nodes с single-writer fencing.

## Зависимости
- SESSION-0003, SESSION-0027, SESSION-0040.

## Upstream Sources
- `https://github.com/tursodatabase/libsql` и `https://github.com/tursodatabase/turso`.
- Клонировать/pin engine commits; изучить replication/locking/failure semantics и conformance limits.
- Не обещать multi-writer, если выбранный engine его не подтверждает.

## Scope
- Placement catalog, owner lease, monotonic fencing token и router generation checks.
- Drain/revoke/failover state machine и reconciliation.
- No shared unsafe network filesystem.

## Out of Scope
- Global multi-primary и automatic data partitioning.

## Acceptance Criteria
1. Два writers не могут подтвердить запись одновременно.
2. Stale owner fenced после failover.
3. Router/catalog uncertainty fail-closed.

## Security
- Authenticated internal control messages, audit и generation reuse protection.

## Tests
- Split-brain simulation, lease expiry, network partition, crash/recovery и corruption check.

## Deliverables
- Placement/router feature, ADR, chaos tests и Session Log.
