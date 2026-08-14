import type { AnyRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sentryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  tanstackRouterBrowserTracingIntegration: vi.fn(() => ({
    name: 'TanStackRouterBrowserTracing',
  })),
  // Imported at module scope by lib/sentry-client-options.ts, so the mock
  // must provide it even though the TanStack init never enables it.
  thirdPartyErrorFilterIntegration: vi.fn(() => ({ name: 'ThirdPartyErrorsFilter' })),
}))

vi.mock('@sentry/react', () => sentryMocks)

// The integration only needs a router reference to hook navigation events, and
// it is mocked here — a stub stands in for the real router at this boundary.
const fakeRouter = { subscribe: vi.fn() } as unknown as AnyRouter

// sentry.tanstack.ts keeps a module-level `initialized` flag, so each test
// imports a fresh copy of the module.
async function loadInitializer() {
  vi.resetModules()
  const { initSentryTanStackClient } = await import('./sentry.tanstack')
  return initSentryTanStackClient
}

describe('initSentryTanStackClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('does not initialize Sentry during SSR/prerender (no window)', async () => {
    const initSentryTanStackClient = await loadInitializer()
    vi.stubGlobal('window', undefined)

    initSentryTanStackClient(fakeRouter)

    expect(sentryMocks.init).not.toHaveBeenCalled()
  })

  it('stays disabled in the browser (fork contract, no error reporter)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@sentry.example.com/1')
    vi.stubGlobal('window', {} as Window & typeof globalThis)
    const initSentryTanStackClient = await loadInitializer()

    initSentryTanStackClient(fakeRouter)

    // Client error reporting is intentionally disabled in the private fork:
    // no client, no tracing integration, no release wiring.
    expect(sentryMocks.init).not.toHaveBeenCalled()
    expect(sentryMocks.tanstackRouterBrowserTracingIntegration).not.toHaveBeenCalled()
    expect(sentryMocks.thirdPartyErrorFilterIntegration).not.toHaveBeenCalled()
  })

  it('does not depend on a DSN or release configuration', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', undefined)
    vi.stubEnv('NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA', 'abc123commit')
    vi.stubGlobal('window', {} as Window & typeof globalThis)
    const initSentryTanStackClient = await loadInitializer()

    initSentryTanStackClient(fakeRouter)

    expect(sentryMocks.init).not.toHaveBeenCalled()
  })

  it('remains a no-op across repeated calls', async () => {
    vi.stubGlobal('window', {} as Window & typeof globalThis)
    const initSentryTanStackClient = await loadInitializer()

    initSentryTanStackClient(fakeRouter)
    initSentryTanStackClient(fakeRouter)

    expect(sentryMocks.init).not.toHaveBeenCalled()
  })
})