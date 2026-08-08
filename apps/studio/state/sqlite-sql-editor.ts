import type { StudioSqlResult } from '@mekka/studio-domain-sdk'
import { proxy, useSnapshot } from 'valtio'

export type SqliteSqlEditorHistoryItem = {
  at: string
  mode: 'read' | 'write'
  status: 'completed' | 'cancelled' | 'failed'
}

export type SqliteSqlEditorSession = {
  sql: string
  isWriteEnabled: boolean
  result: StudioSqlResult | null
  error: string | null
  history: SqliteSqlEditorHistoryItem[]
}

const sessions = proxy<Record<string, SqliteSqlEditorSession>>({})

export function getOrCreateSqliteSqlEditorSession(id: string): SqliteSqlEditorSession {
  sessions[id] ??= {
    sql: 'SELECT 1 AS value LIMIT 1',
    isWriteEnabled: false,
    result: null,
    error: null,
    history: [],
  }
  return sessions[id]
}

export function useSqliteSqlEditorSession(id: string) {
  const session = getOrCreateSqliteSqlEditorSession(id)
  return { session, snapshot: useSnapshot(session) }
}

export function removeSqliteSqlEditorSession(id: string): void {
  delete sessions[id]
}

export function resetSqliteSqlEditorSessions(): void {
  for (const id of Object.keys(sessions)) delete sessions[id]
}
