import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { AuthUserRevokeConfirmation } from '@/components/interfaces/Auth/MekkaAuthManagement'

const html = renderToStaticMarkup(
  <AuthUserRevokeConfirmation
    user={{
      id: 'user-001',
      email: 'member@example.test',
      name: 'Member',
      emailVerified: true,
      createdAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
      sessionCount: 2,
    }}
    isLoading={false}
    onCancel={() => undefined}
    onConfirm={() => undefined}
  />
)

assert.match(html, /Revoke all user sessions/)
assert.match(html, /member@example\.test/)
assert.match(html, /refresh-token chains/)
assert.match(html, /Revoke sessions/)
