import type {
  StudioAuthProviderSetting,
  StudioAuthTemplateSetting,
  StudioAuthUser,
} from '@mekka/studio-domain-sdk'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'common'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { Button, Checkbox, Form, FormControl, FormField, Input, TextArea } from 'ui'
import { ConfirmationModal } from 'ui-patterns/Dialogs/ConfirmationModal'
import { TextConfirmModal } from 'ui-patterns/Dialogs/TextConfirmModal'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { PageContainer } from 'ui-patterns/PageContainer'
import { z } from 'zod'

import { createProjectStudioAuthClient } from '@/data/studio-domain/auth-client'

const authKeys = {
  users: (projectRef: string) => ['mekka-auth', projectRef, 'users'] as const,
  settings: (projectRef: string) => ['mekka-auth', projectRef, 'settings'] as const,
}

const providerSchema = z.object({
  enabled: z.boolean(),
  clientId: z.string().max(4096).optional(),
  clientSecret: z.string().max(4096).optional(),
})
const redirectsSchema = z.object({
  urls: z.string().superRefine((value, context) => {
    const urls = value.split('\n').map((url) => url.trim()).filter(Boolean)
    if (urls.length > 32 || new Set(urls).size !== urls.length) {
      context.addIssue({ code: 'custom', message: 'Use at most 32 unique redirect URLs.' })
    }
    for (const value of urls) {
      try {
        const url = new URL(value)
        if (
          url.protocol !== 'https:' ||
          url.username !== '' ||
          url.password !== '' ||
          url.hash !== '' ||
          url.toString() !== value
        ) {
          throw new Error('Invalid redirect URL')
        }
      } catch {
        context.addIssue({ code: 'custom', message: `${value} is not a canonical HTTPS URL.` })
      }
    }
  }),
})
const templateSchema = z.object({
  subject: z.string().trim().min(1).max(160).refine((value) => !/[\r\n]/.test(value)),
  text: z.string().min(1).max(16_384).refine((value) => value.includes('{{ code }}'), {
    message: 'Template must include {{ code }}.',
  }),
})

