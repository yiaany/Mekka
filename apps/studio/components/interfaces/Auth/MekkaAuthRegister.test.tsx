import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MekkaAuthRegister } from './MekkaAuthRegister'
import { customRender } from '@/tests/lib/custom-render'

const storageKey = 'mekka:application-access-token:org-local:default:env-local:branch-main:1'
const workflowStorageKey = 'mekka:auth-workflow:org-local:default:env-local:branch-main:1'

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

  it('recovers the application session from the HttpOnly cookie without storing the refresh token', async () => {
    const accessToken = jwt(Date.now() + 60_000)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ accessToken, refreshToken: 'server-only-refresh-token' }),
          }
        }
        return { ok: true, status: 200, json: async () => ({ approvals: [] }) }
      })
    )

    customRender(<MekkaAuthRegister />)

    expect(await screen.findByText('Application session restored.')).toBeInTheDocument()
    expect(window.sessionStorage.getItem(storageKey)).toBe(accessToken)
    expect(window.sessionStorage.getItem(workflowStorageKey)).not.toContain('server-only-refresh-token')
    expect(window.localStorage.length).toBe(0)
    expect(fetch).toHaveBeenCalledWith(
      '/auth/org-local/default/env-local/branch-main/1/token',
      expect.objectContaining({ method: 'POST', credentials: 'include' })
    )
  })

  it('restores registration and active MCP state after leaving the page', async () => {
    const applicationToken = jwt(Date.now() + 60_000)
    window.sessionStorage.setItem(storageKey, applicationToken)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/token')) {
          return { ok: false, status: 503, json: async () => ({ code: 'unavailable' }) }
        }
        if (url.endsWith('/agent-token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              token: 'agent-token',
              expiresAt: Date.now() + 60_000,
              mode: 'read',
              tenant: { branchId: 'branch-main' },
            }),
          }
        }
        return { ok: true, status: 200, json: async () => ({ approvals: [] }) }
      })
    )

    const first = customRender(<MekkaAuthRegister />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alice' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'alice@example.test' } })
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Generate read-only token' }))
    await screen.findByRole('button', { name: 'Copy temporary Agent Access token' })
    await waitFor(() => expect(window.sessionStorage.getItem(workflowStorageKey)).toContain('Alice'))

    first.unmount()
    customRender(<MekkaAuthRegister />)

    expect(await screen.findByDisplayValue('Alice')).toBeInTheDocument()
    expect(screen.getByDisplayValue('alice@example.test')).toBeInTheDocument()
    expect(screen.getByDisplayValue('123456')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Copy temporary Agent Access token' })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveValue('')
  })

  it('clears local session state when cookie recovery returns 401', async () => {
    window.sessionStorage.setItem(storageKey, jwt(Date.now() + 60_000))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ code: 'AUTH_ACCESS_TOKEN_INVALID' }),
      })
    )

    customRender(<MekkaAuthRegister />)

    expect(await screen.findByText('Your application session has expired. Sign in again.')).toBeInTheDocument()
    expect(window.sessionStorage.getItem(storageKey)).toBeNull()
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument()
  })

  it('keeps a fresh local access token when cookie recovery is temporarily unavailable', async () => {
    const token = jwt(Date.now() + 60_000)
    window.sessionStorage.setItem(storageKey, token)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
        String(input).endsWith('/token')
          ? { ok: false, status: 503, json: async () => ({ error: { code: 'infrastructure' } }) }
          : { ok: true, status: 200, json: async () => ({ approvals: [] }) }
      )
    )

    customRender(<MekkaAuthRegister />)

    expect(await screen.findByText('Signed in')).toBeInTheDocument()
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(window.sessionStorage.getItem(storageKey)).toBe(token)
  })

  it.each([
    [{ message: 'Email is already registered.' }, 'Email is already registered.'],
    [{ error: { message: 'Password is too weak.' } }, 'Password is too weak.'],
    [{ error: { code: 'AUTH_ACCESS_TOKEN_INVALID' } }, 'Your application session has expired. Sign in again.'],
    [{ code: 'INVALID_EMAIL' }, 'Check the Auth form values and try again.'],
  ])('shows a safe Auth error for supported response shapes %#', async (errorBody, expectedMessage) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
        String(input).endsWith('/token')
          ? { ok: false, status: 503, json: async () => ({ code: 'unavailable' }) }
          : { ok: false, status: 400, json: async () => errorBody }
      )
    )
    customRender(<MekkaAuthRegister />)

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'member@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct-horse-battery-staple' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Register user' }))

    expect(await screen.findByText(expectedMessage)).toBeInTheDocument()
    expect(screen.queryByText(JSON.stringify(errorBody))).not.toBeInTheDocument()
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
