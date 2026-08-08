import { isStudioDomainError } from '@mekka/studio-domain-sdk'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'common'
import Link from 'next/link'
import { PageContainer } from 'ui-patterns/PageContainer'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'
import { Button } from 'ui'

import DatabaseLayout from '@/components/layouts/DatabaseLayout/DatabaseLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { PageLayout } from '@/components/layouts/PageLayout/PageLayout'
import { createProjectStudioDomainClient } from '@/data/studio-domain/client'
import type { NextPageWithLayout } from '@/types'

const DatabaseTables: NextPageWithLayout = () => {
  const { ref: projectRef } = useParams()

  return (
    <PageLayout title="Database Tables" size="large">
        <PageContainer size="large">
          <PageSection>
            <PageSectionContent>
              <SqliteTableList projectRef={projectRef} />
            </PageSectionContent>
          </PageSection>
        </PageContainer>
    </PageLayout>
  )
}

function SqliteTableList({ projectRef }: { projectRef: string | undefined }) {
  const tables = useQuery({
    queryKey: ['sqlite-tables', projectRef],
    queryFn: () => createProjectStudioDomainClient(projectRef!).listTables(),
    enabled: projectRef !== undefined,
  })

  if (!projectRef) return null
  if (tables.isLoading) return <p>Loading tables...</p>
  if (tables.isError) {
    const message = isStudioDomainError(tables.error)
      ? tables.error.message
      : 'The local database service is unavailable.'
    return (
      <div className="space-y-3" role="alert">
        <p>Failed to load tables: {message}</p>
        <Button onClick={() => void tables.refetch()}>Reload tables</Button>
      </div>
    )
  }
  const tableList = tables.data?.tables ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-foreground-light">SQLite tables in the main namespace</p>
        <Button asChild>
          <Link href={`/project/${projectRef}/editor/new`}>New table</Link>
        </Button>
      </div>
      {tableList.length === 0 && <p>No tables created yet.</p>}
      {tableList.length > 0 && (
        <ul className="divide-y rounded border">
          {tableList.map((table) => (
            <li key={table.id} className="flex items-center justify-between p-3">
              <div>
                <p>{table.name}</p>
                <p className="text-sm text-foreground-light">
                  {table.columnCount} {table.columnCount === 1 ? 'column' : 'columns'}
                </p>
              </div>
              <Button asChild size="tiny" variant="default">
                <Link href={`/project/${projectRef}/editor/${encodeURIComponent(table.name)}`}>Open</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

DatabaseTables.getLayout = (page) => (
  <DefaultLayout>
    <DatabaseLayout title="Tables">{page}</DatabaseLayout>
  </DefaultLayout>
)

export default DatabaseTables
