import { createFileRoute } from '@tanstack/react-router'

import TemplatesPage from '@/pages/project/[ref]/auth/templates/index'

export const Route = createFileRoute('/project/$ref/auth/templates/')({
  component: AuthTemplatesIndexRoute,
  staticData: {
    authLayoutTitle: 'Email Templates',
  },
})

function AuthTemplatesIndexRoute() {
  return <TemplatesPage dehydratedState={undefined} />
}
