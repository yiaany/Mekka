import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  AuthUserDeleteConfirmation,
  AuthUserRevokeConfirmation,
} from '@/components/interfaces/Auth/MekkaAuthManagement'

const modal = AuthUserRevokeConfirmation({
  user: {
    id: 'user-001',
    email: 'member@example.test',
    name: 'Member',
    emailVerified: true,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    sessionCount: 2,
  },
  isLoading: false,
  onCancel: () => undefined,
  onConfirm: () => undefined,
})

assert.equal(modal.props.title, 'Revoke all user sessions?')
assert.match(modal.props.description, /member@example\.test/)
assert.match(modal.props.alert.description, /refresh-token chains/)
assert.equal(modal.props.confirmLabel, 'Revoke sessions')

const deleteModal = AuthUserDeleteConfirmation({
  user: {
    id: 'user-001',
    email: 'member@example.test',
    name: 'Member',
    emailVerified: true,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    sessionCount: 2,
  },
  isLoading: false,
  onCancel: () => undefined,
  onConfirm: () => undefined,
})

assert.equal(deleteModal.props.title, 'Permanently delete Auth user?')
assert.equal(deleteModal.props.confirmString, 'user-001')
assert.equal(deleteModal.props.confirmLabel, 'Delete user')
assert.equal(deleteModal.props.variant, 'destructive')
assert.match(deleteModal.props.alert.description, /linked accounts/)

test('Auth management assertions completed', () => {})
