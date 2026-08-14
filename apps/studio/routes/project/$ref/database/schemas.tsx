import { createFileRoute, redirect } from '@tanstack/react-router'

import SchemasPage from '@/pages/project/[ref]/database/schemas'
import { STUDIO_FEATURES } from '@/lib/fork-config'

export const Route = createFileRoute('/project/$ref/database/schemas')({
  beforeLoad: ({ params }) => {
    if (!STUDIO_FEATURES.database) {
      throw redirect({ to: '/project/$ref/editor', params: { ref: params.ref } })
    }
  },
  component: SchemasRoute,
  staticData: {
    databaseLayoutTitle: 'Schema Visualizer',
  },
})

function SchemasRoute() {
  return <SchemasPage dehydratedState={undefined} />
}
