import { useQueryClient } from '@tanstack/react-query'
import { useParams } from 'common'
import { useEffect, useState } from 'react'
import { Button, copyToClipboard, Input, Label } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { PageContainer } from 'ui-patterns/PageContainer'

const organizationId = process.env.NEXT_PUBLIC_STUDIO_ORGANIZATION_ID ?? 'org-local'
const environmentId = process.env.NEXT_PUBLIC_STUDIO_ENVIRONMENT_ID ?? 'env-local'
const branchId = process.env.NEXT_PUBLIC_STUDIO_BRANCH_ID ?? 'branch-main'
const generation = process.env.NEXT_PUBLIC_STUDIO_GENERATION ?? '1'
const applicationAccessTokenStoragePrefix = 'mekka:application-access-token'

export function MekkaAuthRegister() {
  const { ref = 'local' } = useParams()
  const queryClient = useQueryClient()
  const [name, setName] = useState('Member')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [message, setMessage] = useState('Create an application user and verify their email.')
  const [isPending, setIsPending] = useState(false)
  const [isSignedIn, setIsSignedIn] = useState(false)
  const [applicationAccessToken, setApplicationAccessToken] = useState<string | null>(null)
  const [mcpToken, setMcpToken] = useState<string | null>(null)
  const [mcpTokenExpiresAt, setMcpTokenExpiresAt] = useState<number | null>(null)
  const [mcpWriteBranchId, setMcpWriteBranchId] = useState<string | null>(null)
  const [allowMcpWrite, setAllowMcpWrite] = useState(false)
  const [approvals, setApprovals] = useState<McpApproval[]>([])
  const authBase = `/auth/${organizationId}/${ref}/${environmentId}/${branchId}/${generation}`
  const applicationAccessTokenStorageKey = [
    applicationAccessTokenStoragePrefix,
    organizationId,
    ref,
    environmentId,
    branchId,
    generation,
  ].join(':')
  const blockingApproval = approvals.find(isUnconsumedWriteApproval)

  const run = async (operation: () => Promise<void>) => {
    setIsPending(true)
    try {
      await operation()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Auth request failed.')
    } finally {
      setIsPending(false)
    }
  }

  const post = async (path: string, body: Record<string, string>) => {
    const response = await fetch(`${authBase}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload: unknown = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(readMessage(payload))
    return payload
  }

  const issueAgentToken = async () => {
    if (applicationAccessToken === null) throw new Error('Sign in before issuing Agent Access.')
    if (allowMcpWrite && blockingApproval !== undefined) {
      throw new Error('Resolve or consume the existing write approval before issuing another write token.')
    }
    const response = await fetch(`/api/platform/project-auth/${ref}/agent-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accessToken: applicationAccessToken,
        mode: allowMcpWrite ? 'write' : 'read',
      }),
    })
    const payload: unknown = await response.json().catch(() => ({}))
    if (response.status === 401 || response.status === 403) {
      clearApplicationSession(applicationAccessTokenStorageKey)
      setApplicationAccessToken(null)
      setIsSignedIn(false)
      setMcpToken(null)
      setMcpTokenExpiresAt(null)
      setMcpWriteBranchId(null)
      throw new Error('Your application session is no longer valid. Sign in again.')
    }
    if (!response.ok || !hasAgentToken(payload)) throw new Error(readAgentTokenError(payload))
    setMcpToken(payload.token)
    setMcpTokenExpiresAt(payload.expiresAt)
    setMcpWriteBranchId(payload.mode === 'write' ? payload.tenant.branchId : null)
    setMessage(
      payload.mode === 'write'
        ? 'Read-write Agent Access issued for an isolated preview branch.'
        : 'Read-only Agent Access issued.'
    )
  }

  const refreshApprovals = async () => {
    if (applicationAccessToken === null) throw new Error('Sign in before reviewing approvals.')
    const response = await fetch('/api/platform/mcp/approvals', {
      cache: 'no-store',
      headers: { 'x-mekka-application-authorization': `Bearer ${applicationAccessToken}` },
    })
    const payload: unknown = await response.json().catch(() => ({}))
    if (!response.ok || !hasApprovals(payload)) throw new Error('MCP approvals are unavailable.')
    setApprovals(payload.approvals)
  }

  useEffect(() => {
    const storedToken = readFreshApplicationAccessToken(applicationAccessTokenStorageKey)
    setApplicationAccessToken(storedToken)
    setIsSignedIn(storedToken !== null)
    setMcpToken(null)
    setMcpTokenExpiresAt(null)
    setMcpWriteBranchId(null)
    setApprovals([])
  }, [applicationAccessTokenStorageKey])

  useEffect(() => {
    if (!isSignedIn) return
    void refreshApprovals().catch(() => setMessage('MCP approvals are unavailable.'))
  }, [isSignedIn, ref])

  useEffect(() => {
    if (mcpTokenExpiresAt === null) return
    const timeout = window.setTimeout(
      () => {
        setMcpToken(null)
        setMcpTokenExpiresAt(null)
        setMcpWriteBranchId(null)
      },
      Math.max(0, mcpTokenExpiresAt - Date.now())
    )
    return () => window.clearTimeout(timeout)
  }, [mcpTokenExpiresAt])

  const decideApproval = async (approvalId: string, state: 'approved' | 'rejected') => {
    if (applicationAccessToken === null) throw new Error('Sign in before deciding approvals.')
    const response = await fetch(`/api/platform/mcp/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'PATCH',
      headers: {
        'x-mekka-application-authorization': `Bearer ${applicationAccessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ state }),
    })
    const payload: unknown = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error('MCP approval could not be updated.')
    if (state === 'approved') {
      const executionToken = readExecutionToken(payload)
      if (executionToken === null) throw new Error('MCP execution step-up was not issued.')
      await copyToClipboard(executionToken)
      setMessage('Exact SQL approved. One-time execution token copied to the clipboard.')
    }
    await refreshApprovals()
  }

  return (
    <PageContainer size="default" className="space-y-6 py-6">
      <div className="max-w-2xl space-y-2">
        <p className="text-foreground-muted text-xs font-medium uppercase tracking-wider">
          Application authentication
        </p>
        <h1 className="text-2xl">Register and verify a user</h1>
        <p className="text-foreground-light">{message}</p>
      </div>

      {isSignedIn && (
        <Admonition
          type="default"
          title="Signed in"
          description="The application session is active in this browser. Tokens are intentionally not rendered into the page."
        >
          <div className="grid gap-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={allowMcpWrite}
                onChange={(event) => setAllowMcpWrite(event.target.checked)}
              />
              <span>
                <strong>Enable read-write MCP for this token.</strong> Mutations run only on an
                isolated preview branch. Production promotion still requires reviewing and
                approving the exact SQL below.
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="tiny"
                variant={allowMcpWrite ? 'warning' : 'default'}
                disabled={isPending || (allowMcpWrite && blockingApproval !== undefined)}
                onClick={() => void run(issueAgentToken)}
              >
                Generate {allowMcpWrite ? 'read-write' : 'read-only'} token
              </Button>
              {mcpToken !== null && (
                <Button size="tiny" variant="default" onClick={() => copyToClipboard(mcpToken)}>
                  Copy temporary Agent Access token
                </Button>
              )}
              <Button size="tiny" variant="default" onClick={() => void run(refreshApprovals)}>
                Refresh MCP approvals
              </Button>
            </div>
          </div>
        </Admonition>
      )}

      {isSignedIn && blockingApproval !== undefined && (
        <Admonition
          type="warning"
          title="An isolated preview already has an active write grant"
          description="Another write token would create a different isolated preview. Resolve or consume the existing approval before issuing a new write token. Read-only Agent Access remains available."
        >
          <p className="text-sm">
            Approval preview: <code>{blockingApproval.tenant.branchId}</code>.{' '}
            {mcpWriteBranchId === null
              ? 'The current write token preview is not known in this page session.'
              : mcpWriteBranchId === blockingApproval.tenant.branchId
                ? 'This approval belongs to the current write token preview.'
                : 'This approval belongs to a different preview than the current write token.'}
          </p>
        </Admonition>
      )}

      {isSignedIn && approvals.length > 0 && (
        <section className="max-w-4xl space-y-3 rounded-lg border bg-surface-100 p-5">
          <div>
            <p className="text-foreground-muted text-xs font-medium uppercase tracking-wider">
              Production gate
            </p>
            <h2 className="text-lg">MCP migration approvals</h2>
          </div>
          {approvals.map((approval) => (
            <article key={approval.approvalId} className="space-y-3 rounded-md border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-mono text-xs text-foreground-muted">{approval.approvalId}</p>
                  <p className="text-sm">
                    {approval.destructive ? 'Destructive schema change' : 'Schema change'} ·{' '}
                    {approval.state}
                  </p>
                  <p className="text-sm text-foreground-light">
                    Preview branch <code>{approval.tenant.branchId}</code> · Proposal{' '}
                    <code>{approval.proposalId}</code>
                  </p>
                </div>
                {approval.state === 'pending' && (
                  <div className="flex gap-2">
                    <Button
                      size="tiny"
                      variant="default"
                      onClick={() => void run(() => decideApproval(approval.approvalId, 'rejected'))}
                    >
                      Reject
                    </Button>
                    <Button
                      size="tiny"
                      variant="warning"
                      onClick={() => void run(() => decideApproval(approval.approvalId, 'approved'))}
                    >
                      Approve exact SQL
                    </Button>
                  </div>
                )}
              </div>
              <pre className="max-h-64 overflow-auto rounded-md bg-surface-200 p-3 text-xs">
                <code>{approval.sql}</code>
              </pre>
            </article>
          ))}
        </section>
      )}

      <div className="grid max-w-4xl gap-4 lg:grid-cols-3">
        <AuthStep number="01" title="Create user">
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 12 characters"
            />
          </Field>
          <Button
            disabled={isPending || !email || password.length < 12}
            onClick={() =>
              void run(async () => {
                await post('/sign-up/email', { name, email, password })
                const response = await fetch(
                  `/api/platform/project-auth/${ref}/verification-code?email=${encodeURIComponent(email)}`
                )
                const body: unknown = await response.json().catch(() => ({}))
                const localCode = readCode(body)
                if (response.ok && localCode !== null) {
                  setOtp(localCode)
                  setMessage('User created. Local development code was filled in automatically.')
                } else {
                  setMessage('User created. Check the inbox for the six-digit verification code.')
                }
                await queryClient.invalidateQueries({ queryKey: ['mekka-auth', ref, 'users'] })
              })
            }
          >
            Register user
          </Button>
        </AuthStep>

        <AuthStep number="02" title="Verify email">
          <Field label="Verification code">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otp}
              onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
            />
          </Field>
          <p className="text-sm text-foreground-light">
            Codes expire after five minutes. Local development uses an in-app delivery sink;
            production uses the configured email provider.
          </p>
          <Button
            disabled={isPending || otp.length !== 6}
            onClick={() =>
              void run(async () => {
                await post('/email-otp/verify-email', { email, otp })
                setMessage('Email verified. The user can now sign in.')
                await queryClient.invalidateQueries({ queryKey: ['mekka-auth', ref, 'users'] })
              })
            }
          >
            Verify email
          </Button>
        </AuthStep>

        <AuthStep number="03" title="Test sign-in">
          <p className="text-sm text-foreground-light">
            Sign in with the verified account to confirm the full application auth flow.
          </p>
          <Button
            disabled={isPending || !email || !password}
            onClick={() =>
              void run(async () => {
                const body = await post('/sign-in/email', { email, password })
                if (!hasTokens(body)) throw new Error('Auth tokens were not returned.')
                persistApplicationAccessToken(applicationAccessTokenStorageKey, body.accessToken)
                setIsSignedIn(true)
                setApplicationAccessToken(body.accessToken)
                setMcpToken(null)
                setMcpTokenExpiresAt(null)
                setMcpWriteBranchId(null)
                setMessage('Signed in successfully.')
                await queryClient.invalidateQueries({ queryKey: ['mekka-auth', ref, 'users'] })
              })
            }
          >
            Sign in
          </Button>
        </AuthStep>
      </div>
    </PageContainer>
  )
}

