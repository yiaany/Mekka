import { MekkaStoragePolicies } from '@/components/interfaces/Storage/MekkaStorageManagement'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { StorageBucketsLayout } from '@/components/layouts/StorageLayout/StorageBucketsLayout'
import StorageLayout from '@/components/layouts/StorageLayout/StorageLayout'
import type { NextPageWithLayout } from '@/types'

const FilesPoliciesPage: NextPageWithLayout = () => {
  return <MekkaStoragePolicies />
}

FilesPoliciesPage.getLayout = (page) => (
  <DefaultLayout>
    <StorageLayout title="Policies">
      <StorageBucketsLayout>{page}</StorageBucketsLayout>
    </StorageLayout>
  </DefaultLayout>
)

export default FilesPoliciesPage
