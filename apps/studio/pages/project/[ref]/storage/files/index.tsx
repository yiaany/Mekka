import { MekkaStorageBuckets } from '@/components/interfaces/Storage/MekkaStorageManagement'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { StorageBucketsLayout } from '@/components/layouts/StorageLayout/StorageBucketsLayout'
import StorageLayout from '@/components/layouts/StorageLayout/StorageLayout'
import type { NextPageWithLayout } from '@/types'

const StorageFilesPage: NextPageWithLayout = () => {
  return <MekkaStorageBuckets />
}

StorageFilesPage.getLayout = (page) => (
  <DefaultLayout>
    <StorageLayout title="Files">
      <StorageBucketsLayout>{page}</StorageBucketsLayout>
    </StorageLayout>
  </DefaultLayout>
)

export default StorageFilesPage
