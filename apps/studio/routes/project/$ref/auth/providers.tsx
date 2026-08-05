import { createFileRoute } from '@tanstack/react-router'

import ProvidersPage from '@/pages/project/[ref]/auth/providers'

export const Route = createFileRoute('/project/$ref/auth/providers')({
  component: AuthProvidersRoute,
  staticData: {
    authLayoutTitle: 'Sign In / Providers',
  },
})

function AuthProvidersRoute() {
  return <ProvidersPage dehydratedState={undefined} />
}
