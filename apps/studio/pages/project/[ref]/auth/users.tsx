import { MekkaAuthUsers } from '@/components/interfaces/Auth/MekkaAuthManagement'
import AuthLayout from '@/components/layouts/AuthLayout/AuthLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import type { NextPageWithLayout } from '@/types'

const UsersPage: NextPageWithLayout = () => {
  return <MekkaAuthUsers />
}

UsersPage.getLayout = (page) => (
  <DefaultLayout>
    <AuthLayout title="Users">{page}</AuthLayout>
  </DefaultLayout>
)

export default UsersPage
