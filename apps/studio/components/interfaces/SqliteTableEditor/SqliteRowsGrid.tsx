import {
  isStudioDomainError,
  type StudioRow,
  type StudioRowValue,
} from "@mekka/studio-domain-sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button, Input, Label, Textarea } from "ui";
import { ConfirmationModal } from "ui-patterns/Dialogs/ConfirmationModal";

import { createProjectStudioDomainClient } from "@/data/studio-domain/client";

const pageSize = 50;
const reconciliationTimeoutMs = 5_000;
type Reconciliation = "applied" | "not-applied" | "unknown";

export function SqliteRowsGrid({
  projectRef,
  table,
  primaryKey,
}: {
  projectRef: string;
  table: string;
  primaryKey: readonly string[];
}) {
  const client = createProjectStudioDomainClient(projectRef);
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState("");
  const [editingRow, setEditingRow] = useState<StudioRow | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const [rowToDelete, setRowToDelete] = useState<StudioRow | null>(null);
  const mounted = useRef(true);
  const mutationController = useRef<AbortController | null>(null);
  const keyColumn = primaryKey[0];
  const hasSinglePrimaryKey = primaryKey.length === 1;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutationController.current?.abort();
    };
  }, []);
  const rows = useQuery({
    queryKey: ["sqlite-rows", projectRef, table, page, filter, keyColumn],
    queryFn: ({ signal }) =>
      client.listRows(table, {
        limit: pageSize,
        offset: page * pageSize,
        ...(filter.length === 0 || keyColumn === undefined
          ? {}
          : { filter: { column: keyColumn, value: filter } }),
        signal,
      }),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: ["sqlite-rows", projectRef, table],
    });
  };

  const runMutation = async (
    operation: (signal: AbortSignal) => Promise<unknown>,
    onSuccess: () => void,
    reconcile: (signal: AbortSignal) => Promise<Reconciliation>,
  ) => {
    if (isMutating) return;
    const controller = new AbortController();
    mutationController.current = controller;
    setIsMutating(true);
    try {
      await operation(controller.signal);
      if (!mounted.current) return;
      onSuccess();
      setError(null);
      setIsMutating(false);
      mutationController.current = null;
      refresh();
    } catch (cause) {
      if (controller.signal.aborted || !mounted.current) return;
      if (isStudioDomainError(cause) && cause.outcomeAmbiguous) {
        const result = await reconcileWithTimeout(controller.signal, reconcile);
        if (!mounted.current) return;
        setError(reconciliationMessage(result));
        refresh();
      } else {
        setError(message(cause));
      }
    } finally {
      if (mounted.current) setIsMutating(false);
      if (mutationController.current === controller)
        mutationController.current = null;
    }
  };

  const findRows = (column: string, value: StudioRowValue, signal: AbortSignal) =>
    client.listRows(table, {
      limit: 200,
      filter: { column, value: String(value) },
      signal,
    });

  const handleCreate = async () => {
    let values: StudioRow;
    try {
      values = parseRow(draft);
    } catch (cause) {
      setError(message(cause));
      return;
    }
    const attemptKey = idempotencyKey("create");
    await runMutation(
      (signal) => client.createRow(table, values, attemptKey, { signal }),
      () => setDraft(""),
      async (signal) => {
        if (keyColumn === undefined || values[keyColumn] === undefined) return "unknown";
        const result = await findRows(keyColumn, values[keyColumn], signal);
        return result.rows
          .filter((row) => rowValueEquals(row[keyColumn], values[keyColumn]))
          .some((row) => rowMatches(row, values))
          ? "applied"
          : "not-applied";
      },
    );
  };

  const handleUpdate = async () => {
    if (!hasSinglePrimaryKey || keyColumn === undefined) {
      setError("Row editing requires exactly one primary key column.");
      return;
    }
    if (editingRow === null) return;
    let values: StudioRow;
    try {
      values = parseRow(editDraft);
    } catch (cause) {
      setError(message(cause));
      return;
    }
    const key = { column: keyColumn, value: editingRow[keyColumn] ?? null };
    const attemptKey = idempotencyKey("update");
    await runMutation(
      (signal) => client.updateRow(table, key, values, attemptKey, { signal }),
      () => {
        setEditingRow(null);
        setEditDraft("");
      },
      async (signal) => {
        const nextKey = values[keyColumn] ?? key.value;
        const result = await findRows(keyColumn, nextKey, signal);
        return result.rows
          .filter((row) => rowValueEquals(row[keyColumn], nextKey))
          .some((row) => rowMatches(row, values))
          ? "applied"
          : "not-applied";
      },
    );
  };

  const handleDelete = async (row: StudioRow) => {
    if (
      !hasSinglePrimaryKey ||
      keyColumn === undefined ||
      row[keyColumn] === undefined
    ) {
      setError("Row deletion requires exactly one primary key column.");
      return;
    }
    const key = { column: keyColumn, value: String(row[keyColumn]) };
    const attemptKey = idempotencyKey("delete");
    await runMutation(
      (signal) => client.deleteRow(table, key, attemptKey, { signal }),
      () => setRowToDelete(null),
      async (signal) => {
        const result = await findRows(keyColumn, key.value, signal);
        return result.rows.some((candidate) => rowValueEquals(candidate[keyColumn], key.value))
          ? "not-applied"
          : "applied";
      },
    );
  };

  const columns =
    rows.data?.rows.length === 0 ? [] : Object.keys(rows.data?.rows[0] ?? {});
  const hasNextPage =
    rows.data !== undefined && (page + 1) * pageSize < rows.data.totalCount;
  return (
    <section className="space-y-3" aria-label="Rows">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg">Rows</h2>
        {keyColumn !== undefined && (
          <Input
            aria-label="Filter rows"
            className="sm:max-w-xs"
            placeholder={`Filter ${keyColumn}`}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setPage(0);
            }}
          />
        )}
      </div>
      {primaryKey.length > 1 && (
        <p className="text-sm text-warning">
          Composite primary keys are readable, but row editing and deletion are
          disabled until the API supports full composite keys.
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {rows.isLoading && <p>Loading rows...</p>}
      {rows.isError && <p role="alert">Rows could not be loaded.</p>}
      {rows.data !== undefined && (
        <div className="overflow-auto rounded-md border bg-surface-100">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column} className="text-left p-2">
                    {column}
                  </th>
                ))}
                <th className="p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.data.rows.map((row, index) => (
                <tr
                  key={`${keyColumn === undefined ? index : String(row[keyColumn])}-${index}`}
                  className="border-t"
                >
                  {columns.map((column) => (
                    <td key={column} className="p-2 whitespace-pre-wrap">
                      {display(row[column])}
                    </td>
                  ))}
                  <td className="p-2">
                    <div className="flex gap-2">
                      <Button
                        size="tiny"
                        disabled={!hasSinglePrimaryKey || isMutating}
                        onClick={() => {
                          setEditingRow(row);
                          setEditDraft(JSON.stringify(row, null, 2));
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="tiny"
                        variant="danger"
                        disabled={!hasSinglePrimaryKey || isMutating}
                        onClick={() => setRowToDelete(row)}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.data !== undefined && (
        <div className="flex flex-wrap gap-2 items-center">
          <Button
            size="tiny"
            disabled={page === 0}
            onClick={() => setPage((current) => current - 1)}
          >
            Previous
          </Button>
          <span>
            {rows.data.totalCount === 0
              ? "0 of 0"
              : `${page * pageSize + 1}-${Math.min((page + 1) * pageSize, rows.data.totalCount)} of ${rows.data.totalCount}`}
          </span>
          <Button
            size="tiny"
            disabled={!hasNextPage}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      )}
      <div className="space-y-2 rounded-lg border bg-surface-100 p-4">
        <Label htmlFor="new-sqlite-row">New row JSON</Label>
        <Textarea
          id="new-sqlite-row"
          className="min-h-28 font-mono"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder='{"id": 1, "body": "Example"}'
        />
        <Button
          disabled={draft.trim().length === 0 || isMutating}
          onClick={() => void handleCreate()}
        >
          {isMutating ? "Saving..." : "Insert row"}
        </Button>
      </div>
      {editingRow !== null && (
        <div className="space-y-2 rounded-lg border bg-surface-100 p-4">
          <Label htmlFor="edit-sqlite-row">Edit row JSON</Label>
          <Textarea
            id="edit-sqlite-row"
            className="min-h-28 font-mono"
            value={editDraft}
            onChange={(event) => setEditDraft(event.target.value)}
          />
          <div className="flex gap-2">
            <Button disabled={isMutating} onClick={() => void handleUpdate()}>
              {isMutating ? "Saving..." : "Save row"}
            </Button>
            <Button
              variant="default"
              disabled={isMutating}
              onClick={() => {
                setEditingRow(null);
                setEditDraft("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      <ConfirmationModal
        visible={rowToDelete !== null}
        title="Delete this row?"
        description={
          rowToDelete && keyColumn
            ? `This permanently deletes the row where ${keyColumn} is ${display(rowToDelete[keyColumn])}.`
            : undefined
        }
        confirmLabel="Delete row"
        confirmLabelLoading="Deleting..."
        loading={isMutating}
        variant="destructive"
        onCancel={() => setRowToDelete(null)}
        onConfirm={() => {
          if (rowToDelete) void handleDelete(rowToDelete);
        }}
      />
    </section>
  );
}

function parseRow(value: string): StudioRow {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("Row must be an object.");
    const row: Record<string, StudioRowValue> = {};
    for (const [column, cell] of Object.entries(parsed)) {
      if (typeof cell !== "string" && typeof cell !== "number" && cell !== null)
        throw new Error("Values must be strings, numbers or null.");
      row[column] = cell;
    }
    return row;
  } catch (cause) {
    throw new Error(
      cause instanceof Error ? cause.message : "Row must be valid JSON.",
    );
  }
}

function display(value: StudioRowValue | undefined): string {
  return value === null ? "NULL" : String(value ?? "");
}
function idempotencyKey(action: string): string {
  return `studio-row-${action}-${crypto.randomUUID()}`;
}
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Row operation failed.";
}

function rowMatches(row: StudioRow, expected: StudioRow): boolean {
  return Object.entries(expected).every(([column, value]) => rowValueEquals(row[column], value));
}

function rowValueEquals(
  actual: StudioRowValue | undefined,
  expected: StudioRowValue | undefined,
): boolean {
  if (actual === expected) return true;
  if (actual === null || expected === null || actual === undefined || expected === undefined) {
    return false;
  }
  if (typeof actual === typeof expected) return false;
  const text = typeof actual === "string" ? actual : expected;
  const number = typeof actual === "number" ? actual : expected;
  return (
    typeof text === "string" &&
    typeof number === "number" &&
    text === String(number) &&
    Number.isFinite(number)
  );
}

async function reconcileWithTimeout(
  parentSignal: AbortSignal,
  reconcile: (signal: AbortSignal) => Promise<Reconciliation>,
): Promise<Reconciliation> {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), reconciliationTimeoutMs);
  try {
    return await reconcile(controller.signal);
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
}

function reconciliationMessage(result: Reconciliation): string {
  if (result === "applied")
    return "The row mutation appears applied, but Studio did not receive its response. Rows are being reloaded.";
  if (result === "not-applied")
    return "The row mutation does not appear applied. Review the reloaded rows before trying again.";
  return "Studio could not confirm whether the row mutation was applied. Review the rows before trying again.";
}
