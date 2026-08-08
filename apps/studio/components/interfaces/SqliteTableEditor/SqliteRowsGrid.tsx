import { type StudioRow, type StudioRowValue } from "@mekka/studio-domain-sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Input, Label, Textarea } from "ui";
import { ConfirmationModal } from "ui-patterns/Dialogs/ConfirmationModal";

import { createProjectStudioDomainClient } from "@/data/studio-domain/client";

const pageSize = 50;

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
  const keyColumn = primaryKey[0];
  const hasSinglePrimaryKey = primaryKey.length === 1;
  const rows = useQuery({
    queryKey: ["sqlite-rows", projectRef, table, page, filter, keyColumn],
    queryFn: () =>
      client.listRows(table, {
        limit: pageSize,
        offset: page * pageSize,
        ...(filter.length === 0 || keyColumn === undefined
          ? {}
          : { filter: { column: keyColumn, value: filter } }),
      }),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: ["sqlite-rows", projectRef, table],
    });
  };

  const handleCreate = async () => {
    if (isMutating) return;
    setIsMutating(true);
    try {
      await client.createRow(table, parseRow(draft), idempotencyKey("create"));
      setDraft("");
      setError(null);
      await refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setIsMutating(false);
    }
  };

  const handleUpdate = async () => {
    if (!hasSinglePrimaryKey || keyColumn === undefined) {
      setError("Row editing requires exactly one primary key column.");
      return;
    }
    if (editingRow === null) return;
    if (isMutating) return;
    setIsMutating(true);
    try {
      const values = parseRow(editDraft);
      await client.updateRow(
        table,
        { column: keyColumn, value: editingRow[keyColumn] ?? null },
        values,
        idempotencyKey("update"),
      );
      setEditingRow(null);
      setEditDraft("");
      setError(null);
      await refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setIsMutating(false);
    }
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
    if (isMutating) return;
    setIsMutating(true);
    try {
      await client.deleteRow(
        table,
        { column: keyColumn, value: String(row[keyColumn]) },
        idempotencyKey("delete"),
      );
      setError(null);
      setRowToDelete(null);
      await refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setIsMutating(false);
    }
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
