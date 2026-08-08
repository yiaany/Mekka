import {
  isStudioDomainError,
  type StudioColumnType,
  type StudioTableColumn,
} from "@mekka/studio-domain-sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "common";
import { useRouter } from "next/router";
import { useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui";

import { createProjectStudioDomainClient } from "@/data/studio-domain/client";
import { SqliteRowsGrid } from "./SqliteRowsGrid";

const columnTypes: readonly StudioColumnType[] = [
  "INTEGER",
  "TEXT",
  "REAL",
  "BLOB",
  "NUMERIC",
];

export function SqliteTableEditor({ tableName }: { tableName?: string }) {
  const { ref: projectRef } = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const client = projectRef
    ? createProjectStudioDomainClient(projectRef)
    : undefined;
  const [newTableName, setNewTableName] = useState(tableName ?? "");
  const [columns, setColumns] = useState<StudioTableColumn[]>([
    { name: "id", type: "INTEGER", nullable: false, primaryKey: true },
  ]);
  const [newColumnName, setNewColumnName] = useState("");
  const [newColumnType, setNewColumnType] = useState<StudioColumnType>("TEXT");
  const [renameValue, setRenameValue] = useState("");
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [migrationSql, setMigrationSql] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const schema = useQuery({
    queryKey: ["sqlite-schema-health", projectRef],
    queryFn: () => client!.getSchemaHealth(),
    enabled: client !== undefined,
  });
  const table = useQuery({
    queryKey: ["sqlite-table", projectRef, tableName],
    queryFn: () => client!.getTable(tableName!),
    enabled: client !== undefined && tableName !== undefined,
  });

  const currentTable = table.data;
  const schemaHash = schema.data?.schemaHash;
  const createPreview = buildCreatePreview(newTableName, columns);
  const addColumnPreview =
    tableName && identifier(newColumnName)
      ? `ALTER TABLE ${quote(tableName)} ADD COLUMN ${quote(newColumnName)} ${newColumnType}`
      : null;
  const renamePreview =
    tableName && identifier(renameValue)
      ? `ALTER TABLE ${quote(tableName)} RENAME TO ${quote(renameValue)}`
      : null;
  const hasDuplicateColumns =
    new Set(columns.map((column) => column.name)).size !== columns.length;
  const isReservedTableName = newTableName.toLowerCase() === "new";
  const canCreateTable =
    schemaHash !== undefined &&
    !isSubmitting &&
    createPreview !== null &&
    !hasDuplicateColumns &&
    !isReservedTableName;
  const canAddColumn =
    schemaHash !== undefined &&
    !isSubmitting &&
    addColumnPreview !== null &&
    !currentTable?.columns.some((column) => column.name === newColumnName);
  const canRenameTable =
    schemaHash !== undefined &&
    !isSubmitting &&
    renamePreview !== null &&
    renameValue !== tableName &&
    renameValue.toLowerCase() !== "new";

  const runMutation = async <T extends { migrationSql: string }>(
    operation: () => Promise<T>,
  ) => {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await operation();
      setMigrationSql(result.migrationSql);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["sqlite-schema-health", projectRef],
        }),
        queryClient.invalidateQueries({
          queryKey: ["projects", projectRef, "entity-types"],
        }),
      ]);
      return result;
    } catch (error) {
      if (isStudioDomainError(error) && error.code === "conflict") {
        setErrorMessage(
          "The schema changed. Reload it before applying another migration.",
        );
      } else {
        setErrorMessage(
          isStudioDomainError(error)
            ? error.message
            : "Unable to apply this schema migration.",
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const reloadSchema = () =>
    tableName === undefined
      ? schema.refetch()
      : Promise.all([schema.refetch(), table.refetch()]);

  if (!projectRef) return null;
  if (schema.isLoading || (tableName !== undefined && table.isLoading))
    return <p className="p-6">Loading schema...</p>;
  if (schema.isError || table.isError) {
    return (
      <div className="p-6 space-y-3">
        <p role="alert">The schema could not be loaded.</p>
        <Button onClick={() => void reloadSchema()}>Reload schema</Button>
      </div>
    );
  }

  return (
    <main
      className="w-full max-w-5xl space-y-6 p-4 sm:p-6"
      data-testid="sqlite-table-editor"
    >
      <header>
        <p className="text-foreground-muted text-sm">SQLite Table Editor</p>
        <h1 className="text-2xl">{tableName ?? "New table"}</h1>
      </header>

      {errorMessage && (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive bg-destructive-200 p-3"
        >
          <p>{errorMessage}</p>
          <Button size="tiny" onClick={() => void reloadSchema()}>
            Reload schema
          </Button>
        </div>
      )}

      {migrationSql && (
        <section aria-label="Applied migration" className="space-y-2">
          <h2 className="text-lg">Applied migration</h2>
          <pre className="p-3 rounded bg-surface-200 overflow-auto">
            {migrationSql}
          </pre>
        </section>
      )}

      {tableName === undefined && (
        <section className="space-y-5 rounded-lg border bg-surface-100 p-4 sm:p-6">
          <div className="space-y-2">
            <Label htmlFor="sqlite-table-name">Table name</Label>
            <Input
              id="sqlite-table-name"
              autoFocus
              value={newTableName}
              aria-invalid={
                newTableName.length > 0 &&
                (!identifier(newTableName) || isReservedTableName)
              }
              onChange={(event) => setNewTableName(event.target.value)}
              placeholder="customers"
            />
            {!identifier(newTableName) && newTableName.length > 0 && (
              <FieldError>
                Use letters, numbers, and underscores; start with a letter or
                underscore.
              </FieldError>
            )}
            {isReservedTableName && (
              <FieldError>
                "new" is reserved by the editor route. Choose another table
                name.
              </FieldError>
            )}
          </div>
          <ColumnsEditor columns={columns} onChange={setColumns} />
          {hasDuplicateColumns && (
            <FieldError>Column names must be unique.</FieldError>
          )}
          <MigrationPreview sql={createPreview} />
          <Button
            disabled={!canCreateTable}
            onClick={() =>
              void (async () => {
                const result = await runMutation(() =>
                  client!.createTable(
                    {
                      name: newTableName,
                      columns,
                      expectedSchemaHash: schemaHash!,
                    },
                    idempotencyKey(),
                  ),
                );
                if (result)
                  await router.push(
                    `/project/${projectRef}/editor/${encodeURIComponent(result.resource.name)}`,
                  );
              })()
            }
          >
            {isSubmitting ? "Creating table..." : "Create table"}
          </Button>
        </section>
      )}

      {tableName !== undefined && currentTable && (
        <section className="space-y-6">
          <div>
            <h2 className="text-lg mb-2">Columns</h2>
            <ul className="divide-y rounded-md border bg-surface-100">
              {currentTable.columns.map((column) => (
                <li key={column.name} className="p-3 flex justify-between">
                  <span>{column.name}</span>
                  <span>
                    {column.type}
                    {column.primaryKey ? " PRIMARY KEY" : ""}
                    {column.nullable ? "" : " NOT NULL"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <SqliteRowsGrid
            projectRef={projectRef}
            table={tableName}
            primaryKey={currentTable.primaryKey}
          />
          <form
            className="space-y-3 rounded-lg border bg-surface-100 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (schemaHash && canAddColumn)
                void (async () => {
                  const result = await runMutation(() =>
                    client!.addColumn(
                      {
                        table: tableName,
                        column: {
                          name: newColumnName,
                          type: newColumnType,
                          nullable: true,
                        },
                        expectedSchemaHash: schemaHash,
                      },
                      idempotencyKey(),
                    ),
                  );
                  if (result) {
                    setNewColumnName("");
                    await queryClient.invalidateQueries({
                      queryKey: ["sqlite-table", projectRef, tableName],
                    });
                  }
                })();
            }}
          >
            <h2 className="text-lg">Add column</h2>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <Input
                aria-label="Column name"
                value={newColumnName}
                onChange={(event) => setNewColumnName(event.target.value)}
                placeholder="email"
              />
              <ColumnTypeSelect
                value={newColumnType}
                onChange={setNewColumnType}
                label="Column type"
              />
            </div>
            <MigrationPreview sql={addColumnPreview} />
            <Button type="submit" disabled={!canAddColumn}>
              {isSubmitting ? "Adding column..." : "Add column"}
            </Button>
          </form>
          <form
            className="space-y-3 rounded-lg border bg-surface-100 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (schemaHash && canRenameTable)
                void (async () => {
                  const result = await runMutation(() =>
                    client!.renameTable(
                      {
                        table: tableName,
                        name: renameValue,
                        expectedSchemaHash: schemaHash,
                      },
                      idempotencyKey(),
                    ),
                  );
                  if (result) {
                    await queryClient.invalidateQueries({
                      queryKey: ["sqlite-table", projectRef, tableName],
                    });
                    await router.replace(
                      `/project/${projectRef}/editor/${encodeURIComponent(result.resource.name)}`,
                    );
                  }
                })();
            }}
          >
            <h2 className="text-lg">Rename table</h2>
            <Input
              aria-label="New table name"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder={tableName}
            />
            <MigrationPreview sql={renamePreview} />
            <Button type="submit" disabled={!canRenameTable}>
              {isSubmitting ? "Renaming table..." : "Rename table"}
            </Button>
          </form>
          <section className="space-y-3 rounded-lg border border-destructive bg-destructive-200 p-4">
            <h2 className="text-lg">Delete table</h2>
            <div className="flex items-start gap-2">
              <Checkbox
                id="confirm-delete-table"
                checked={deleteConfirmed}
                onCheckedChange={(checked) =>
                  setDeleteConfirmed(checked === true)
                }
              />
              <Label
                htmlFor="confirm-delete-table"
                className="cursor-pointer font-normal leading-5"
              >
                I understand this creates a recovery checkpoint before dropping
                the table.
              </Label>
            </div>
            <MigrationPreview
              sql={deleteConfirmed ? `DROP TABLE "${tableName}"` : null}
            />
            <Button
              variant="danger"
              disabled={
                schemaHash === undefined || isSubmitting || !deleteConfirmed
              }
              onClick={() =>
                void (async () => {
                  const result = await runMutation(() =>
                    client!.deleteTable(
                      { table: tableName, expectedSchemaHash: schemaHash! },
                      idempotencyKey(),
                    ),
                  );
                  if (result)
                    await router.push(`/project/${projectRef}/editor`);
                })()
              }
            >
              {isSubmitting ? "Deleting table..." : "Delete table"}
            </Button>
          </section>
        </section>
      )}
    </main>
  );
}

function ColumnsEditor({
  columns,
  onChange,
}: {
  columns: StudioTableColumn[];
  onChange: (columns: StudioTableColumn[]) => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg">Columns</h2>
      {columns.map((column, index) => {
        const checkboxId = `sqlite-column-${index}-primary-key`;
        return (
          <div
            className="grid gap-3 rounded-md border bg-surface-200 p-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-center"
            key={index}
          >
            <Input
              aria-label={`Column ${index + 1} name`}
              value={column.name}
              onChange={(event) =>
                onChange(
                  columns.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, name: event.target.value }
                      : candidate,
                  ),
                )
              }
            />
            <ColumnTypeSelect
              value={column.type}
              onChange={(type) =>
                onChange(
                  columns.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, type }
                      : candidate,
                  ),
                )
              }
              label={`Column ${index + 1} type`}
            />
            <div className="flex items-center gap-2">
              <Checkbox
                id={checkboxId}
                checked={column.primaryKey}
                onCheckedChange={(checked) =>
                  onChange(
                    columns.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? {
                            ...candidate,
                            primaryKey: checked === true,
                            nullable:
                              checked === true ? false : candidate.nullable,
                          }
                        : candidate,
                    ),
                  )
                }
              />
              <Label
                htmlFor={checkboxId}
                className="cursor-pointer whitespace-nowrap font-normal"
              >
                Primary key
              </Label>
            </div>
          </div>
        );
      })}
      <Button
        type="button"
        size="tiny"
        onClick={() =>
          onChange([
            ...columns,
            { name: "", type: "TEXT", nullable: true, primaryKey: false },
          ])
        }
      >
        Add another column
      </Button>
    </div>
  );
}

