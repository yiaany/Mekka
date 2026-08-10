import assert from 'node:assert/strict'
import { test } from 'vitest'

import { toWebHandler } from '@/compat/next/api'
import { handleStorageAdminWebRequest } from '@/lib/storage-admin-web-proxy'
import nextHandler from '@/pages/api/platform/storage-admin/[ref]/[...path]'

const handleRequest = toWebHandler(nextHandler)
const originalBackendUrl = process.env.STUDIO_BACKEND_API_URL
const originalFetch = globalThis.fetch
process.env.STUDIO_BACKEND_API_URL = 'https://gateway.example.test'

const tenantHeaders = {
  authorization: 'Bearer session-token-value',
  'x-mekka-organization-id': 'org-main',
  'x-mekka-project-id': 'project-main',
  'x-mekka-environment-id': 'environment-main',
  'x-mekka-branch-id': 'branch-main',
  'x-mekka-generation': '1',
}

try {
  const csrf = await handleRequest({
    request: new Request(
      'http://studio.local/api/platform/storage-admin/project-main/csrf',
      { headers: tenantHeaders }
    ),
    params: { ref: 'project-main', path: 'csrf' },
  })
  assert.equal(csrf.status, 200)
  const setCookie = csrf.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';', 1)[0]
  const token = (await csrf.json()).token as string
  assert.match(cookie, /^mekka-studio-storage-csrf=/)

  let upstreamRequest: Request | undefined
  globalThis.fetch = async (input, init) => {
    upstreamRequest = new Request(input, init)
    return Response.json(
      { name: 'documents', isPublic: false, createdAt: 1, updatedAt: 1 },
      { status: 201 }
    )
  }
  const created = await handleRequest({
    request: new Request(
      'http://studio.local/api/platform/storage-admin/project-main/buckets',
      {
        method: 'POST',
        headers: {
          ...tenantHeaders,
          cookie,
          'content-type': 'application/json',
          'idempotency-key': 'storage-proxy-create-001',
          'x-mekka-csrf-token': token,
        },
        body: JSON.stringify({ name: 'documents', isPublic: false }),
      }
    ),
    params: { ref: 'project-main', path: 'buckets' },
  })
  assert.equal(created.status, 201)
  assert.equal(upstreamRequest?.url, 'https://gateway.example.test/storage/v1/buckets')
  assert.deepEqual(await upstreamRequest?.json(), { name: 'documents', isPublic: false })

  const binary = Uint8Array.from([0, 255, 1, 254])
  upstreamRequest = undefined
  let upstreamBinary = new Uint8Array()
  globalThis.fetch = async (input, init) => {
    upstreamRequest = new Request(input, init)
    upstreamBinary = new Uint8Array(await upstreamRequest.arrayBuffer())
    return Response.json(
      {
        bucketName: 'documents',
        path: 'binary.bin',
        size: binary.byteLength,
        contentType: 'application/octet-stream',
        checksumSha256: 'a'.repeat(64),
        version: 'object-version-001',
        createdAt: 1,
        updatedAt: 1,
      },
      { status: 201 }
    )
  }
  const uploaded = await handleStorageAdminWebRequest(
    new Request(
      'http://studio.local/api/platform/storage-admin/project-main/object/documents/binary.bin',
      {
        method: 'PUT',
        headers: {
          ...tenantHeaders,
          cookie,
          'content-type': 'application/octet-stream',
          'idempotency-key': 'storage-proxy-upload-001',
          'x-mekka-csrf-token': token,
        },
        body: binary,
      }
    ),
    'project-main',
    'object/documents/binary.bin'
  )
  assert.equal(uploaded.status, 201)
  assert.deepEqual(upstreamBinary, binary)
} finally {
  globalThis.fetch = originalFetch
  if (originalBackendUrl === undefined) delete process.env.STUDIO_BACKEND_API_URL
  else process.env.STUDIO_BACKEND_API_URL = originalBackendUrl
}

test('Storage proxy assertions completed', () => {})
