import { MekkaStorageBucket } from '@/components/interfaces/Storage/MekkaStorageManagement'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import StorageLayout from '@/components/layouts/StorageLayout/StorageLayout'
import type { NextPageWithLayout } from '@/types'

const BucketPage: NextPageWithLayout = () => <MekkaStorageBucket />

BucketPage.getLayout = (page) => (
  <DefaultLayout>
    <StorageLayout title="Buckets">{page}</StorageLayout>
  </DefaultLayout>
)

export default BucketPage
