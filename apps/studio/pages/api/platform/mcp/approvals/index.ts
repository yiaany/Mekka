import { handleApprovalListRequest } from '@/lib/mekka-platform-handlers'
import { toNextWebHandler } from '@/lib/next-web-handler'

export default toNextWebHandler(handleApprovalListRequest, () => ({}), ['GET'])
