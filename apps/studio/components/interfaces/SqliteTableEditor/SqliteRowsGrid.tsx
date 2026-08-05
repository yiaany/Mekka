import { type StudioRow, type StudioRowValue } from '@mekka/studio-domain-sdk'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from 'ui'

import { createProjectStudioDomainClient } from '@/data/studio-domain/client'

const pageSize = 50

export function SqliteRowsGrid({ projectRef, table, primaryKey }: { projectRef: string; table: string; primaryKey: readonly string[] }) {
  const client = createProjectStudioDomainClient(projectRef)
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const [draft, setDraft] = useState('')
  const [editingRow, setEditingRow] = useState<StudioRow | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const keyColumn = primaryKey[0]
  const rows = useQuery({
    queryKey: ['sqlite-rows', projectRef, table, page, filter],
    queryFn: () => client.listRows(table, {
      limit: pageSize,
      offset: page * pageSize,
      ...(filter.length === 0 || keyColumn === undefined ? {} : { filter: { column: keyColumn, value: filter } }),
    }),
  })

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sqlite-rows', projectRef, table] })
  }

  const handleCreate = async () => {
    try {
      await client.createRow(table, parseRow(draft), idempotencyKey('create'))
      setDraft('')
      setError(null)
      await refresh()
    } catch (cause) {
      setError(message(cause))
    }
  }

  const handleUpdate = async () => {
    if (keyColumn === undefined) {
      setError('A primary key is required to edit rows.')
      return
    }
    if (editingRow === null) return
    try {
      const values = parseRow(editDraft)
      await client.updateRow(table, { column: keyColumn, value: editingRow[keyColumn] ?? null }, values, idempotencyKey('update'))
      setEditingRow(null)
      setEditDraft('')
      setError(null)
      await refresh()
    } catch (cause) {
      setError(message(cause))
    }
  }

  const handleDelete = async (row: StudioRow) => {
    if (keyColumn === undefined || row[keyColumn] === undefined) {
      setError('A primary key is required to delete rows.')
      return
    }
    try {
      await client.deleteRow(table, { column: keyColumn, value: String(row[keyColumn]) }, idempotencyKey('delete'))
      setError(null)
      await refresh()
    } catch (cause) {
      setError(message(cause))
    }
  }

  const columns = rows.data?.rows.length === 0 ? [] : Object.keys(rows.data?.rows[0] ?? {})
  const hasNextPage = rows.data !== undefined && (page + 1) * pageSize < rows.data.totalCount
  return (
    <section className="space-y-3" aria-label="Rows">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg">Rows</h2>
        {keyColumn !== undefined && <input aria-label="Filter rows" className="border rounded p-2" placeholder={`Filter ${keyColumn}`} value={filter} onChange={(event) => { setFilter(event.target.value); setPage(0) }} />}
      </div>
      {error !== null && <p role="alert" className="text-destructive">{error}</p>}
      {rows.isLoading && <p>Loading rows...</p>}
      {rows.isError && <p role="alert">Rows could not be loaded.</p>}
      {rows.data !== undefined && (
        <div className="overflow-auto border rounded">
          <table className="w-full text-sm">
            <thead><tr>{columns.map((column) => <th key={column} className="text-left p-2">{column}</th>)}<th className="p-2">Actions</th></tr></thead>
            <tbody>{rows.data.rows.map((row, index) => <tr key={`${keyColumn === undefined ? index : String(row[keyColumn])}-${index}`} className="border-t">{columns.map((column) => <td key={column} className="p-2 whitespace-pre-wrap">{display(row[column])}</td>)}<td className="p-2 space-x-2"><Button size="tiny" disabled={keyColumn === undefined} onClick={() => { setEditingRow(row); setEditDraft(JSON.stringify(row)) }}>Edit</Button><Button size="tiny" variant="danger" disabled={keyColumn === undefined} onClick={() => void handleDelete(row)}>Delete</Button></td></tr>)}</tbody>
          </table>
        </div>
      )}
      {rows.data !== undefined && <div className="flex gap-2 items-center"><Button size="tiny" disabled={page === 0} onClick={() => setPage((current) => current - 1)}>Previous</Button><span>{page * pageSize + 1}-{Math.min((page + 1) * pageSize, rows.data.totalCount)} of {rows.data.totalCount}</span><Button size="tiny" disabled={!hasNextPage} onClick={() => setPage((current) => current + 1)}>Next</Button></div>}
      <div className="space-y-2"><label className="block" htmlFor="new-sqlite-row">New row JSON</label><textarea id="new-sqlite-row" className="w-full border rounded p-2 font-mono" rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder='{"id": 1, "body": "Example"}' /><Button disabled={draft.trim().length === 0} onClick={() => void handleCreate()}>Insert row</Button></div>
      {editingRow !== null && <div className="space-y-2"><label className="block" htmlFor="edit-sqlite-row">Edit row JSON</label><textarea id="edit-sqlite-row" className="w-full border rounded p-2 font-mono" rows={4} value={editDraft} onChange={(event) => setEditDraft(event.target.value)} /><Button onClick={() => void handleUpdate()}>Save row</Button><Button variant="default" onClick={() => { setEditingRow(null); setEditDraft('') }}>Cancel</Button></div>}
    </section>
  )
}

function parseRow(value: string): StudioRow {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Row must be an object.')
    const row: Record<string, StudioRowValue> = {}
    for (const [column, cell] of Object.entries(parsed)) {
      if (typeof cell !== 'string' && typeof cell !== 'number' && cell !== null) throw new Error('Values must be strings, numbers or null.')
      row[column] = cell
    }
    return row
  } catch (cause) {
    throw new Error(cause instanceof Error ? cause.message : 'Row must be valid JSON.')
  }
}

function display(value: StudioRowValue | undefined): string { return value === null ? 'NULL' : String(value ?? '') }
function idempotencyKey(action: string): string { return `studio-row-${action}-${crypto.randomUUID()}` }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'Row operation failed.' }
