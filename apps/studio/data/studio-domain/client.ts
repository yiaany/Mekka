import { createStudioDomainClient } from '@mekka/studio-domain-sdk'
import { getAccessToken } from 'common'

export function createProjectStudioDomainClient(projectRef: string) {
  const configuredGeneration = process.env.NEXT_PUBLIC_STUDIO_GENERATION
  return createStudioDomainClient({
    baseUrl: `/api/platform/sqlite-meta/${encodeURIComponent(projectRef)}`,
    tenant: {
      organizationId: process.env.NEXT_PUBLIC_STUDIO_ORGANIZATION_ID ?? 'org-local',
      projectId: projectRef,
      environmentId: process.env.NEXT_PUBLIC_STUDIO_ENVIRONMENT_ID ?? 'env-local',
      branchId: process.env.NEXT_PUBLIC_STUDIO_BRANCH_ID ?? 'branch-main',
      generation: configuredGeneration === undefined ? 1 : Number(configuredGeneration),
    },
    getCredential: async () => {
      const token = await getAccessToken()
      return token ? { kind: 'session', token } : undefined
    },
  })
}
