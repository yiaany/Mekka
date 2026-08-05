import type {
  StudioStorageBucket,
  StudioStorageObject,
  StudioStoragePolicySummary,
  StudioStorageUploadProgress,
} from '@mekka/studio-domain-sdk'
import { StudioDomainError } from '@mekka/studio-domain-sdk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'common'
import { Download, FileUp, FolderOpen, RefreshCw, Shield, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Input } from 'ui'
import { ConfirmationModal } from 'ui-patterns/Dialogs/ConfirmationModal'
import { PageContainer } from 'ui-patterns/PageContainer'

import { createProjectStudioStorageClient } from '@/data/studio-domain/storage-client'

const storageKeys = {
  buckets: (projectRef: string) => ['mekka-storage', projectRef, 'buckets'] as const,
  bucket: (projectRef: string, bucketName: string) =>
    ['mekka-storage', projectRef, 'bucket', bucketName] as const,
  objects: (projectRef: string, bucketName: string, prefix: string) =>
    ['mekka-storage', projectRef, 'objects', bucketName, prefix] as const,
  policy: (projectRef: string, bucketName: string) =>
    ['mekka-storage', projectRef, 'policy', bucketName] as const,
}

export function MekkaStorageBuckets() {
  const { ref } = useParams()
  const projectRef = ref ?? ''
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [search, setSearch] = useState('')
  const buckets = useQuery({
    queryKey: [...storageKeys.buckets(projectRef), search],
    queryFn: () => createProjectStudioStorageClient(projectRef).listBuckets({ search }),
    enabled: projectRef.length > 0,
  })
  const create = useMutation({
    mutationFn: () =>
      createProjectStudioStorageClient(projectRef).createBucket(
        name.trim(),
        createIdempotencyKey('bucket-create')
      ),
    onSuccess: async () => {
      setName('')
      await queryClient.invalidateQueries({ queryKey: storageKeys.buckets(projectRef) })
      toast.success('Private bucket created')
    },
    onError: (error) => toast.error(storageErrorMessage(error, 'Unable to create bucket.')),
  })

  return (
    <PageContainer size="default" className="space-y-6 py-6">
      <section className="rounded-lg border bg-surface-100 p-5">
        <h2 className="font-medium">Create a private bucket</h2>
        <p className="mt-1 text-sm text-foreground-light">
          Files are served through authenticated or short-lived signed downloads. Public delivery,
          transforms and CDN controls are not available.
        </p>
        <form
          className="mt-4 flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <Input
            aria-label="Bucket name"
            value={name}
            onChange={(event) => setName(event.target.value.toLowerCase())}
            placeholder="project-assets"
            autoComplete="off"
          />
          <Button type="submit" loading={create.isPending} disabled={name.trim().length < 3}>
            Create bucket
          </Button>
        </form>
      </section>

      <section>
        <div className="mb-4 flex items-center gap-3">
          <Input
            aria-label="Search buckets"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search buckets"
          />
          <Button
            type="button"
            variant="outline"
            icon={<RefreshCw size={14} />}
            onClick={() => buckets.refetch()}
          >
            Refresh
          </Button>
        </div>
        {buckets.isLoading && <StatusPanel>Loading buckets...</StatusPanel>}
        {buckets.isError && (
          <StatusPanel tone="danger">
            {storageErrorMessage(buckets.error, 'Unable to load buckets.')}
          </StatusPanel>
        )}
        {buckets.data?.length === 0 && <StatusPanel>No buckets match this project.</StatusPanel>}
        {buckets.data && buckets.data.length > 0 && (
          <div className="overflow-hidden rounded-lg border bg-surface-100">
            {buckets.data.map((bucket) => (
              <BucketRow key={bucket.name} projectRef={projectRef} bucket={bucket} />
            ))}
          </div>
        )}
      </section>
    </PageContainer>
  )
}

