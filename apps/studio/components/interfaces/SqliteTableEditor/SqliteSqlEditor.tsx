import { type StudioSqlResult } from '@mekka/studio-domain-sdk'
import { useRef, useState } from 'react'
import { Button } from 'ui'

import { createProjectStudioDomainClient } from '@/data/studio-domain/client'

type HistoryItem = Readonly<{ at: string; mode: 'read' | 'write'; status: 'completed' | 'cancelled' | 'failed' }>

export function SqliteSqlEditor({ projectRef }: { projectRef: string }) {
  const controller = useRef<AbortController | null>(null)
  const [sql, setSql] = useState('SELECT 1 AS value LIMIT 1')
  const [isWriteEnabled, setIsWriteEnabled] = useState(false)
  const [result, setResult] = useState<StudioSqlResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [history, setHistory] = useState<readonly HistoryItem[]>([])
  const isWrite = /^(?:\s*)(?:insert|update|delete)\b/i.test(sql)

  const addHistory = (item: HistoryItem) => setHistory((current) => [item, ...current].slice(0, 10))
  const handleRun = async () => {
    if (isWrite && !isWriteEnabled) {
      setError('Write SQL is disabled. Enable the privileged write flow first.')
      return
    }
    const signal = new AbortController()
    const timeout = window.setTimeout(() => signal.abort(new DOMException('Timed out', 'AbortError')), 10_000)
    controller.current = signal
    setIsRunning(true)
    setError(null)
    try {
      const response = await createProjectStudioDomainClient(projectRef).runSql({ sql, signal: signal.signal }, `studio-sql-${crypto.randomUUID()}`)
      setResult(response)
      addHistory({ at: new Date().toISOString(), mode: isWrite ? 'write' : 'read', status: 'completed' })
    } catch (cause) {
      const cancelled = signal.signal.aborted
      setError(cancelled ? 'Query cancelled or timed out.' : cause instanceof Error ? cause.message : 'SQL query failed.')
      addHistory({ at: new Date().toISOString(), mode: isWrite ? 'write' : 'read', status: cancelled ? 'cancelled' : 'failed' })
    } finally {
      window.clearTimeout(timeout)
      controller.current = null
      setIsRunning(false)
    }
  }

  return (
    <main className="p-6 max-w-5xl space-y-4" data-testid="sqlite-sql-editor">
      <header><p className="text-foreground-muted text-sm">SQLite SQL Editor</p><h1 className="text-2xl">Query console</h1></header>
      <p>Read-only by default. The server permits a single bounded statement and records audit metadata without SQL text or results.</p>
      <label className="flex gap-2 items-center"><input type="checkbox" checked={isWriteEnabled} onChange={(event) => setIsWriteEnabled(event.target.checked)} /> Enable privileged write SQL</label>
      <textarea aria-label="SQL query" className="w-full min-h-48 border rounded p-3 font-mono" value={sql} onChange={(event) => setSql(event.target.value)} />
      <div className="flex gap-2"><Button disabled={isRunning} onClick={() => void handleRun()}>Run query</Button>{isRunning && <Button variant="default" onClick={() => controller.current?.abort(new DOMException('Cancelled', 'AbortError'))}>Cancel query</Button>}</div>
      {error !== null && <p role="alert" className="text-destructive">{error}</p>}
      {result !== null && <section aria-label="SQL result"><p>{result.changes} rows changed</p><pre className="p-3 rounded bg-surface-200 overflow-auto">{JSON.stringify(result.rows, null, 2)}</pre></section>}
      <section aria-label="Query history"><h2 className="text-lg">Query history</h2><p className="text-foreground-muted text-sm">History intentionally stores status and mode only, never query text or result data.</p><ul>{history.map((item) => <li key={`${item.at}-${item.status}`}>{item.at}: {item.mode} {item.status}</li>)}</ul></section>
    </main>
  )
}
