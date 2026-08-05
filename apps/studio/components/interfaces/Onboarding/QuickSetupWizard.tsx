import {
  createStudioOnboardingClient,
  isStudioDomainError,
  type StudioOnboarding,
  type StudioOnboardingClient,
  type StudioOnboardingModule,
  type StudioOnboardingTemplate,
} from '@mekka/studio-domain-sdk'
import Link from 'next/link'
import { useState } from 'react'
import { Button } from 'ui'

const moduleOptions: ReadonlyArray<Readonly<{ value: StudioOnboardingModule; label: string }>> = [
  { value: 'auth', label: 'Auth' },
  { value: 'storage', label: 'Storage' },
  { value: 'realtime', label: 'Realtime' },
  { value: 'functions', label: 'Functions' },
]

const templates: ReadonlyArray<Readonly<{ value: StudioOnboardingTemplate; label: string }>> = [
  { value: 'empty', label: 'Empty' },
  { value: 'saas', label: 'SaaS' },
  { value: 'marketplace', label: 'Marketplace' },
  { value: 'chat', label: 'Chat' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'import', label: 'Import' },
]

const defaultClient = createStudioOnboardingClient({ baseUrl: '/api/platform' })

export const QuickSetupWizard = ({ client = defaultClient }: { client?: StudioOnboardingClient }) => {
  const [organizationName, setOrganizationName] = useState('')
  const [projectName, setProjectName] = useState('')
  const [region, setRegion] = useState<'us-east-1' | 'us-west-2' | 'eu-central-1'>('us-east-1')
  const [template, setTemplate] = useState<StudioOnboardingTemplate>('empty')
  const [enabledModules, setEnabledModules] = useState<readonly StudioOnboardingModule[]>(['auth'])
  const [result, setResult] = useState<StudioOnboarding>()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string>()

  const canSubmit = organizationName.trim().length >= 3 && projectName.trim().length >= 3

  const handleSubmit = async () => {
    if (!canSubmit || isSubmitting) return
    setIsSubmitting(true)
    setError(undefined)
    try {
      const onboarding = await client.create(
        { organizationName, projectName, region, template, enabledModules },
        crypto.randomUUID().replaceAll('-', ''),
      )
      setResult(onboarding)
    } catch (cause) {
      setError(
        isStudioDomainError(cause)
          ? cause.message
          : 'Unable to start provisioning. Your project has not been made available.',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleRetry = async () => {
    if (result === undefined || isSubmitting) return
    setIsSubmitting(true)
    setError(undefined)
    try {
      setResult(await client.retry(result.id, crypto.randomUUID().replaceAll('-', '')))
    } catch (cause) {
      setError(isStudioDomainError(cause) ? cause.message : 'Provisioning retry failed safely.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 px-4 py-12">
      <div className="space-y-2">
        <p className="text-foreground-lighter text-sm">Mekka Studio</p>
        <h1 className="text-3xl font-semibold">Create your backend</h1>
        <p className="text-foreground-light">
          Safe defaults create an isolated production project. You can change advanced settings after
          provisioning.
        </p>
      </div>

      <section className="space-y-5 rounded border border-default bg-surface-200 p-6" aria-label="Quick setup">
        <label className="block space-y-2">
          <span className="text-sm font-medium">Organization name</span>
          <input className="input w-full" value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} />
        </label>
        <label className="block space-y-2">
          <span className="text-sm font-medium">Project name</span>
          <input className="input w-full" value={projectName} onChange={(event) => setProjectName(event.target.value)} />
        </label>
        <label className="block space-y-2">
          <span className="text-sm font-medium">Region</span>
          <select className="input w-full" value={region} onChange={(event) => setRegion(event.target.value as typeof region)}>
            <option value="us-east-1">US East</option>
            <option value="us-west-2">US West</option>
            <option value="eu-central-1">Central EU</option>
          </select>
        </label>
        <label className="block space-y-2">
          <span className="text-sm font-medium">Starter template</span>
          <select className="input w-full" value={template} onChange={(event) => setTemplate(event.target.value as StudioOnboardingTemplate)}>
            {templates.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Enabled modules</legend>
          {moduleOptions.map((option) => (
            <label className="mr-4 inline-flex items-center gap-2 text-sm" key={option.value}>
              <input
                type="checkbox"
                checked={enabledModules.includes(option.value)}
                onChange={(event) => setEnabledModules(event.target.checked ? [...enabledModules, option.value] : enabledModules.filter((module) => module !== option.value))}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <Button type="button" disabled={!canSubmit || isSubmitting} onClick={handleSubmit}>
          {isSubmitting ? 'Provisioning...' : 'Create project'}
        </Button>
      </section>

      {error && <p role="alert" className="text-destructive">{error}</p>}
      {result && <ProvisioningResult result={result} isSubmitting={isSubmitting} onRetry={handleRetry} />}
    </main>
  )
}

function ProvisioningResult({ result, isSubmitting, onRetry }: Readonly<{ result: StudioOnboarding; isSubmitting: boolean; onRetry: () => void }>) {
  if (result.status === 'failed') {
    return (
      <section className="space-y-3 rounded border border-destructive bg-surface-200 p-6" aria-live="polite">
        <h2 className="font-semibold">Provisioning failed safely</h2>
        <p className="text-sm text-foreground-light">The incomplete project was cleaned up and is not reachable.</p>
        <Button type="button" onClick={onRetry} disabled={isSubmitting}>Retry provisioning</Button>
      </section>
    )
  }
  if (result.status === 'provisioning') {
    return <p aria-live="polite">Provisioning progress: {result.phase}</p>
  }
  const connection = result.connection
  if (connection === null) return null
  return (
    <section className="space-y-4 rounded border border-default bg-surface-200 p-6" aria-live="polite">
      <div>
        <h2 className="font-semibold">Your API is ready</h2>
        <p className="text-sm text-foreground-light">Connection health check passed.</p>
      </div>
      <pre className="overflow-auto rounded bg-surface-100 p-3 text-xs">{`MEKKA_URL=${connection.apiUrl}\nMEKKA_PUBLISHABLE_KEY=${connection.publishableKey}`}</pre>
      <p className="text-xs text-foreground-light">Only the publishable key is shown here. Server secrets remain in the server-side secret store.</p>
      <Button asChild type="button">
        <Link href={`/project/${result.projectId}/editor`}>Open advanced settings</Link>
      </Button>
    </section>
  )
}
