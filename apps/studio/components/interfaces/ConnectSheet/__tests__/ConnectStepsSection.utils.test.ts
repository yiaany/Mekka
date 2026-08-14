import { describe, expect, test } from 'vitest'

import type { ConnectMode, ConnectState } from '../Connect.types'
import {
  resolveContentPath,
  shouldFetchDataApiConfig,
  shouldShowDataApiDisabledWarning,
  shouldShowIpv4AddonNotice,
  shouldShowSelfHostedMcpNotice,
  shouldShowSessionPoolerNotice,
} from '../ConnectStepsSection.utils'

const ALL_MODES: ConnectMode[] = ['framework', 'direct', 'orm', 'mcp', 'server']

describe('shouldFetchDataApiConfig', () => {
  test.each(ALL_MODES)('is inert for %s mode', (mode) => {
    expect(shouldFetchDataApiConfig({ mode })).toBe(false)
  })
})

describe('shouldShowDataApiDisabledWarning', () => {
  test.each(ALL_MODES)('is inert for %s mode', (mode) => {
    expect(
      shouldShowDataApiDisabledWarning({
        mode,
        isDataApiEnabled: false,
        isPending: false,
        isError: false,
      })
    ).toBe(false)
  })
})

describe('resolveContentPath', () => {
  test('replaces multiple placeholders with state values', () => {
    const state: ConnectState = {
      mode: 'framework',
      framework: 'nextjs',
      frameworkVariant: 'app',
      library: 'supabasejs',
    }
    expect(resolveContentPath('{{framework}}/{{frameworkVariant}}/{{library}}', state)).toBe(
      'nextjs/app/supabasejs'
    )
  })

  test('filters out segments that resolve to an empty/missing state value', () => {
    const state: ConnectState = { mode: 'framework', framework: 'nextjs' }
    expect(resolveContentPath('{{framework}}/{{frameworkVariant}}', state)).toBe('nextjs')
  })

  test('returns the template unchanged when it has no placeholders', () => {
    const state: ConnectState = { mode: 'direct' }
    expect(resolveContentPath('steps/install', state)).toBe('steps/install')
  })
})

describe('shouldShowIpv4AddonNotice', () => {
  test.each(['direct', 'transaction', 'session', 'framework'] as const)(
    'is inert for %s connections',
    (connectionMethod) => {
      expect(
        shouldShowIpv4AddonNotice({
          isPlatform: true,
          mode: 'direct',
          connectionMethod,
          useSharedPooler: false,
          hasIpv4Addon: false,
        })
      ).toBe(false)
    }
  )
})

describe('shouldShowSessionPoolerNotice', () => {
  test.each(['session', 'transaction', 'direct'] as const)('is inert for %s', (connectionMethod) => {
    expect(
      shouldShowSessionPoolerNotice({
        isPlatform: true,
        mode: 'direct',
        connectionMethod,
      })
    ).toBe(false)
  })
})

describe('shouldShowSelfHostedMcpNotice', () => {
  test.each(['mcp', 'direct', 'framework'] as const)('is inert for %s mode', (mode) => {
    expect(shouldShowSelfHostedMcpNotice({ isSelfHosted: true, mode })).toBe(false)
  })
})