function AuthStep({
  number,
  title,
  children,
}: {
  number: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="flex min-h-72 flex-col gap-4 rounded-lg border bg-surface-100 p-5">
      <div className="flex items-center justify-between border-b pb-3">
        <h2 className="font-medium">{title}</h2>
        <span className="font-mono text-xs text-foreground-muted">{number}</span>
      </div>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <Label>{label}</Label>
      {children}
    </label>
  )
}

function readMessage(payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'message' in payload &&
    typeof payload.message === 'string'
  ) {
    return payload.message
  }
  return 'Auth request failed.'
}

function readCode(payload: unknown): string | null {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'code' in payload &&
    typeof payload.code === 'string'
  ) {
    return payload.code
  }
  return null
}

function hasTokens(payload: unknown): payload is { accessToken: string; refreshToken: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'accessToken' in payload &&
    typeof payload.accessToken === 'string' &&
    'refreshToken' in payload &&
    typeof payload.refreshToken === 'string'
  )
}

function hasAgentToken(payload: unknown): payload is {
  token: string
  expiresAt: number
  mode: 'read' | 'write'
  tenant: { branchId: string }
} {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'token' in payload &&
    typeof payload.token === 'string' &&
    'expiresAt' in payload &&
    typeof payload.expiresAt === 'number' &&
    'mode' in payload &&
    (payload.mode === 'read' || payload.mode === 'write') &&
    'tenant' in payload &&
    typeof payload.tenant === 'object' &&
    payload.tenant !== null &&
    'branchId' in payload.tenant &&
    typeof payload.tenant.branchId === 'string'
  )
}

