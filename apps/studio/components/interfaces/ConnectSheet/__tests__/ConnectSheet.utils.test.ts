import { describe, expect, test } from 'vitest'

import { mapConnectTabToMode, resolveConnectSheetHydration } from '../ConnectSheet.utils'
import type { ConnectSheetQueryParams } from '../ConnectSheet.utils'

const EMPTY_QUERY: ConnectSheetQueryParams = {
  connectTab: null,
  framework: null,
  using: null,
  method: null,
  type: null,
  mcpClient: null,
}

describe('Mekka Connect URL hydration', () => {
  test('accepts only the MCP tab', () => {
    expect(mapConnectTabToMode('mcp')).toBe('mcp')
    expect(mapConnectTabToMode('framework')).toBeNull()
    expect(mapConnectTabToMode('direct')).toBeNull()
    expect(mapConnectTabToMode('orm')).toBeNull()
    expect(mapConnectTabToMode('server')).toBeNull()
  })

  test('does not restore legacy Connect tabs or their fields from URL or storage', () => {
    expect(
      resolveConnectSheetHydration(
        { ...EMPTY_QUERY, connectTab: 'direct', method: 'transaction' },
        { connectTab: 'frameworks', framework: 'nextjs' },
        ['mcp']
      )
    ).toEqual({ mode: null, fieldUpdates: [], urlUpdates: {} })
  })

  test('restores the MCP tab without generating client configuration', () => {
    expect(resolveConnectSheetHydration(EMPTY_QUERY, { connectTab: 'mcp' }, ['mcp'])).toEqual({
      mode: 'mcp',
      fieldUpdates: [],
      urlUpdates: { connectTab: 'mcp' },
    })
  })
})
