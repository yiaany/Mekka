import type { NextApiRequest } from 'next'

import { handleProjectAuthProxy } from '@/lib/mekka-platform-handlers'
import { toNextWebHandler } from '@/lib/next-web-handler'

export const config = { api: { bodyParser: false } }

export default toNextWebHandler(
  handleProjectAuthProxy,
  (request: NextApiRequest) => {
    const path = request.query.path
    const segments = Array.isArray(path) ? path : typeof path === 'string' ? [path] : []
    return segments.length === 0 ? null : { _splat: segments.join('/') }
  },
  ['GET', 'POST']
)