function readExecutionToken(payload: unknown): string | null {
  return typeof payload === 'object' &&
    payload !== null &&
    'executionToken' in payload &&
    typeof payload.executionToken === 'string'
    ? payload.executionToken
    : null
}

function readAgentTokenError(payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'message' in payload &&
    typeof payload.message === 'string'
  ) {
    return payload.message
  }
  return 'Temporary Agent Access token was not issued.'
}

type McpApproval = Readonly<{
  approvalId: string
  state: 'pending' | 'approved' | 'rejected'
  expiresAt: number
  sql: string
  destructive: boolean
  tenant: Readonly<{
    organizationId: string
    projectId: string
    environmentId: string
    branchId: string
    generation: number
  }>
  proposalId: string
  executionConsumedAt: number | null
}>

function hasApprovals(payload: unknown): payload is { approvals: McpApproval[] } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'approvals' in payload &&
    Array.isArray(payload.approvals) &&
    payload.approvals.every(
      (approval) =>
        typeof approval === 'object' &&
        approval !== null &&
        'approvalId' in approval &&
        typeof approval.approvalId === 'string' &&
        'state' in approval &&
        (approval.state === 'pending' ||
          approval.state === 'approved' ||
          approval.state === 'rejected') &&
        'expiresAt' in approval &&
        typeof approval.expiresAt === 'number' &&
        'sql' in approval &&
        typeof approval.sql === 'string' &&
        'destructive' in approval &&
        typeof approval.destructive === 'boolean' &&
        'tenant' in approval &&
        typeof approval.tenant === 'object' &&
        approval.tenant !== null &&
        'organizationId' in approval.tenant &&
        typeof approval.tenant.organizationId === 'string' &&
        'projectId' in approval.tenant &&
        typeof approval.tenant.projectId === 'string' &&
        'environmentId' in approval.tenant &&
        typeof approval.tenant.environmentId === 'string' &&
        'branchId' in approval.tenant &&
        typeof approval.tenant.branchId === 'string' &&
        'generation' in approval.tenant &&
        typeof approval.tenant.generation === 'number' &&
        'proposalId' in approval &&
        typeof approval.proposalId === 'string' &&
        'executionConsumedAt' in approval &&
        (approval.executionConsumedAt === null || typeof approval.executionConsumedAt === 'number')
    )
  )
}

function isUnconsumedWriteApproval(approval: McpApproval): boolean {
  return (
    (approval.state === 'pending' || approval.state === 'approved') &&
    approval.executionConsumedAt === null
  )
}

function readFreshApplicationAccessToken(storageKey: string): string | null {
  let token: string | null
  try {
    token = window.sessionStorage.getItem(storageKey)
  } catch {
    return null
  }
  if (token === null) return null

  const expiresAt = readJwtExpiresAt(token)
  if (expiresAt === null || expiresAt <= Date.now()) {
    clearApplicationSession(storageKey)
    return null
  }
  return token
}

function persistApplicationAccessToken(storageKey: string, token: string): void {
  try {
    window.sessionStorage.setItem(storageKey, token)
  } catch {
    // Browser storage can be unavailable; the in-memory session still works.
  }
}

function clearApplicationSession(storageKey: string): void {
  try {
    window.sessionStorage.removeItem(storageKey)
  } catch {
    // Treat inaccessible storage as already cleared.
  }
}

function readJwtExpiresAt(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[1] === undefined) return null
  try {
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload: unknown = JSON.parse(window.atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')))
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('exp' in payload) ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp)
    ) {
      return null
    }
    return payload.exp * 1_000
  } catch {
    return null
  }
}
