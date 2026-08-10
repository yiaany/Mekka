import type { NextApiRequest } from 'next'

import { handleApprovalDecisionRequest } from '@/lib/mekka-platform-handlers'
import { toNextWebHandler } from '@/lib/next-web-handler'

export const config = { api: { bodyParser: false } }

export default toNextWebHandler(
  handleApprovalDecisionRequest,
  (request: NextApiRequest) => {
    const approvalId = Array.isArray(request.query.approvalId)
      ? request.query.approvalId[0]
      : request.query.approvalId
    return approvalId ? { approvalId } : null
  },
  ['PATCH']
)
