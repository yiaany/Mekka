import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/project/$ref/sql/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/project/$ref/sql/$id', params: { ref: params.ref, id: 'new' } })
  },
})
