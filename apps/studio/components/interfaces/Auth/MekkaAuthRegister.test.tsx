import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MekkaAuthRegister } from './MekkaAuthRegister'
import { customRender } from '@/tests/lib/custom-render'

const storageKey = 'mekka:application-access-token:org-local:default:env-local:branch-main:1'

function jwt(expiresAt: number): string {
  return `header.${window.btoa(JSON.stringify({ exp: Math.floor(expiresAt / 1_000) }))}.signature`
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: 'approval-one',
    state: 'pending',
    expiresAt: Date.now() + 60_000,
    sql: 'ALTER TABLE notes ADD COLUMN title TEXT',
    destructive: false,
    tenant: {
      organizationId: 'org-local',
      projectId: 'default',
      environmentId: 'env-local',
      branchId: 'agent-preview-one',
      generation: 1,
    },
    proposalId: '11111111-1111-4111-8111-111111111111',
    executionConsumedAt: null,
    ...overrides,
  }
}

function mockApprovals(approvals: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ approvals }),
    })
  )
}

describe('MekkaAuthRegister', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('restores a fresh application session from project-scoped session storage', async () => {
    const token = jwt(Date.now() + 60_000)
    window.sessionStorage.setItem(storageKey, token)
    mockApprovals()

    customRender(<MekkaAuthRegister />)

    expect(await screen.findByText('Signed in')).toBeInTheDocument()
    expect(window.localStorage.length).toBe(0)
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/platform/mcp/approvals',
        expect.objectContaining({
          headers: { 'x-mekka-application-authorization': `Bearer ${token}` },
        })
      )
    )
  })

  it('removes an expired stored JWT without restoring signed-in state', async () => {
    window.sessionStorage.setItem(storageKey, jwt(Date.now() - 60_000))
    mockApprovals()

    customRender(<MekkaAuthRegister />)

    await waitFor(() => expect(window.sessionStorage.getItem(storageKey)).toBeNull())
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument()
  })

  it('blocks another write token while allowing read-only issuance', async () => {
    window.sessionStorage.setItem(storageKey, jwt(Date.now() + 60_000))
    mockApprovals([approval()])
    customRender(<MekkaAuthRegister />)

    const readButton = await screen.findByRole('button', {
      name: 'Generate read-only token',
    })
    expect(readButton).toBeEnabled()
    expect(await screen.findByText(/different isolated preview/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Generate read-write token' })).toBeDisabled()
  })

  it('shows the preview branch and proposal ID for approvals', async () => {
    window.sessionStorage.setItem(storageKey, jwt(Date.now() + 60_000))
    mockApprovals([approval()])

    customRender(<MekkaAuthRegister />)

    expect(await screen.findAllByText('agent-preview-one')).not.toHaveLength(0)
    expect(screen.getByText('11111111-1111-4111-8111-111111111111')).toBeInTheDocument()
    expect(screen.queryByText('org-local')).not.toBeInTheDocument()
  })
})
