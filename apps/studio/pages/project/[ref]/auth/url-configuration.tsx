import { MekkaAuthRedirects } from '@/components/interfaces/Auth/MekkaAuthManagement'
import AuthLayout from '@/components/layouts/AuthLayout/AuthLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import type { NextPageWithLayout } from '@/types'

const URLConfiguration: NextPageWithLayout = () => {
  return <MekkaAuthRedirects />
}

URLConfiguration.getLayout = (page) => (
  <DefaultLayout>
    <AuthLayout title="URL Configuration">{page}</AuthLayout>
  </DefaultLayout>
)

export default URLConfiguration
