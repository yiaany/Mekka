import { useQueryClient } from '@tanstack/react-query'
import { useParams } from 'common'
import { useState } from 'react'
import { Button, copyToClipboard, Input, Label } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { PageContainer } from 'ui-patterns/PageContainer'

const organizationId = process.env.NEXT_PUBLIC_STUDIO_ORGANIZATION_ID ?? 'org-local'
const environmentId = process.env.NEXT_PUBLIC_STUDIO_ENVIRONMENT_ID ?? 'env-local'
const branchId = process.env.NEXT_PUBLIC_STUDIO_BRANCH_ID ?? 'branch-main'
const generation = process.env.NEXT_PUBLIC_STUDIO_GENERATION ?? '1'

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
  const [mcpToken, setMcpToken] = useState<string | null>(null)
  const authBase = `/auth/${organizationId}/${ref}/${environmentId}/${branchId}/${generation}`

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
          {mcpToken !== null && (
            <Button size="tiny" variant="default" onClick={() => copyToClipboard(mcpToken)}>
              Copy temporary Agent Access token
            </Button>
          )}
        </Admonition>
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
                const agentResponse = await fetch(
                  `/api/platform/project-auth/${ref}/agent-token`,
                  {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ accessToken: body.accessToken }),
                  }
                )
                const agentBody: unknown = await agentResponse.json().catch(() => ({}))
                if (!agentResponse.ok || !hasAgentToken(agentBody)) {
                  throw new Error('Temporary Agent Access token was not issued.')
                }
                setIsSignedIn(true)
                setMcpToken(agentBody.token)
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

function hasAgentToken(payload: unknown): payload is { token: string; expiresAt: number } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'token' in payload &&
    typeof payload.token === 'string' &&
    'expiresAt' in payload &&
    typeof payload.expiresAt === 'number'
  )
}
