import { useQuery } from '@tanstack/react-query'

import { serviceStatusKeys } from './keys'
import type { ResponseError, UseCustomQueryOptions } from '@/types'

export type EdgeFunctionServiceStatusVariables = {
  projectRef?: string
}

export async function getEdgeFunctionServiceStatus(signal?: AbortSignal) {
  void signal
  return { healthy: false }
}

export type EdgeFunctionServiceStatusData = Awaited<ReturnType<typeof getEdgeFunctionServiceStatus>>
export type EdgeFunctionServiceStatusError = ResponseError

export const useEdgeFunctionServiceStatusQuery = <TData = EdgeFunctionServiceStatusData>(
  { projectRef }: EdgeFunctionServiceStatusVariables,
  {
    enabled = true,
    ...options
  }: UseCustomQueryOptions<
    EdgeFunctionServiceStatusData,
    EdgeFunctionServiceStatusError,
    TData
  > = {}
) =>
  useQuery<EdgeFunctionServiceStatusData, EdgeFunctionServiceStatusError, TData>({
    queryKey: serviceStatusKeys.edgeFunctions(projectRef),
    queryFn: ({ signal }) => getEdgeFunctionServiceStatus(signal),
    enabled: enabled && typeof projectRef !== 'undefined',
    ...options,
  })
