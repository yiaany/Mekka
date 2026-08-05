import type { StudioTablePage } from '@mekka/studio-domain-sdk'

import { ENTITY_TYPE } from './entity-type-constants'
import type { EntityTypesResponse } from './entity-types-infinite-query'

export function mapStudioTablesToEntityTypes(
  page: StudioTablePage,
  offset = 0
): EntityTypesResponse {
  return {
    data: {
      entities: page.tables.map((table, index) => ({
        id: -(offset + index + 1),
        domainId: table.id,
        schema: table.namespace,
        name: table.name,
        type: ENTITY_TYPE.TABLE,
        comment: null,
        rls_enabled: false,
        source: 'studio-domain',
      })),
      count: page.totalCount,
    },
  }
}
