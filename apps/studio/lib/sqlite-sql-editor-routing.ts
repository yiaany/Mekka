export const SQLITE_SQL_EDITOR_ID_PREFIX = 'sqlite-'

const sqliteSqlEditorIdPattern =
  /^sqlite-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function createSqliteSqlEditorId(): string {
  return `${SQLITE_SQL_EDITOR_ID_PREFIX}${crypto.randomUUID()}`
}

export function isSqliteSqlEditorId(id: string | undefined): id is string {
  return id !== undefined && sqliteSqlEditorIdPattern.test(id)
}

export function buildSqliteSqlEditorPath(projectRef: string, id: string): string {
  return `/project/${encodeURIComponent(projectRef)}/sql/${id}`
}
