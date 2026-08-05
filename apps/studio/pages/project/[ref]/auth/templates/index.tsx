import { MekkaAuthTemplates } from '@/components/interfaces/Auth/MekkaAuthManagement'
import AuthLayout from '@/components/layouts/AuthLayout/AuthLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import type { NextPageWithLayout } from '@/types'

const TemplatesPage: NextPageWithLayout = () => {
  return <MekkaAuthTemplates />
}

TemplatesPage.getLayout = (page) => (
  <DefaultLayout>
    <AuthLayout title="Email Templates">{page}</AuthLayout>
  </DefaultLayout>
)

export default TemplatesPage
