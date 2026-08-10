import type { NextApiRequest } from 'next'

import { handleAgentTokenRequest } from '@/lib/mekka-platform-handlers'
import { toNextWebHandler } from '@/lib/next-web-handler'

export const config = { api: { bodyParser: false } }

export default toNextWebHandler(
  handleAgentTokenRequest,
  (request: NextApiRequest) => {
    const ref = Array.isArray(request.query.ref) ? request.query.ref[0] : request.query.ref
    return ref ? { ref } : null
  },
  ['POST']
)
