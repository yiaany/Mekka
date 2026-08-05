import { isStudioDomainError, type StudioColumnType, type StudioTableColumn } from '@mekka/studio-domain-sdk'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'common'
import { useRouter } from 'next/router'
import { useState } from 'react'
import { Button } from 'ui'

import { createProjectStudioDomainClient } from '@/data/studio-domain/client'
import { SqliteRowsGrid } from './SqliteRowsGrid'

const columnTypes: readonly StudioColumnType[] = ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC']

export function SqliteTableEditor({ tableName }: { tableName?: string }) {
  const { ref: projectRef } = useParams()
  const router = useRouter()
  const queryClient = useQueryClient()
  const client = projectRef ? createProjectStudioDomainClient(projectRef) : undefined
  const [newTableName, setNewTableName] = useState(tableName ?? '')
  const [columns, setColumns] = useState<StudioTableColumn[]>([
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
  ])
  const [newColumnName, setNewColumnName] = useState('')
  const [newColumnType, setNewColumnType] = useState<StudioColumnType>('TEXT')
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirmed, setDeleteConfirmed] = useState(false)
  const [migrationSql, setMigrationSql] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const schema = useQuery({
    queryKey: ['sqlite-schema-health', projectRef],
    queryFn: () => client!.getSchemaHealth(),
    enabled: client !== undefined,
  })
  const table = useQuery({
    queryKey: ['sqlite-table', projectRef, tableName],
    queryFn: () => client!.getTable(tableName!),
    enabled: client !== undefined && tableName !== undefined,
  })

  const currentTable = table.data
  const schemaHash = schema.data?.schemaHash
  const previewSql = tableName
    ? buildPreviewSql(tableName, renameValue, newColumnName, newColumnType, deleteConfirmed)
    : buildCreatePreview(newTableName, columns)

  const runMutation = async (operation: () => Promise<{ migrationSql: string }>) => {
    setIsSubmitting(true)
    setErrorMessage(null)
    try {
      const result = await operation()
      setMigrationSql(result.migrationSql)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sqlite-schema-health', projectRef] }),
        queryClient.invalidateQueries({ queryKey: ['sqlite-table', projectRef, tableName] }),
        queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'entity-types'] }),
      ])
    } catch (error) {
      if (isStudioDomainError(error) && error.code === 'conflict') {
        setErrorMessage('The schema changed. Reload it before applying another migration.')
      } else {
        setErrorMessage(isStudioDomainError(error) ? error.message : 'Unable to apply this schema migration.')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!projectRef) return null
  if (schema.isLoading || (tableName !== undefined && table.isLoading)) return <p className="p-6">Loading schema...</p>
  if (schema.isError || table.isError) {
    return (
      <div className="p-6 space-y-3">
        <p role="alert">The schema could not be loaded.</p>
        <Button onClick={() => void Promise.all([schema.refetch(), table.refetch()])}>Reload schema</Button>
      </div>
    )
  }

  const canSubmit = schemaHash !== undefined && !isSubmitting
  return (
    <main className="p-6 max-w-4xl space-y-6" data-testid="sqlite-table-editor">
      <header>
        <p className="text-foreground-muted text-sm">SQLite Table Editor</p>
        <h1 className="text-2xl">{tableName ?? 'New table'}</h1>
      </header>

      {errorMessage && (
        <div role="alert" className="border border-destructive rounded p-3 space-y-2">
          <p>{errorMessage}</p>
          <Button size="tiny" onClick={() => void Promise.all([schema.refetch(), table.refetch()])}>
            Reload schema
          </Button>
        </div>
      )}

      {migrationSql && (
        <section aria-label="Applied migration" className="space-y-2">
          <h2 className="text-lg">Applied migration</h2>
          <pre className="p-3 rounded bg-surface-200 overflow-auto">{migrationSql}</pre>
        </section>
      )}

      {tableName === undefined && (
        <section className="space-y-4">
          <label className="block">
            <span>Table name</span>
            <input className="block border rounded p-2 mt-1" value={newTableName} onChange={(event) => setNewTableName(event.target.value)} />
          </label>
          <ColumnsEditor columns={columns} onChange={setColumns} />
          <MigrationPreview sql={previewSql} />
          <Button
            disabled={!canSubmit}
            onClick={() => void runMutation(async () => {
              const result = await client!.createTable({ name: newTableName, columns, expectedSchemaHash: schemaHash! }, idempotencyKey())
              await router.push(`/project/${projectRef}/editor/${encodeURIComponent(result.resource.name)}`)
              return result
            })}
          >
            Create table
          </Button>
        </section>
      )}

      {tableName !== undefined && currentTable && (
        <section className="space-y-6">
           <div>
            <h2 className="text-lg mb-2">Columns</h2>
            <ul className="border rounded divide-y">
              {currentTable.columns.map((column) => (
                <li key={column.name} className="p-3 flex justify-between"><span>{column.name}</span><span>{column.type}{column.primaryKey ? ' PRIMARY KEY' : ''}{column.nullable ? '' : ' NOT NULL'}</span></li>
              ))}
            </ul>
           </div>
           <SqliteRowsGrid projectRef={projectRef} table={tableName} primaryKey={currentTable.primaryKey} />
          <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (schemaHash) void runMutation(() => client!.addColumn({ table: tableName, column: { name: newColumnName, type: newColumnType, nullable: true }, expectedSchemaHash: schemaHash }, idempotencyKey())) }}>
            <h2 className="text-lg">Add column</h2>
            <input className="border rounded p-2 mr-2" aria-label="Column name" value={newColumnName} onChange={(event) => setNewColumnName(event.target.value)} />
            <select className="border rounded p-2 mr-2" aria-label="Column type" value={newColumnType} onChange={(event) => setNewColumnType(event.target.value as StudioColumnType)}>{columnTypes.map((type) => <option key={type}>{type}</option>)}</select>
            <MigrationPreview sql={previewSql} />
            <Button type="submit" disabled={!canSubmit}>Add column</Button>
          </form>
          <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (schemaHash) void runMutation(() => client!.renameTable({ table: tableName, name: renameValue, expectedSchemaHash: schemaHash }, idempotencyKey())) }}>
            <h2 className="text-lg">Rename table</h2>
            <input className="border rounded p-2 mr-2" aria-label="New table name" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
            <MigrationPreview sql={previewSql} />
            <Button type="submit" disabled={!canSubmit}>Rename table</Button>
          </form>
          <section className="border border-destructive rounded p-4 space-y-3">
            <h2 className="text-lg">Delete table</h2>
            <label><input type="checkbox" checked={deleteConfirmed} onChange={(event) => setDeleteConfirmed(event.target.checked)} /> I understand this creates a recovery checkpoint before dropping the table.</label>
            <MigrationPreview sql={deleteConfirmed ? `DROP TABLE "${tableName}"` : null} />
            <Button variant="danger" disabled={!canSubmit || !deleteConfirmed} onClick={() => void runMutation(async () => { const result = await client!.deleteTable({ table: tableName, expectedSchemaHash: schemaHash! }, idempotencyKey()); await router.push(`/project/${projectRef}/editor`); return result })}>Delete table</Button>
          </section>
        </section>
      )}
    </main>
  )
}

