import Head from 'next/head'

import { QuickSetupWizard } from '@/components/interfaces/Onboarding/QuickSetupWizard'
import { buildStudioPageTitle } from '@/lib/page-title'

export default function OnboardingPage() {
  return (
    <>
      <Head><title>{buildStudioPageTitle({ section: 'Quick Setup', brand: 'Mekka' })}</title></Head>
      <QuickSetupWizard />
    </>
  )
}
