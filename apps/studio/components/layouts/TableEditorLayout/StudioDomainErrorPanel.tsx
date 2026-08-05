import { isStudioDomainError } from '@mekka/studio-domain-sdk'

export function StudioDomainErrorPanel({ error }: { error: unknown }) {
  if (!isStudioDomainError(error)) return null

  return (
    <div className="mx-4 mt-3 rounded-md border border-warning-500/30 bg-warning-200 p-3" role="alert">
      <p className="text-sm font-medium">Failed to load tables</p>
      <p className="mt-1 text-xs text-foreground-muted">{error.message}</p>
      <p className="mt-2 text-xs text-foreground-muted">Reference: {error.correlationId}</p>
    </div>
  )
}
