import { useParams } from 'common/hooks/useParams'
import { useRouter } from 'next/router'
import { useEffect } from 'react'

import { SqliteSqlEditor } from '@/components/interfaces/SqliteTableEditor/SqliteSqlEditor'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { EditorBaseLayout } from '@/components/layouts/editors/EditorBaseLayout'
import SQLEditorLayout from '@/components/layouts/SQLEditorLayout/SQLEditorLayout'
import { SQLEditorMenu } from '@/components/layouts/SQLEditorLayout/SQLEditorMenu'
import {
  buildSqliteSqlEditorPath,
  createSqliteSqlEditorId,
  isSqliteSqlEditorId,
} from '@/lib/sqlite-sql-editor-routing'
import {
  getOrCreateSqliteSqlEditorSession,
  removeSqliteSqlEditorSession,
} from '@/state/sqlite-sql-editor'
import { createTabId, useTabsStateSnapshot } from '@/state/tabs'
import type { NextPageWithLayout } from '@/types'

const SqlEditor: NextPageWithLayout = () => {
  const { id, ref } = useParams()
  const router = useRouter()
  const tabs = useTabsStateSnapshot()
  const isEditorReady = ref !== undefined && isSqliteSqlEditorId(id)

  useEffect(() => {
    if (!router.isReady || ref === undefined) return
    if (id === 'new') {
      router.replace(buildSqliteSqlEditorPath(ref, createSqliteSqlEditorId()))
      return
    }
    if (!isSqliteSqlEditorId(id)) router.replace(`/project/${ref}/sql/new`)
  }, [id, ref, router.isReady])

  useEffect(() => {
    if (!isEditorReady) return
    getOrCreateSqliteSqlEditorSession(id)
    tabs.addTab({
      id: createTabId('sql', { id }),
      type: 'sql',
      label: 'Query',
      isPreview: false,
      metadata: { sqlId: id, name: 'Query' },
    })
    // The tabs snapshot exposes stable store actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isEditorReady])

  useEffect(
    () =>
      tabs.registerTabTypeHandler('sql', {
        onClose(tab) {
          const sqlId = tab.metadata?.sqlId
          if (isSqliteSqlEditorId(sqlId)) removeSqliteSqlEditorSession(sqlId)
        },
      }),
    // The handler is registered once for the lifetime of this editor route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  return isEditorReady ? <SqliteSqlEditor projectRef={ref} editorId={id} /> : null
}

SqlEditor.getLayout = (page) => (
  <DefaultLayout>
    <EditorBaseLayout productMenu={<SQLEditorMenu />} product="SQL Editor">
      <SQLEditorLayout>{page}</SQLEditorLayout>
    </EditorBaseLayout>
  </DefaultLayout>
)

export default SqlEditor
