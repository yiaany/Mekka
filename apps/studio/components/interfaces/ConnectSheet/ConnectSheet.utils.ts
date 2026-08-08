import type { ConnectMode } from './Connect.types'
import type { ConnectSheetPrefs } from './useConnectSheetParams'

export type ConnectSheetQueryParams = {
  connectTab: string | null
  framework: string | null
  using: string | null
  method: string | null
  type: string | null
  mcpClient: string | null
}

export type ConnectSheetUrlUpdates = Partial<Record<keyof ConnectSheetQueryParams, string | null>>
export type ConnectSheetFieldUpdate = { fieldId: string; value: string }
export type ConnectSheetHydration = {
  mode: ConnectMode | null
  fieldUpdates: ConnectSheetFieldUpdate[]
  urlUpdates: ConnectSheetUrlUpdates
}

export function mapConnectTabToMode(tab: string | null): ConnectMode | null {
  return tab === 'mcp' ? 'mcp' : null
}

export function resolveConnectSheetHydration(
  query: ConnectSheetQueryParams,
  storedPrefs: ConnectSheetPrefs,
  availableModeIds: ConnectMode[]
): ConnectSheetHydration {
  const tab = query.connectTab ?? storedPrefs.connectTab ?? null
  const mappedMode = mapConnectTabToMode(tab)
  return {
    mode: mappedMode && availableModeIds.includes(mappedMode) ? mappedMode : null,
    fieldUpdates: [],
    urlUpdates: query.connectTab === null && tab === 'mcp' ? { connectTab: 'mcp' } : {},
  }
}