function ColumnsEditor({ columns, onChange }: { columns: StudioTableColumn[]; onChange: (columns: StudioTableColumn[]) => void }) {
  return <div className="space-y-2"><h2 className="text-lg">Columns</h2>{columns.map((column, index) => <div className="flex gap-2" key={`${column.name}-${index}`}><input aria-label={`Column ${index + 1} name`} className="border rounded p-2" value={column.name} onChange={(event) => onChange(columns.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, name: event.target.value } : candidate))} /><select aria-label={`Column ${index + 1} type`} className="border rounded p-2" value={column.type} onChange={(event) => onChange(columns.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, type: event.target.value as StudioColumnType } : candidate))}>{columnTypes.map((type) => <option key={type}>{type}</option>)}</select><label><input type="checkbox" checked={column.primaryKey} onChange={(event) => onChange(columns.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, primaryKey: event.target.checked, nullable: event.target.checked ? false : candidate.nullable } : candidate))} /> Primary key</label></div>)}<Button type="button" size="tiny" onClick={() => onChange([...columns, { name: '', type: 'TEXT', nullable: true, primaryKey: false }])}>Add another column</Button></div>
}

function MigrationPreview({ sql }: { sql: string | null }) { return <section aria-label="Migration preview" className="space-y-1"><h3 className="text-sm">Migration preview</h3><pre className="p-3 rounded bg-surface-200 overflow-auto">{sql ?? 'Complete the supported fields to generate a migration.'}</pre></section> }
function buildCreatePreview(name: string, columns: readonly StudioTableColumn[]): string | null { if (!identifier(name) || columns.length === 0 || columns.some((column) => !identifier(column.name))) return null; const primaryKey = columns.filter((column) => column.primaryKey).map((column) => quote(column.name)); return `CREATE TABLE ${quote(name)} (${[...columns.map((column) => `${quote(column.name)} ${column.type}${column.nullable === false || column.primaryKey ? ' NOT NULL' : ''}`), ...(primaryKey.length ? [`PRIMARY KEY (${primaryKey.join(', ')})`] : [])].join(', ')})` }
function buildPreviewSql(table: string, rename: string, column: string, type: StudioColumnType, deleting: boolean): string | null { if (deleting) return `DROP TABLE ${quote(table)}`; if (identifier(rename)) return `ALTER TABLE ${quote(table)} RENAME TO ${quote(rename)}`; if (identifier(column)) return `ALTER TABLE ${quote(table)} ADD COLUMN ${quote(column)} ${type}`; return null }
function identifier(value: string): boolean { return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) }
function quote(value: string): string { return `"${value.replaceAll('"', '""')}"` }
function idempotencyKey(): string { return `studio-schema-${crypto.randomUUID()}` }