function BucketRow({
  projectRef,
  bucket,
}: Readonly<{ projectRef: string; bucket: StudioStorageBucket }>) {
  return (
    <Link
      href={`/project/${projectRef}/storage/files/buckets/${encodeURIComponent(bucket.name)}`}
      className="flex items-center justify-between gap-4 border-b px-4 py-4 last:border-b-0 hover:bg-surface-200"
    >
      <span className="flex min-w-0 items-center gap-3">
        <FolderOpen size={18} className="shrink-0 text-foreground-light" />
        <span className="min-w-0">
          <span className="block truncate font-medium">{bucket.name}</span>
          <span className="block text-xs text-foreground-light">Private, signed downloads</span>
        </span>
      </span>
      <span className="text-xs text-foreground-light">
        Updated {new Date(bucket.updatedAt).toLocaleDateString()}
      </span>
    </Link>
  )
}

export function MekkaStorageBucket() {
  const { ref, bucketId } = useParams()
  const projectRef = ref ?? ''
  const bucketName = bucketId ?? ''
  const queryClient = useQueryClient()
  const [prefix, setPrefix] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadIdempotencyKey, setUploadIdempotencyKey] = useState('')
  const [progress, setProgress] = useState<StudioStorageUploadProgress | null>(null)
  const [objectToDelete, setObjectToDelete] = useState<StudioStorageObject | null>(null)
  const [isDeleteBucketOpen, setIsDeleteBucketOpen] = useState(false)
  const bucket = useQuery({
    queryKey: storageKeys.bucket(projectRef, bucketName),
    queryFn: () => createProjectStudioStorageClient(projectRef).getBucket(bucketName),
    enabled: projectRef.length > 0 && bucketName.length > 0,
  })
  const objects = useQuery({
    queryKey: storageKeys.objects(projectRef, bucketName, prefix),
    queryFn: () => createProjectStudioStorageClient(projectRef).listObjects(bucketName, { prefix }),
    enabled: bucket.isSuccess,
  })
  const policy = useQuery({
    queryKey: storageKeys.policy(projectRef, bucketName),
    queryFn: () => createProjectStudioStorageClient(projectRef).getPolicySummary(bucketName),
    enabled: bucket.isSuccess,
  })
  const upload = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error('Select a file')
      const path = joinObjectPath(prefix, selectedFile.name)
      return createProjectStudioStorageClient(projectRef).uploadObject(bucketName, path, selectedFile, {
        idempotencyKey: uploadIdempotencyKey,
        onProgress: setProgress,
      })
    },
    onSuccess: async () => {
      setSelectedFile(null)
      setUploadIdempotencyKey('')
      await queryClient.invalidateQueries({
        queryKey: storageKeys.objects(projectRef, bucketName, prefix),
      })
      toast.success('File uploaded')
    },
    onError: (error) => toast.error(storageErrorMessage(error, 'Unable to upload file.')),
  })
  const deleteObject = useMutation({
    mutationFn: (object: StudioStorageObject) =>
      createProjectStudioStorageClient(projectRef).deleteObject(
        bucketName,
        object.path,
        createIdempotencyKey('object-delete')
      ),
    onSuccess: async () => {
      setObjectToDelete(null)
      await queryClient.invalidateQueries({
        queryKey: storageKeys.objects(projectRef, bucketName, prefix),
      })
      toast.success('File deleted')
    },
    onError: (error) => toast.error(storageErrorMessage(error, 'Unable to delete file.')),
  })
  const deleteBucket = useMutation({
    mutationFn: () =>
      createProjectStudioStorageClient(projectRef).deleteBucket(
        bucketName,
        createIdempotencyKey('bucket-delete')
      ),
    onSuccess: () => {
      window.location.assign(`/project/${projectRef}/storage/files`)
    },
    onError: (error) => toast.error(storageErrorMessage(error, 'Empty the bucket before deleting it.')),
  })

  if (bucket.isLoading) return <PageContainer size="default" className="py-6"><StatusPanel>Loading bucket...</StatusPanel></PageContainer>
  if (bucket.isError) return <PageContainer size="default" className="py-6"><StatusPanel tone="danger">{storageErrorMessage(bucket.error, 'Unable to load bucket.')}</StatusPanel></PageContainer>

  return (
    <PageContainer size="full" className="space-y-5 py-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <Link href={`/project/${projectRef}/storage/files`} className="text-sm text-foreground-light hover:text-foreground">
            Buckets
          </Link>
          <h1 className="mt-1 text-xl font-medium">{bucketName}</h1>
          <p className="mt-1 text-sm text-foreground-light">
            Private bucket. Provider credentials never enter the browser.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild type="button" variant="outline" icon={<Shield size={14} />}>
            <Link href={`/project/${projectRef}/storage/files/policies`}>Policy summary</Link>
          </Button>
          {policy.data?.canDeleteBucket && (
            <Button type="button" variant="danger" onClick={() => setIsDeleteBucketOpen(true)}>
              Delete bucket
            </Button>
          )}
        </div>
      </div>

      {policy.data?.canCreateObjects && (
        <section className="rounded-lg border bg-surface-100 p-5">
        <h2 className="font-medium">Upload file</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <Input
            aria-label="Object prefix"
            value={prefix}
            onChange={(event) => setPrefix(normalizePrefix(event.target.value))}
            placeholder="Optional folder prefix"
          />
          <Input
            aria-label="Choose file"
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              setSelectedFile(file)
              setUploadIdempotencyKey(file ? createIdempotencyKey('object-upload') : '')
              setProgress(null)
            }}
          />
          <Button
            type="button"
            icon={<FileUp size={14} />}
            loading={upload.isPending}
            disabled={!selectedFile || !uploadIdempotencyKey}
            onClick={() => upload.mutate()}
          >
            {upload.isError ? 'Retry upload' : 'Upload'}
          </Button>
        </div>
        {progress && (
          <div className="mt-4" role="status" aria-live="polite">
            <div className="mb-1 flex justify-between text-xs text-foreground-light">
              <span>{progress.state === 'retrying' ? 'Connection interrupted, resuming...' : 'Upload progress'}</span>
              <span>{progress.percentage}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-300">
              <div className="h-full bg-brand-600 transition-[width]" style={{ width: `${progress.percentage}%` }} />
            </div>
          </div>
        )}
        </section>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Files {prefix ? `under ${prefix}` : ''}</h2>
          <Button type="button" variant="outline" size="tiny" onClick={() => objects.refetch()}>
            Refresh
          </Button>
        </div>
        {objects.isLoading && <StatusPanel>Loading files...</StatusPanel>}
        {objects.isError && <StatusPanel tone="danger">{storageErrorMessage(objects.error, 'Unable to list files.')}</StatusPanel>}
        {objects.data?.length === 0 && <StatusPanel>No files in this path.</StatusPanel>}
        {objects.data && objects.data.length > 0 && (
          <div className="overflow-hidden rounded-lg border bg-surface-100">
            {objects.data.map((object) => (
              <StorageObjectRow
                key={object.path}
                object={object}
                onDelete={
                  policy.data?.canDeleteObjects ? () => setObjectToDelete(object) : undefined
                }
                onDownload={
                  policy.data?.canReadObjects
                    ? async () => {
                        try {
                          const download = await createProjectStudioStorageClient(
                            projectRef
                          ).createSignedDownload(bucketName, object.path)
                          window.location.assign(download.signedUrl)
                        } catch (error) {
                          toast.error(
                            storageErrorMessage(error, 'Unable to create download link.')
                          )
                        }
                      }
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </section>

      <ConfirmationModal
        visible={objectToDelete !== null}
        title="Delete file?"
        description={objectToDelete?.path}
        confirmLabel="Delete file"
        confirmLabelLoading="Deleting..."
        loading={deleteObject.isPending}
        variant="destructive"
        onCancel={() => setObjectToDelete(null)}
        onConfirm={() => objectToDelete && deleteObject.mutate(objectToDelete)}
      />
      <ConfirmationModal
        visible={isDeleteBucketOpen}
        title="Delete empty bucket?"
        description="The operation is rejected if metadata or provider objects remain."
        confirmLabel="Delete bucket"
        confirmLabelLoading="Deleting..."
        loading={deleteBucket.isPending}
        variant="destructive"
        onCancel={() => setIsDeleteBucketOpen(false)}
        onConfirm={() => deleteBucket.mutate()}
      />
    </PageContainer>
  )
}

export function StorageObjectRow({
  object,
  onDownload,
  onDelete,
}: Readonly<{
  object: StudioStorageObject
  onDownload?: () => void
  onDelete?: () => void
}>) {
  return (
    <div className="flex items-center justify-between gap-4 border-b px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate font-mono text-sm">{object.path}</div>
        <div className="text-xs text-foreground-light">
          {formatBytes(object.size)} · {object.contentType}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {onDownload && (
          <Button
            type="button"
            variant="outline"
            size="tiny"
            icon={<Download size={13} />}
            onClick={onDownload}
          >
            Download
          </Button>
        )}
        {onDelete && (
          <Button
            type="button"
            variant="danger"
            size="tiny"
            icon={<Trash2 size={13} />}
            onClick={onDelete}
          >
            Delete
          </Button>
        )}
      </div>
    </div>
  )
}

export function MekkaStoragePolicies() {
  const { ref } = useParams()
  const projectRef = ref ?? ''
  const summaries = useQuery({
    queryKey: [...storageKeys.buckets(projectRef), 'policies'],
    queryFn: async () => {
      const client = createProjectStudioStorageClient(projectRef)
      const buckets = await client.listBuckets()
      return Promise.all(buckets.map((bucket) => client.getPolicySummary(bucket.name)))
    },
    enabled: projectRef.length > 0,
  })
  return (
    <PageContainer size="default" className="space-y-5 py-6">
      <header>
        <h1 className="text-xl font-medium">Storage policy summary</h1>
        <p className="mt-1 text-sm text-foreground-light">
          Effective permissions for your current Studio session. Policy editing and PostgreSQL RLS
          controls are intentionally unavailable.
        </p>
      </header>
      {summaries.isLoading && <StatusPanel>Loading policy summaries...</StatusPanel>}
      {summaries.isError && <StatusPanel tone="danger">{storageErrorMessage(summaries.error, 'Unable to load policy summaries.')}</StatusPanel>}
      {summaries.data?.length === 0 && <StatusPanel>No buckets in this project.</StatusPanel>}
      {summaries.data?.map((summary) => (
        <StoragePolicySummaryCard key={summary.bucketName} summary={summary} />
      ))}
    </PageContainer>
  )
}

export function StoragePolicySummaryCard({
  summary,
}: Readonly<{ summary: StudioStoragePolicySummary }>) {
  const permissions = [
    ['List files', summary.canListObjects],
    ['Upload files', summary.canCreateObjects],
    ['Download files', summary.canReadObjects],
    ['Delete files', summary.canDeleteObjects],
    ['Update bucket', summary.canUpdateBucket],
    ['Delete bucket', summary.canDeleteBucket],
  ] as const
  return (
    <section className="rounded-lg border bg-surface-100 p-5">
      <h2 className="font-medium">{summary.bucketName}</h2>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {permissions.map(([label, allowed]) => (
          <div key={label} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
            <span>{label}</span>
            <span className={allowed ? 'text-brand-600' : 'text-foreground-muted'}>
              {allowed ? 'Allowed' : 'Denied'}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

export function StorageUnsupportedControlsNotice() {
  return (
    <StatusPanel>
      Image transforms, advanced CDN settings, S3 credentials, public delivery and provider-specific
      controls are not supported by this Storage runtime.
    </StatusPanel>
  )
}

function StatusPanel({
  children,
  tone = 'default',
}: Readonly<{ children: React.ReactNode; tone?: 'default' | 'danger' }>) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`rounded-lg border p-5 text-sm ${
        tone === 'danger'
          ? 'border-destructive-400 bg-destructive-200 text-destructive-600'
          : 'bg-surface-100 text-foreground-light'
      }`}
    >
      {children}
    </div>
  )
}

function storageErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof StudioDomainError)) return fallback
  if (error.code === 'quota') return 'Storage quota exceeded. Reduce the file size or project usage.'
  if (error.code === 'infrastructure') return 'The storage provider is temporarily unavailable. Retry the operation.'
  if (error.code === 'forbidden') return 'Your Studio session does not have permission for this Storage action.'
  if (error.code === 'conflict') return 'The target already exists or the bucket is not empty.'
  if (error.code === 'validation') return 'The bucket name, file path or file type is not supported.'
  return fallback
}

function normalizePrefix(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
}

function joinObjectPath(prefix: string, fileName: string): string {
  const safeName = fileName.replace(/[/\\]/g, '_')
  return prefix ? `${prefix}/${safeName}` : safeName
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function createIdempotencyKey(scope: string): string {
  return `${scope}-${crypto.randomUUID()}`
}
