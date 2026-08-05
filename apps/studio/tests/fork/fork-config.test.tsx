import assert from 'node:assert/strict'
import { IS_PLATFORM as IS_COMMON_PLATFORM } from 'common'

import {
  generateOtherRoutes,
  generateProductRoutes,
  generateSettingsRoutes,
  generateToolRoutes,
} from '@/components/layouts/Navigation/NavigationBar/NavigationBar.utils'
import { generateMekkaAuthMenu } from '@/components/layouts/AuthLayout/AuthLayout.utils'
import type { Project } from '@/data/projects/project-detail-query'
import { getEdgeFunctionServiceStatus } from '@/data/service-status/edge-functions-status-query'
import { requireEnvironmentVariable } from '@/lib/api/self-hosted/constants'
import { IS_PLATFORM } from '@/lib/constants'
import { STUDIO_BRAND, STUDIO_FEATURES } from '@/lib/fork-config'
import { getForkProjectRedirect, getForkRouteRedirect } from '@/lib/fork-routing'

const project = { status: 'ACTIVE_HEALTHY' } as Project

assert.equal(IS_PLATFORM, false)
assert.equal(IS_COMMON_PLATFORM, false)
assert.deepEqual(STUDIO_BRAND, { name: 'Mekka', description: 'Mekka Studio' })

assert.equal(STUDIO_FEATURES.tableEditor, true)
assert.equal(STUDIO_FEATURES.sqlEditor, true)
assert.equal(STUDIO_FEATURES.auth, true)
assert.deepEqual(generateToolRoutes('local', project).map(({ key }) => key), ['editor', 'sql'])
assert.deepEqual(generateProductRoutes('local', project).map(({ key }) => key), ['auth'])
assert.deepEqual(
  generateMekkaAuthMenu('local').flatMap(({ items }) => items.map(({ key }) => key)),
  ['users', 'sign-in-up', 'url-configuration', 'email']
)
assert.deepEqual(generateOtherRoutes('local', project), [])
assert.deepEqual(generateSettingsRoutes('local'), [])

const originalFetch = globalThis.fetch
let isFetchCalled = false
globalThis.fetch = (async () => {
  isFetchCalled = true
  throw new Error('Unexpected external request')
}) as typeof fetch

try {
  assert.deepEqual(await getEdgeFunctionServiceStatus(), { healthy: false })
  assert.equal(isFetchCalled, false)
} finally {
  globalThis.fetch = originalFetch
}

assert.equal(getForkProjectRedirect('/project/local'), '/project/local/editor')
assert.equal(getForkProjectRedirect('/project/local/editor/42'), undefined)
assert.equal(getForkProjectRedirect('/project/local/sql/query'), undefined)
assert.equal(getForkProjectRedirect('/project/local/auth/users'), undefined)
assert.equal(getForkProjectRedirect('/project/local/auth/mfa'), '/project/local/auth/users')
assert.equal(
  getForkProjectRedirect('/project/local/auth/templates/password-reset'),
  '/project/local/auth/users'
)
assert.equal(getForkProjectRedirect('/project/local/storage/files'), '/project/local/editor')
assert.equal(getForkProjectRedirect('/project/local/settings/general'), '/project/local/editor')
assert.equal(getForkProjectRedirect('/project/_/storage/files'), '/project/local/editor')
assert.equal(getForkRouteRedirect('/sign-in'), undefined)
assert.equal(getForkRouteRedirect('/onboarding'), undefined)
assert.equal(getForkRouteRedirect('/'), '/project/local/editor')
assert.equal(getForkRouteRedirect('/api/platform/projects'), undefined)
assert.equal(getForkRouteRedirect('/project/local/editor/42'), undefined)
assert.equal(getForkRouteRedirect('/project/local/storage/files'), '/project/local/editor')
assert.equal(getForkRouteRedirect('/account/me'), '/project/local/editor')
assert.equal(getForkRouteRedirect('/organizations'), '/project/local/editor')
assert.throws(
  () => requireEnvironmentVariable('TEST_SECRET', undefined),
  /TEST_SECRET must be configured for Mekka Studio/
)

console.log('Mekka Studio fork assertions passed')
