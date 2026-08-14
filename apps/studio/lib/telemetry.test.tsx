import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Telemetry } from './telemetry'

const mocks = vi.hoisted(() => ({
  identify: vi.fn(),
  useUser: vi.fn(),
  useOrganizationsQuery: vi.fn(),
  setUser: vi.fn(),
  setTag: vi.fn(),
}))

vi.mock('common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('common')>()
  return {
    ...actual,
    posthogClient: {
      identify: mocks.identify,
    },
    useUser: () => mocks.useUser(),
    PageTelemetry: () => null,
  }
})

vi.mock('ui-patterns/consent', () => ({
  useConsentToast: () => ({ hasAcceptedConsent: true }),
}))

vi.mock('@/data/organizations/organizations-query', () => ({
  useOrganizationsQuery: () => mocks.useOrganizationsQuery(),
}))

vi.mock('@/hooks/misc/useSelectedOrganization', () => ({
  useSelectedOrganizationQuery: () => ({ data: undefined }),
}))

vi.mock('@sentry/nextjs', () => ({
  setUser: (...args: unknown[]) => mocks.setUser(...args),
  setTag: (...args: unknown[]) => mocks.setTag(...args),
}))

const USER_ID = 'user-abc-123'
const CREATED_AT = '2026-05-14T22:30:00.000Z'

const orgs = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: i, slug: `org-${i}` }))

describe('Telemetry — local no-op contract', () => {
  beforeEach(() => {
    mocks.identify.mockReset()
    mocks.useUser.mockReset()
    mocks.useOrganizationsQuery.mockReset()
    mocks.setUser.mockReset()
    mocks.setTag.mockReset()
  })

  it('renders nothing', () => {
    mocks.useUser.mockReturnValue({ id: USER_ID, created_at: CREATED_AT })
    mocks.useOrganizationsQuery.mockReturnValue({ data: orgs(1) })

    const { container } = render(<Telemetry />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('never fires posthog identify or sentry identification in the local fork', async () => {
    mocks.useUser.mockReturnValue({ id: USER_ID, created_at: CREATED_AT })
    mocks.useOrganizationsQuery.mockReturnValue({ data: orgs(1) })

    render(<Telemetry />)

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(mocks.identify).not.toHaveBeenCalled()
    expect(mocks.setUser).not.toHaveBeenCalled()
    expect(mocks.setTag).not.toHaveBeenCalled()
  })
})