import { MekkaAuthProviders } from '@/components/interfaces/Auth/MekkaAuthManagement'
import AuthLayout from '@/components/layouts/AuthLayout/AuthLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import type { NextPageWithLayout } from '@/types'

const ProvidersPage: NextPageWithLayout = () => {
  return <MekkaAuthProviders />
}

ProvidersPage.getLayout = (page) => (
  <DefaultLayout>
    <AuthLayout title="Sign In / Providers">{page}</AuthLayout>
  </DefaultLayout>
)

export default ProvidersPage
