import { createStudioStorageClient } from '@mekka/studio-domain-sdk'
import { getAccessToken } from 'common'

const csrfLifetimeMilliseconds = 14 * 60 * 1000
const csrfRequests = new Map<string, Readonly<{ expiresAt: number; token: Promise<string> }>>()

export function createProjectStudioStorageClient(projectRef: string) {
  const configuredGeneration = process.env.NEXT_PUBLIC_STUDIO_GENERATION
  const tenant = {
    organizationId: process.env.NEXT_PUBLIC_STUDIO_ORGANIZATION_ID ?? 'org-local',
    projectId: projectRef,
    environmentId: process.env.NEXT_PUBLIC_STUDIO_ENVIRONMENT_ID ?? 'env-local',
    branchId: process.env.NEXT_PUBLIC_STUDIO_BRANCH_ID ?? 'branch-main',
    generation: configuredGeneration === undefined ? 1 : Number(configuredGeneration),
  }
  return createStudioStorageClient({
    baseUrl: `/api/platform/storage-admin/${encodeURIComponent(projectRef)}`,
    tenant,
    getCredential: async () => {
      const token = await getAccessToken()
      return token ? { kind: 'session', token } : undefined
    },
    getCsrfToken: () => getProjectCsrfToken(projectRef, tenant),
  })
}

function getProjectCsrfToken(
  projectRef: string,
  tenant: Readonly<{
    organizationId: string
    environmentId: string
    branchId: string
    generation: number
  }>
): Promise<string> {
  const cacheKey = [
    tenant.organizationId,
    projectRef,
    tenant.environmentId,
    tenant.branchId,
    tenant.generation,
  ].join(':')
  const cached = csrfRequests.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.token
  const token = requestProjectCsrfToken(projectRef, tenant).catch((error: unknown) => {
    csrfRequests.delete(cacheKey)
    throw error
  })
  csrfRequests.set(cacheKey, { expiresAt: Date.now() + csrfLifetimeMilliseconds, token })
  return token
}

async function requestProjectCsrfToken(
  projectRef: string,
  tenant: Readonly<{
    organizationId: string
    environmentId: string
    branchId: string
    generation: number
  }>
): Promise<string> {
  const token = await getAccessToken()
  if (!token) throw new Error('Studio session is required')
  const response = await fetch(`/api/platform/storage-admin/${encodeURIComponent(projectRef)}/csrf`, {
    credentials: 'include',
    headers: {
      authorization: `Bearer ${token}`,
      'x-mekka-project-id': projectRef,
      'x-mekka-organization-id': tenant.organizationId,
      'x-mekka-environment-id': tenant.environmentId,
      'x-mekka-branch-id': tenant.branchId,
      'x-mekka-generation': String(tenant.generation),
    },
  })
  const body: unknown = await response.json()
  if (
    !response.ok ||
    typeof body !== 'object' ||
    body === null ||
    !('token' in body) ||
    typeof body.token !== 'string'
  ) {
    throw new Error('Unable to establish Studio CSRF protection')
  }
  return body.token
}
