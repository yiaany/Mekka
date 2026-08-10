import assert from 'node:assert/strict'
import { StudioDomainError } from '@mekka/studio-domain-sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'

import { StudioDomainEntityListItem } from '../../components/layouts/TableEditorLayout/StudioDomainEntityListItem'
import { StudioDomainErrorPanel } from '../../components/layouts/TableEditorLayout/StudioDomainErrorPanel'
import { mapStudioTablesToEntityTypes } from '../../data/entity-types/studio-domain-adapter'

const correlationId = '018e6c28-0000-7000-8000-000000000001' as never
const result = mapStudioTablesToEntityTypes({
  tables: [
    {
      id: 'notes',
      name: 'notes',
      namespace: 'main',
      kind: 'table',
      columnCount: 2,
      primaryKey: ['id'],
    },
  ],
  totalCount: 1,
})
const entity = result.data.entities[0]!
const tableHtml = renderToStaticMarkup(
  <StudioDomainEntityListItem item={entity} />
)

assert.deepEqual(entity, {
  id: -1,
  domainId: 'notes',
  schema: 'main',
  name: 'notes',
  type: 'r',
  comment: null,
  rls_enabled: false,
  source: 'studio-domain',
})
assert.match(tableHtml, /notes/)
assert.match(tableHtml, /notes/)
assert.doesNotMatch(tableHtml, /columnCount|primaryKey/)

for (const [code, status, message] of [
  ['auth', 401, 'session has expired'],
  ['conflict', 409, 'resource changed'],
  ['infrastructure', 503, 'temporarily unavailable'],
] as const) {
  const errorHtml = renderToStaticMarkup(
    <StudioDomainErrorPanel error={new StudioDomainError(code, status, correlationId)} />
  )
  assert.match(errorHtml, /role="alert"/)
  assert.ok(errorHtml.includes(message))
  assert.ok(errorHtml.includes(correlationId))
}

test('Studio domain integration assertions completed', () => {})
