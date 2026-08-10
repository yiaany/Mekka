import type { NextApiRequest } from 'next'

import { handleVerificationCodeRequest } from '@/lib/mekka-platform-handlers'
import { toNextWebHandler } from '@/lib/next-web-handler'

export default toNextWebHandler(
  handleVerificationCodeRequest,
  (request: NextApiRequest) => {
    const ref = Array.isArray(request.query.ref) ? request.query.ref[0] : request.query.ref
    return ref ? { ref } : null
  },
  ['GET']
)
