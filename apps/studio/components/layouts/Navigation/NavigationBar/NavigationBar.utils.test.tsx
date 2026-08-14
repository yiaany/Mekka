import { describe, expect, it } from 'vitest'

import {
  generateOtherRoutes,
  generateProductRoutes,
  generateSettingsRoutes,
  generateToolRoutes,
} from './NavigationBar.utils'
import type { Project } from '@/data/projects/project-detail-query'

const REF = 'test-project-ref'

const activeProject = { status: 'ACTIVE_HEALTHY' } as Project
const buildingProject = { status: 'COMING_UP' } as Project
const inactiveProject = { status: 'INACTIVE' } as Project

const keys = (routes: { key: string }[]) => routes.map((r) => r.key)

describe('generateToolRoutes', () => {
  it('always returns Table Editor and SQL Editor', () => {
    const routes = generateToolRoutes(REF, activeProject)
    expect(keys(routes)).toEqual(['editor', 'sql'])
  })

  it('marks routes as disabled when project is not active', () => {
    const routes = generateToolRoutes(REF, inactiveProject)
    expect(routes.every((r) => r.disabled)).toBe(true)
  })

  it('points links to the building URL when project is building', () => {
    const routes = generateToolRoutes(REF, buildingProject)
    expect(routes.every((r) => r.link === `/project/${REF}`)).toBe(true)
  })

  it('returns links as false when ref is undefined', () => {
    const routes = generateToolRoutes(undefined, activeProject)
    expect(routes.every((r) => r.link === undefined)).toBe(true)
  })
})

describe('generateProductRoutes', () => {
  it('includes only auth by default (other products are fork-disabled)', () => {
    const routes = generateProductRoutes(REF, activeProject)
    expect(keys(routes)).toEqual(['auth'])
  })

  it('keeps fork-disabled products out even when features are enabled', () => {
    const routes = generateProductRoutes(REF, activeProject, {
      auth: true,
      database: true,
      storage: true,
      edgeFunctions: true,
      realtime: true,
    })
    expect(keys(routes)).toEqual(['auth'])
  })

  it('excludes auth when auth feature is disabled', () => {
    const routes = generateProductRoutes(REF, activeProject, { auth: false })
    expect(keys(routes)).toEqual([])
  })

  it('links auth to overview page when authOverviewPage is enabled', () => {
    const routes = generateProductRoutes(REF, activeProject, { authOverviewPage: true })
    const authRoute = routes.find((r) => r.key === 'auth')
    expect(authRoute?.link).toBe(`/project/${REF}/auth/overview`)
  })

  it('links auth to users page by default', () => {
    const routes = generateProductRoutes(REF, activeProject)
    const authRoute = routes.find((r) => r.key === 'auth')
    expect(authRoute?.link).toBe(`/project/${REF}/auth/users`)
  })
})

describe('generateOtherRoutes', () => {
  it('returns no routes in the local fork (advisors, logs, integrations, observability disabled)', () => {
    const routes = generateOtherRoutes(REF, activeProject)
    expect(keys(routes)).toEqual([])
  })

  it('keeps observability out even when reports are enabled', () => {
    const routes = generateOtherRoutes(REF, activeProject, { showReports: true })
    expect(keys(routes)).not.toContain('observability')
  })
})

describe('generateSettingsRoutes', () => {
  it('returns no routes when settings are fork-disabled', () => {
    expect(generateSettingsRoutes(REF)).toEqual([])
  })
})