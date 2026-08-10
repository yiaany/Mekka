import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'

import {
  StorageObjectRow,
  StoragePolicySummaryCard,
  StorageUnsupportedControlsNotice,
} from '@/components/interfaces/Storage/MekkaStorageManagement'

const objectHtml = renderToStaticMarkup(
  <StorageObjectRow
    object={{
      bucketName: 'assets',
      path: '<img src=x onerror=alert(1)>.txt',
      size: 12,
      contentType: 'text/plain',
      checksumSha256: 'a'.repeat(64),
      version: 'object-version-001',
      createdAt: 1,
      updatedAt: 1,
    }}
    onDownload={() => undefined}
    onDelete={() => undefined}
  />
)
assert.match(objectHtml, /&lt;img src=x onerror=alert\(1\)&gt;\.txt/)
assert.doesNotMatch(objectHtml, /<img src=x/)

const policyHtml = renderToStaticMarkup(
  <StoragePolicySummaryCard
    summary={{
      bucketName: 'assets',
      canUpdateBucket: false,
      canDeleteBucket: false,
      canListObjects: true,
      canCreateObjects: true,
      canReadObjects: true,
      canDeleteObjects: false,
    }}
  />
)
assert.match(policyHtml, /List files/)
assert.match(policyHtml, /Allowed/)
assert.match(policyHtml, /Denied/)

const unsupportedHtml = renderToStaticMarkup(<StorageUnsupportedControlsNotice />)
assert.match(unsupportedHtml, /Image transforms/)
assert.match(unsupportedHtml, /advanced CDN settings/)
assert.match(unsupportedHtml, /not supported/)

test('Storage management assertions completed', () => {})