function ColumnTypeSelect({
  value,
  onChange,
  label,
}: {
  value: StudioColumnType;
  onChange: (value: StudioColumnType) => void;
  label: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => onChange(nextValue as StudioColumnType)}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {columnTypes.map((type) => (
          <SelectItem key={type} value={type}>
            {type}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
function FieldError({ children }: { children: string }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}
function MigrationPreview({ sql }: { sql: string | null }) {
  return (
    <section aria-label="Migration preview" className="space-y-1">
      <h3 className="text-sm text-foreground-light">Migration preview</h3>
      <pre className="overflow-auto rounded-md border bg-surface-200 p-3 text-xs text-foreground">
        {sql ?? "Complete the supported fields to generate a migration."}
      </pre>
    </section>
  );
}
function buildCreatePreview(
  name: string,
  columns: readonly StudioTableColumn[],
): string | null {
  if (
    !identifier(name) ||
    columns.length === 0 ||
    columns.some((column) => !identifier(column.name))
  )
    return null;
  const primaryKey = columns
    .filter((column) => column.primaryKey)
    .map((column) => quote(column.name));
  return `CREATE TABLE ${quote(name)} (${[...columns.map((column) => `${quote(column.name)} ${column.type}${column.nullable === false || column.primaryKey ? " NOT NULL" : ""}`), ...(primaryKey.length ? [`PRIMARY KEY (${primaryKey.join(", ")})`] : [])].join(", ")})`;
}
function identifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
}
function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function idempotencyKey(): string {
  return `studio-schema-${crypto.randomUUID()}`;
}