export function MekkaAuthUsers() {
  const { ref } = useParams()
  const projectRef = ref ?? ''
  const queryClient = useQueryClient()
  const [selectedUser, setSelectedUser] = useState<StudioAuthUser | null>(null)
  const [userToDelete, setUserToDelete] = useState<StudioAuthUser | null>(null)
  const users = useQuery({
    queryKey: authKeys.users(projectRef),
    queryFn: () => createProjectStudioAuthClient(projectRef).listUsers(),
    enabled: projectRef.length > 0,
  })
  const revoke = useMutation({
    mutationFn: (user: StudioAuthUser) =>
      createProjectStudioAuthClient(projectRef).revokeUser(
        user.id,
        user.id,
        createIdempotencyKey('revoke')
      ),
    onSuccess: async () => {
      setSelectedUser(null)
      await queryClient.invalidateQueries({ queryKey: authKeys.users(projectRef) })
      toast.success('User sessions and refresh tokens revoked')
    },
    onError: () => toast.error('Failed to revoke user sessions'),
  })
  const remove = useMutation({
    mutationFn: (user: StudioAuthUser) =>
      createProjectStudioAuthClient(projectRef).deleteUser(
        user.id,
        user.id,
        createIdempotencyKey('delete')
      ),
    onSuccess: async () => {
      setUserToDelete(null)
      await queryClient.invalidateQueries({ queryKey: authKeys.users(projectRef) })
      toast.success('Auth user deleted')
    },
    onError: () => toast.error('Failed to delete Auth user'),
  })

  return (
    <PageContainer size="default" className="py-6">
      <SectionHeader
        title="Auth users"
        description="Project-isolated identities and active session counts. Email addresses are shown only to Auth administrators."
      />
      {users.isLoading && <StatusPanel>Loading users...</StatusPanel>}
      {users.isError && <StatusPanel tone="danger">Unable to load Auth users.</StatusPanel>}
      {users.data?.users.length === 0 && <StatusPanel>No users in this project.</StatusPanel>}
      {users.data && users.data.users.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-surface-100">
          <table className="w-full text-sm">
            <thead className="border-b bg-surface-200 text-left text-foreground-light">
              <tr>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Verified</th>
                <th className="px-4 py-3 font-medium">Sessions</th>
                <th className="px-4 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((user) => (
                <tr className="border-b last:border-b-0" key={user.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{user.name}</div>
                    <div className="text-foreground-light">{user.email}</div>
                  </td>
                  <td className="px-4 py-3">{user.emailVerified ? 'Yes' : 'No'}</td>
                  <td className="px-4 py-3">{user.sessionCount}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="default" onClick={() => setSelectedUser(user)}>
                        Revoke sessions
                      </Button>
                      <Button type="button" variant="danger" onClick={() => setUserToDelete(user)}>
                        Delete user
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AuthUserRevokeConfirmation
        user={selectedUser}
        isLoading={revoke.isPending}
        onCancel={() => setSelectedUser(null)}
        onConfirm={() => selectedUser && revoke.mutate(selectedUser)}
      />
      <AuthUserDeleteConfirmation
        user={userToDelete}
        isLoading={remove.isPending}
        onCancel={() => setUserToDelete(null)}
        onConfirm={() => userToDelete && remove.mutate(userToDelete)}
      />
    </PageContainer>
  )
}

export function AuthUserRevokeConfirmation({
  user,
  isLoading,
  onCancel,
  onConfirm,
}: Readonly<{
  user: StudioAuthUser | null
  isLoading: boolean
  onCancel: () => void
  onConfirm: () => void
}>) {
  return (
    <ConfirmationModal
      visible={user !== null}
      title="Revoke all user sessions?"
      description={user ? `This immediately signs ${user.email} out of this project.` : undefined}
      confirmLabel="Revoke sessions"
      confirmLabelLoading="Revoking..."
      loading={isLoading}
      variant="destructive"
      alert={{
        title: 'Credential revocation',
        description: 'All active sessions and refresh-token chains for this user will be revoked.',
      }}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}

export function AuthUserDeleteConfirmation({
  user,
  isLoading,
  onCancel,
  onConfirm,
}: Readonly<{
  user: StudioAuthUser | null
  isLoading: boolean
  onCancel: () => void
  onConfirm: () => void
}>) {
  return (
    <TextConfirmModal
      visible={user !== null}
      title="Permanently delete Auth user?"
      loading={isLoading}
      confirmPlaceholder="Type the user ID"
      confirmString={user?.id ?? ''}
      confirmLabel="Delete user"
      variant="destructive"
      alert={{
        title: 'This action cannot be undone',
        description:
          'The user, linked accounts, sessions, and refresh-token chains will be permanently removed.',
      }}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {user && (
        <p className="text-sm">
          Delete <strong>{user.email}</strong> from this project.
        </p>
      )}
    </TextConfirmModal>
  )
}

export function MekkaAuthProviders() {
  const { ref } = useParams()
  const projectRef = ref ?? ''
  const settings = useAuthSettings(projectRef)
  return (
    <PageContainer size="default" className="space-y-5 py-6">
      <SectionHeader
        title="Sign-in providers"
        description="Only Google and GitHub OAuth are supported. Saved credentials are write-only and never returned to Studio."
      />
      {settings.isLoading && <StatusPanel>Loading provider settings...</StatusPanel>}
      {settings.isError && <StatusPanel tone="danger">Unable to load provider settings.</StatusPanel>}
      {settings.data?.providers.map((provider) => (
        <ProviderEditor key={provider.provider} projectRef={projectRef} setting={provider} />
      ))}
    </PageContainer>
  )
}

function ProviderEditor({
  projectRef,
  setting,
}: Readonly<{ projectRef: string; setting: StudioAuthProviderSetting }>) {
  const queryClient = useQueryClient()
  const form = useForm<z.infer<typeof providerSchema>>({
    resolver: zodResolver(providerSchema),
    defaultValues: { enabled: setting.enabled, clientId: '', clientSecret: '' },
  })
  const update = useMutation({
    mutationFn: (values: z.infer<typeof providerSchema>) =>
      createProjectStudioAuthClient(projectRef).updateProvider(
        setting.provider,
        {
          enabled: values.enabled,
          ...(values.clientId ? { clientId: values.clientId } : {}),
          ...(values.clientSecret ? { clientSecret: values.clientSecret } : {}),
        },
        createIdempotencyKey(`provider-${setting.provider}`)
      ),
    onSuccess: async () => {
      form.reset({ enabled: form.getValues('enabled'), clientId: '', clientSecret: '' })
      await queryClient.invalidateQueries({ queryKey: authKeys.settings(projectRef) })
      toast.success('Provider configuration saved')
    },
    onError: () => toast.error('Failed to update provider configuration'),
  })
  return (
    <Form {...form}>
      <form
        className="rounded-lg border bg-surface-100 p-5"
        onSubmit={form.handleSubmit((values) => update.mutate(values))}
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-medium capitalize">{setting.provider}</h2>
            <p className="text-sm text-foreground-light">
              Client ID: {setting.clientIdConfigured ? 'configured' : 'not configured'}; secret:{' '}
              {setting.clientSecretConfigured ? 'configured' : 'not configured'}
            </p>
          </div>
          <FormField
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <FormControl>
                <div className="flex items-center gap-2 text-sm">
                  <Checkbox
                    aria-label={`Enable ${setting.provider}`}
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <span>Enabled</span>
                </div>
              </FormControl>
            )}
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            control={form.control}
            name="clientId"
            render={({ field }) => (
              <FormItemLayout label="New client ID" description="Leave blank to keep the saved value.">
                <FormControl><Input {...field} autoComplete="off" /></FormControl>
              </FormItemLayout>
            )}
          />
          <FormField
            control={form.control}
            name="clientSecret"
            render={({ field }) => (
              <FormItemLayout label="New client secret" description="The saved value cannot be read back.">
                <FormControl><Input {...field} type="password" autoComplete="new-password" /></FormControl>
              </FormItemLayout>
            )}
          />
        </div>
        <div className="mt-5 flex justify-end">
          <Button type="submit" loading={update.isPending}>Save provider</Button>
        </div>
      </form>
    </Form>
  )
}

export function MekkaAuthRedirects() {
  const { ref } = useParams()
  const projectRef = ref ?? ''
  const settings = useAuthSettings(projectRef)
  if (settings.isLoading) return <PageContainer size="default" className="py-6"><StatusPanel>Loading redirect URLs...</StatusPanel></PageContainer>
  if (settings.isError || !settings.data) return <PageContainer size="default" className="py-6"><StatusPanel tone="danger">Unable to load redirect URLs.</StatusPanel></PageContainer>
  return <RedirectEditor key={settings.data.redirectUrls.join('\n')} projectRef={projectRef} urls={settings.data.redirectUrls} />
}

function RedirectEditor({ projectRef, urls }: Readonly<{ projectRef: string; urls: readonly string[] }>) {
  const queryClient = useQueryClient()
  const form = useForm<z.infer<typeof redirectsSchema>>({
    resolver: zodResolver(redirectsSchema),
    defaultValues: { urls: urls.join('\n') },
  })
  const update = useMutation({
    mutationFn: (values: z.infer<typeof redirectsSchema>) =>
      createProjectStudioAuthClient(projectRef).updateRedirectUrls(
        values.urls.split('\n').map((url) => url.trim()).filter(Boolean),
        createIdempotencyKey('redirects')
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: authKeys.settings(projectRef) })
      toast.success('Redirect allowlist saved')
    },
    onError: () => toast.error('Failed to update redirect allowlist'),
  })
  return (
    <PageContainer size="default" className="py-6">
      <SectionHeader title="Redirect allowlist" description="Exact canonical HTTPS URLs only. Wildcards, fragments and embedded credentials are rejected." />
      <Form {...form}>
        <form className="rounded-lg border bg-surface-100 p-5" onSubmit={form.handleSubmit((values) => update.mutate(values))}>
          <FormField control={form.control} name="urls" render={({ field }) => (
            <FormItemLayout label="Allowed redirect URLs" description="Enter one URL per line.">
              <FormControl><TextArea {...field} rows={10} className="font-mono" /></FormControl>
            </FormItemLayout>
          )} />
          <div className="mt-5 flex justify-end"><Button type="submit" loading={update.isPending}>Save URLs</Button></div>
        </form>
      </Form>
    </PageContainer>
  )
}

