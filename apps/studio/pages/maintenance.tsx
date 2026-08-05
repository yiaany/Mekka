import { RefreshCw } from 'lucide-react'
import Head from 'next/head'
import { Button, cn } from 'ui'

import { BASE_PATH } from '@/lib/constants'
import type { NextPageWithLayout } from '@/types'

const MaintenancePage: NextPageWithLayout = () => {
  return (
    <>
      <Head>
        <title>Mekka | Under Maintenance</title>
      </Head>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="flex items-center justify-center mb-4">
          <img src={`${BASE_PATH}/img/mekka-logo.svg`} alt="Mekka" className="h-8 w-8" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-medium text-foreground">Under Maintenance</h1>
          <p className="text-foreground-light max-w-xs mx-auto">
            We are currently improving our services. The dashboard will be back online shortly.
          </p>
        </div>
        <p className="text-sm text-foreground-lighter max-w-xs mx-auto">
          Contact your administrator if you need support while the dashboard is inaccessible.
        </p>
        <div className="flex flex-col items-center gap-2 mt-4">
          <p className="text-sm text-foreground-lighter">
            Reload the page to check if the maintenance window has ended
          </p>
          <Button onClick={() => window.location.reload()} variant="primary" icon={<RefreshCw />}>
            Reload
          </Button>
        </div>
      </div>
    </>
  )
}

MaintenancePage.getLayout = (page) => (
  <div
    className={cn(
      'flex h-full min-h-screen bg-studio',
      'w-full flex-col place-items-center',
      'items-center justify-center gap-8 px-5'
    )}
  >
    {page}
  </div>
)

export default MaintenancePage
