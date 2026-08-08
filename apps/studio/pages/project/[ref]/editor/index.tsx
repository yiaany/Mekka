import { SqliteTableEditor } from '@/components/interfaces/SqliteTableEditor/SqliteTableEditor'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { EditorBaseLayout } from '@/components/layouts/editors/EditorBaseLayout'
import { TableEditorLayout } from '@/components/layouts/TableEditorLayout/TableEditorLayout'
import { TableEditorMenu } from '@/components/layouts/TableEditorLayout/TableEditorMenu'
import type { NextPageWithLayout } from '@/types'

const TableEditorPage: NextPageWithLayout = () => {
  return <SqliteTableEditor />
}

TableEditorPage.getLayout = (page) => (
  <DefaultLayout>
    <EditorBaseLayout
      productMenu={<TableEditorMenu />}
      product="Table Editor"
      productMenuClassName="overflow-y-hidden"
    >
      <TableEditorLayout>{page}</TableEditorLayout>
    </EditorBaseLayout>
  </DefaultLayout>
)

export default TableEditorPage