export function MekkaAuthTemplates() {
  const { ref } = useParams()
  const projectRef = ref ?? ''
  const settings = useAuthSettings(projectRef)
  return (
    <PageContainer size="default" className="space-y-5 py-6">
      <SectionHeader title="Email templates" description="Plain-text verification and password reset templates. The required {{ code }} variable is validated before saving." />
      {settings.isLoading && <StatusPanel>Loading templates...</StatusPanel>}
      {settings.isError && <StatusPanel tone="danger">Unable to load templates.</StatusPanel>}
      {settings.data?.templates.map((template) => <TemplateEditor key={template.template} projectRef={projectRef} template={template} />)}
    </PageContainer>
  )
}

function TemplateEditor({ projectRef, template }: Readonly<{ projectRef: string; template: StudioAuthTemplateSetting }>) {
  const queryClient = useQueryClient()
  const form = useForm<z.infer<typeof templateSchema>>({
    resolver: zodResolver(templateSchema),
    defaultValues: { subject: template.subject, text: template.text },
  })
  const update = useMutation({
    mutationFn: (values: z.infer<typeof templateSchema>) =>
      createProjectStudioAuthClient(projectRef).updateTemplate(template.template, values, createIdempotencyKey(`template-${template.template}`)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: authKeys.settings(projectRef) })
      toast.success('Email template saved')
    },
    onError: () => toast.error('Failed to update email template'),
  })
  return (
    <Form {...form}>
      <form className="rounded-lg border bg-surface-100 p-5" onSubmit={form.handleSubmit((values) => update.mutate(values))}>
        <h2 className="mb-4 font-medium">{template.template === 'email-verification' ? 'Email verification' : 'Password reset'}</h2>
        <div className="space-y-4">
          <FormField control={form.control} name="subject" render={({ field }) => (
            <FormItemLayout label="Subject"><FormControl><Input {...field} /></FormControl></FormItemLayout>
          )} />
          <FormField control={form.control} name="text" render={({ field }) => (
            <FormItemLayout label="Plain-text body" description="Use {{ code }} where the one-time code should appear.">
              <FormControl><TextArea {...field} rows={7} className="font-mono" /></FormControl>
            </FormItemLayout>
          )} />
        </div>
        <div className="mt-5 flex justify-end"><Button type="submit" loading={update.isPending}>Save template</Button></div>
      </form>
    </Form>
  )
}

function useAuthSettings(projectRef: string) {
  return useQuery({
    queryKey: authKeys.settings(projectRef),
    queryFn: () => createProjectStudioAuthClient(projectRef).getSettings(),
    enabled: projectRef.length > 0,
  })
}

function SectionHeader({ title, description }: Readonly<{ title: string; description: string }>) {
  return <header className="mb-5"><h1 className="text-xl font-medium">{title}</h1><p className="mt-1 max-w-3xl text-sm text-foreground-light">{description}</p></header>
}

function StatusPanel({ children, tone = 'default' }: Readonly<{ children: React.ReactNode; tone?: 'default' | 'danger' }>) {
  return <div role={tone === 'danger' ? 'alert' : 'status'} className={`rounded-lg border p-5 text-sm ${tone === 'danger' ? 'border-destructive-400 bg-destructive-200 text-destructive-600' : 'bg-surface-100 text-foreground-light'}`}>{children}</div>
}

function createIdempotencyKey(scope: string): string {
  return `${scope}-${crypto.randomUUID()}`
}
