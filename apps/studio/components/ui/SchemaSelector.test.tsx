import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockAnimationsApi } from 'jsdom-testing-mocks'
import { describe, expect, it, vi } from 'vitest'

import { SchemaSelector } from './SchemaSelector'
import { customRender } from '@/tests/lib/custom-render'
import { addAPIMock } from '@/tests/lib/msw'

mockAnimationsApi()

const mockProject = ({ highAvailability }: { highAvailability: boolean }) => {
  // useSelectedProjectQuery
  addAPIMock({
    method: 'get',
    path: '/platform/projects/:ref',
    // @ts-expect-error partial project response
    response: {
      cloud_provider: 'localhost',
      id: 1,
      inserted_at: '2021-08-02T06:40:40.646Z',
      name: 'Default Project',
      organization_id: 1,
      ref: 'default',
      region: 'local',
      status: 'ACTIVE_HEALTHY',
      high_availability: highAvailability,
    },
  })
}

const renderAndOpenSelector = async () => {
  customRender(<SchemaSelector selectedSchemaName="public" onSelectSchema={vi.fn()} />)

  await userEvent.click(await screen.findByTestId('schema-selector'))
  await screen.findByRole('option', { name: 'main' })
}

describe('SchemaSelector', () => {
  it('offers only the local SQLite schema on high availability projects', async () => {
    mockProject({ highAvailability: true })

    await renderAndOpenSelector()

    expect(screen.getByRole('option', { name: 'main' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'multigres' })).not.toBeInTheDocument()
  })

  it('does not expose PostgreSQL schemas on non high availability projects', async () => {
    mockProject({ highAvailability: false })

    await renderAndOpenSelector()

    expect(screen.getByRole('option', { name: 'main' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'public' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'multigres' })).not.toBeInTheDocument()
  })
})
