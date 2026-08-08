import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Label, Textarea } from 'ui'

import { createProjectStudioDomainClient } from '@/data/studio-domain/client'
import {
  type SqliteSqlEditorHistoryItem,
  useSqliteSqlEditorSession,
} from '@/state/sqlite-sql-editor'

export function SqliteSqlEditor({
  projectRef,
  editorId,
}: {
  projectRef: string
  editorId: string
}) {
  const controller = useRef<AbortController | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const { session, snapshot } = useSqliteSqlEditorSession(editorId)
  const isWrite = /^(?:\s*)(?:insert|update|delete)\b/i.test(snapshot.sql)

  useEffect(() => () => controller.current?.abort(), [])

  const addHistory = (item: SqliteSqlEditorHistoryItem) => {
    session.history = [item, ...session.history].slice(0, 10)
  }

  const handleRun = async () => {
    if (isWrite && !snapshot.isWriteEnabled) {
      session.error = 'Write SQL is disabled. Enable the privileged write flow first.'
      return
    }

    const signal = new AbortController()
    const timeout = window.setTimeout(
      () => signal.abort(new DOMException('Timed out', 'AbortError')),
      10_000
    )
    controller.current = signal
    setIsRunning(true)
    session.error = null
    session.result = null

    try {
      const response = await createProjectStudioDomainClient(projectRef).runSql(
        { sql: snapshot.sql, signal: signal.signal },
        `studio-sql-${crypto.randomUUID()}`
      )
      session.result = response
      addHistory({
        at: new Date().toISOString(),
        mode: isWrite ? 'write' : 'read',
        status: 'completed',
      })
    } catch (cause) {
      const isCancelled = signal.signal.aborted
      session.error = isCancelled
        ? 'Query cancelled or timed out.'
        : cause instanceof Error
          ? cause.message
          : 'SQL query failed.'
      addHistory({
        at: new Date().toISOString(),
        mode: isWrite ? 'write' : 'read',
        status: isCancelled ? 'cancelled' : 'failed',
      })
    } finally {
      window.clearTimeout(timeout)
      controller.current = null
      setIsRunning(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-5 p-6" data-testid="sqlite-sql-editor">
      <header className="space-y-1">
        <p className="text-foreground-muted text-xs font-medium uppercase tracking-wider">
          SQLite query workspace
        </p>
        <h1 className="text-2xl">Query console</h1>
        <p className="max-w-2xl text-sm text-foreground-light">
          Each tab keeps its own in-memory query and result. SQL text is never written to browser
          storage.
        </p>
      </header>

      <section className="overflow-hidden rounded-lg border bg-surface-100">
        <Textarea
          aria-label="SQL query"
          className="min-h-64 resize-y rounded-none border-0 bg-transparent p-4 font-mono text-sm focus-visible:ring-0"
          value={snapshot.sql}
          onChange={(event) => (session.sql = event.target.value)}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-surface-200 px-4 py-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              id={`sqlite-write-sql-${editorId}`}
              checked={snapshot.isWriteEnabled}
              onCheckedChange={(checked) => (session.isWriteEnabled = checked === true)}
            />
            <Label htmlFor={`sqlite-write-sql-${editorId}`} className="cursor-pointer font-normal">
              Enable guarded write statements
            </Label>
          </label>
          <div className="flex gap-2">
            {isRunning && (
              <Button
                variant="default"
                onClick={() =>
                  controller.current?.abort(new DOMException('Cancelled', 'AbortError'))
                }
              >
                Cancel
              </Button>
            )}
            <Button
              disabled={isRunning || snapshot.sql.trim().length === 0}
              onClick={() => void handleRun()}
            >
              {isRunning ? 'Running...' : 'Run query'}
            </Button>
          </div>
        </div>
      </section>

      {snapshot.error !== null && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {snapshot.error}
        </p>
      )}

      {snapshot.result !== null && (
        <section aria-label="SQL result" className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-lg">Result</h2>
            <p className="text-xs text-foreground-muted">{snapshot.result.changes} rows changed</p>
          </div>
          <pre className="max-h-96 overflow-auto rounded-lg border bg-surface-200 p-4 text-xs">
            {JSON.stringify(snapshot.result.rows, null, 2)}
          </pre>
        </section>
      )}

      {snapshot.history.length > 0 && (
        <section aria-label="Query history" className="space-y-2">
          <h2 className="text-lg">Session activity</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {snapshot.history.map((item) => (
              <li key={`${item.at}-${item.status}`} className="flex justify-between gap-4 px-4 py-3">
                <span className="capitalize">{item.mode} query</span>
                <span className="text-foreground-muted">
                  {item.status} at {new Date(item.at).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
