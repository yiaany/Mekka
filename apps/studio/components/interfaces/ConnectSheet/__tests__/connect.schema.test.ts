import { describe, expect, test } from 'vitest'

import { resolveSteps } from '../connect.resolver'
import { connectSchema } from '../connect.schema'

describe('Mekka Connect schema', () => {
  test('exposes only the supported Mekka MCP integration surface', () => {
    expect(connectSchema.modes).toEqual([
      {
        id: 'mcp',
        label: 'Mekka MCP',
        description: 'Tenant-bound agent access',
        fields: [],
      },
    ])
    expect(connectSchema.fields).toEqual({})
  })

  test('does not emit package install, agent skills, direct, ORM, or server instructions', () => {
    expect(resolveSteps(connectSchema, { mode: 'mcp' })).toEqual([
      {
        id: 'mcp-status',
        title: 'Mekka MCP',
        description:
          'MCP is available only when a tenant-bound endpoint and OAuth issuer are configured.',
        optional: undefined,
        content: 'mekka/mcp',
      },
    ])
  })
})
