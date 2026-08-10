import type { NextApiRequest, NextApiResponse } from 'next'

type WebHandler<TParams extends Record<string, string>> = (context: Readonly<{
  request: Request
  params: TParams
}>) => Promise<Response>

export function toNextWebHandler<TParams extends Record<string, string>>(
  handler: WebHandler<TParams>,
  resolveParams: (request: NextApiRequest) => TParams | null,
  allowedMethods: readonly string[]
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (!req.method || !allowedMethods.includes(req.method)) {
      res.setHeader('allow', allowedMethods)
      return res.status(405).json({ error: 'method_not_allowed' })
    }
    const params = resolveParams(req)
    if (params === null) return res.status(404).json({ error: 'not_found' })

    const response = await handler({ request: await toWebRequest(req), params })
    return sendWebResponse(res, response)
  }
}

async function toWebRequest(req: NextApiRequest): Promise<Request> {
  const protocol = isEncryptedSocket(req.socket) ? 'https' : 'http'
  const host = readHeader(req.headers.host) ?? 'studio.local'
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
    else headers.set(name, value)
  }

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readRequestBody(req)
  return new Request(`${protocol}://${host}${req.url ?? '/'}`, {
    method: req.method,
    headers,
    ...(body === undefined ? {} : { body }),
  })
}

async function readRequestBody(req: NextApiRequest): Promise<ArrayBuffer | undefined> {
  let body: Buffer
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) body = req.body
    else if (typeof req.body === 'string') body = Buffer.from(req.body)
    else body = Buffer.from(JSON.stringify(req.body))
  } else {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (chunks.length === 0) return undefined
    body = Buffer.concat(chunks)
  }
  return Uint8Array.from(body).buffer
}

async function sendWebResponse(res: NextApiResponse, response: Response) {
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const cookies = getSetCookie?.call(response.headers) ?? []
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value)
  })
  if (cookies.length > 0) res.setHeader('set-cookie', cookies)
  return res.status(response.status).send(Buffer.from(await response.arrayBuffer()))
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function isEncryptedSocket(socket: NextApiRequest['socket']): boolean {
  return 'encrypted' in socket && socket.encrypted === true
}
