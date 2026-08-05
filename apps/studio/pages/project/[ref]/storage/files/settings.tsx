import { StorageUnsupportedControlsNotice } from '@/components/interfaces/Storage/MekkaStorageManagement'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { StorageBucketsLayout } from '@/components/layouts/StorageLayout/StorageBucketsLayout'
import StorageLayout from '@/components/layouts/StorageLayout/StorageLayout'
import type { NextPageWithLayout } from '@/types'
import { PageContainer } from 'ui-patterns/PageContainer'

const FilesSettingsPage: NextPageWithLayout = () => {
  return (
    <PageContainer size="default" className="py-6">
      <StorageUnsupportedControlsNotice />
    </PageContainer>
  )
}

FilesSettingsPage.getLayout = (page) => (
  <DefaultLayout>
    <StorageLayout title="Settings">
      <StorageBucketsLayout>{page}</StorageBucketsLayout>
    </StorageLayout>
  </DefaultLayout>
)

export default FilesSettingsPage
