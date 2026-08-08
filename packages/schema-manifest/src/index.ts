import { createHash } from "node:crypto";
import type { StorageExecutor, StorageValue } from "@mekka/storage-core";

export const schemaManifestFormatVersion = 1;

export type SchemaManifest = Readonly<{
  formatVersion: typeof schemaManifestFormatVersion;
  schemaVersion: number;
  hash: string;
  tables: readonly SchemaTable[];
}>;

export type SchemaTable = Readonly<{
  name: string;
  columns: readonly SchemaColumn[];
  foreignKeys: readonly SchemaForeignKey[];
  indexes: readonly SchemaIndex[];
}>;

export type SchemaColumn = Readonly<{
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKeyPosition: number;
  hidden: "none" | "hidden" | "generated_virtual" | "generated_stored";
}>;

export type SchemaForeignKey = Readonly<{
  id: number;
  columns: readonly string[];
  referencedTable: string;
  referencedColumns: readonly (string | null)[];
  onUpdate: string;
  onDelete: string;
  match: string;
}>;

export type SchemaIndex = Readonly<{
  name: string;
  unique: boolean;
  origin: "created" | "unique_constraint" | "primary_key";
  partial: boolean;
  columns: readonly SchemaIndexColumn[];
}>;

export type SchemaIndexColumn = Readonly<{
  sequence: number;
  columnId: number;
  name: string | null;
  descending: boolean;
  collation: string;
  key: boolean;
}>;

export type SchemaManifestOptions = Readonly<{
  internalTablePrefix?: string;
}>;

export type SchemaManifestCache = Readonly<{
  get(): SchemaManifest;
  invalidate(): void;
}>;

export type SchemaManifestErrorCode =
  | "SCHEMA_MANIFEST_ENGINE_UNSUPPORTED"
  | "SCHEMA_MANIFEST_MALFORMED";

export class SchemaManifestError extends Error {
  readonly code: SchemaManifestErrorCode;

  constructor(code: SchemaManifestErrorCode, message: string) {
    super(message);
    this.name = "SchemaManifestError";
    this.code = code;
  }
}

const defaultInternalTablePrefix = "_mekka_";
const minimumSqliteVersion = [3, 37, 0] as const;

export function isReservedSchemaIdentifier(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith("sqlite_") || normalized.startsWith(defaultInternalTablePrefix);
}

export function buildSchemaManifest(
  storage: StorageExecutor,
  options: SchemaManifestOptions = {},
): SchemaManifest {
  const internalTablePrefix = options.internalTablePrefix ?? defaultInternalTablePrefix;
  validateInternalTablePrefix(internalTablePrefix);

  verifySqliteVersion(storage);
  const schemaVersion = readSchemaVersion(storage);
  const tables = readTables(storage, internalTablePrefix);
  const canonical = JSON.stringify({
    formatVersion: schemaManifestFormatVersion,
    tables,
  });

  return freezeManifest({
    formatVersion: schemaManifestFormatVersion,
    schemaVersion,
    hash: createHash("sha256").update(canonical).digest("hex"),
    tables,
  });
}

export function createSchemaManifestCache(
  storage: StorageExecutor,
  options: SchemaManifestOptions = {},
): SchemaManifestCache {
  let cached: SchemaManifest | undefined;

  return Object.freeze({
    get(): SchemaManifest {
      const schemaVersion = readSchemaVersion(storage);

      if (cached === undefined || cached.schemaVersion !== schemaVersion) {
        cached = buildSchemaManifest(storage, options);
      }

      return cached;
    },
    invalidate(): void {
      cached = undefined;
    },
  });
}

function readSchemaVersion(storage: StorageExecutor): number {
  const row = storage.execute<{ schemaVersion: StorageValue }>({
    sql: "SELECT schema_version AS schemaVersion FROM pragma_schema_version",
  }).rows[0];

  return readNonNegativeInteger(row?.schemaVersion, "schema version");
}

function verifySqliteVersion(storage: StorageExecutor): void {
  const row = storage.execute<{ sqliteVersion: StorageValue }>({
    sql: "SELECT sqlite_version() AS sqliteVersion",
  }).rows[0];
  const version = readSqliteVersion(readString(row?.sqliteVersion, "SQLite version"));

  if (compareVersions(version, minimumSqliteVersion) < 0) {
    throw new SchemaManifestError(
      "SCHEMA_MANIFEST_ENGINE_UNSUPPORTED",
      `SQLite ${version.join(".")} does not support PRAGMA table_list; SQLite ${minimumSqliteVersion.join(".")} or later is required.`,
    );
  }
}

function readTables(storage: StorageExecutor, internalTablePrefix: string): readonly SchemaTable[] {
  const rows = storage.execute<{
    name: StorageValue;
    schema: StorageValue;
    type: StorageValue;
  }>({
    sql: "SELECT name, schema, type FROM pragma_table_list WHERE schema = ? AND type = ? ORDER BY name",
    parameters: ["main", "table"],
  }).rows;

  return rows
    .map((row) => ({
      name: readString(row.name, "table name"),
      schema: readString(row.schema, "table schema"),
      type: readString(row.type, "table type"),
    }))
    .filter((table) => table.schema === "main" && table.type === "table")
    .filter((table) => !isInternalTable(table.name, internalTablePrefix))
    .map((table) =>
      Object.freeze({
        name: table.name,
        columns: readColumns(storage, table.name),
        foreignKeys: readForeignKeys(storage, table.name),
        indexes: readIndexes(storage, table.name),
      }),
    );
}

function readColumns(storage: StorageExecutor, tableName: string): readonly SchemaColumn[] {
  const rows = storage.execute<{
    cid: StorageValue;
    name: StorageValue;
    type: StorageValue;
    notnull: StorageValue;
    dflt_value: StorageValue;
    pk: StorageValue;
    hidden: StorageValue;
  }>({
    sql: 'SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
    parameters: [tableName],
  }).rows;

  return rows.map((row) =>
    Object.freeze({
      name: readString(row.name, `column name in ${tableName}`),
      type: readString(row.type, `column type in ${tableName}`),
      notNull: readBooleanInteger(row.notnull, `notnull in ${tableName}`),
      defaultValue: readNullableString(row.dflt_value, `default value in ${tableName}`),
      primaryKeyPosition: readNonNegativeInteger(row.pk, `primary key position in ${tableName}`),
      hidden: readHiddenColumnKind(row.hidden, tableName),
    }),
  );
}

function readForeignKeys(storage: StorageExecutor, tableName: string): readonly SchemaForeignKey[] {
  const rows = storage.execute<{
    id: StorageValue;
    seq: StorageValue;
    table: StorageValue;
    from: StorageValue;
    to: StorageValue;
    on_update: StorageValue;
    on_delete: StorageValue;
    match: StorageValue;
  }>({
    sql: 'SELECT id, seq, "table", "from", "to", on_update, on_delete, "match" FROM pragma_foreign_key_list(?) ORDER BY id, seq',
    parameters: [tableName],
  }).rows;
  const foreignKeys = new Map<
    number,
    {
      columns: string[];
      referencedColumns: (string | null)[];
      referencedTable: string;
      onUpdate: string;
      onDelete: string;
      match: string;
    }
  >();

  for (const row of rows) {
    const id = readNonNegativeInteger(row.id, `foreign key id in ${tableName}`);
    const current = foreignKeys.get(id);
    const referencedTable = readString(row.table, `foreign key table in ${tableName}`);
    const onUpdate = readString(row.on_update, `foreign key update action in ${tableName}`);
    const onDelete = readString(row.on_delete, `foreign key delete action in ${tableName}`);
    const match = readString(row.match, `foreign key match in ${tableName}`);

    if (current === undefined) {
      foreignKeys.set(id, {
        columns: [readString(row.from, `foreign key column in ${tableName}`)],
        referencedColumns: [
          readNullableString(row.to, `foreign key target column in ${tableName}`),
        ],
        referencedTable,
        onUpdate,
        onDelete,
        match,
      });
      continue;
    }

    if (
      current.referencedTable !== referencedTable ||
      current.onUpdate !== onUpdate ||
      current.onDelete !== onDelete ||
      current.match !== match
    ) {
      throw malformed(`Foreign key ${id} in ${tableName} has inconsistent metadata.`);
    }

    current.columns.push(readString(row.from, `foreign key column in ${tableName}`));
    current.referencedColumns.push(
      readNullableString(row.to, `foreign key target column in ${tableName}`),
    );
  }

  return [...foreignKeys.entries()].map(([id, foreignKey]) =>
    Object.freeze({
      id,
      columns: Object.freeze(foreignKey.columns),
      referencedTable: foreignKey.referencedTable,
      referencedColumns: Object.freeze(foreignKey.referencedColumns),
      onUpdate: foreignKey.onUpdate,
      onDelete: foreignKey.onDelete,
      match: foreignKey.match,
    }),
  );
}

function readIndexes(storage: StorageExecutor, tableName: string): readonly SchemaIndex[] {
  const rows = storage.execute<{
    name: StorageValue;
    unique: StorageValue;
    origin: StorageValue;
    partial: StorageValue;
  }>({
    sql: 'SELECT name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY name',
    parameters: [tableName],
  }).rows;

  return rows.map((row) => {
    const name = readString(row.name, `index name in ${tableName}`);

    return Object.freeze({
      name,
      unique: readBooleanInteger(row.unique, `index uniqueness in ${tableName}`),
      origin: readIndexOrigin(row.origin, tableName),
      partial: readBooleanInteger(row.partial, `index partial flag in ${tableName}`),
      columns: readIndexColumns(storage, name),
    });
  });
}

function readIndexColumns(
  storage: StorageExecutor,
  indexName: string,
): readonly SchemaIndexColumn[] {
  const rows = storage.execute<{
    seqno: StorageValue;
    cid: StorageValue;
    name: StorageValue;
    desc: StorageValue;
    coll: StorageValue;
    key: StorageValue;
  }>({
    sql: 'SELECT seqno, cid, name, "desc", coll, "key" FROM pragma_index_xinfo(?) ORDER BY seqno',
    parameters: [indexName],
  }).rows;

  return rows.map((row) =>
    Object.freeze({
      sequence: readNonNegativeInteger(row.seqno, `index sequence in ${indexName}`),
      columnId: readInteger(row.cid, `index column id in ${indexName}`),
      name: readNullableString(row.name, `index column name in ${indexName}`),
      descending: readBooleanInteger(row.desc, `index direction in ${indexName}`),
      collation: readString(row.coll, `index collation in ${indexName}`),
      key: readBooleanInteger(row.key, `index key flag in ${indexName}`),
    }),
  );
}

function isInternalTable(name: string, internalTablePrefix: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized.startsWith("sqlite_") || normalized.startsWith(internalTablePrefix.toLowerCase())
  );
}

function validateInternalTablePrefix(value: string): void {
  if (value.length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw malformed("Internal table prefix must be a non-empty SQLite identifier prefix.");
  }
}

function readString(value: StorageValue | undefined, field: string): string {
  if (typeof value !== "string") {
    throw malformed(`${field} must be a string.`);
  }

  return value;
}

function readNullableString(value: StorageValue | undefined, field: string): string | null {
  if (value === null) {
    return null;
  }

  return readString(value, field);
}

function readInteger(value: StorageValue | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw malformed(`${field} must be a safe integer.`);
  }

  return value;
}

function readNonNegativeInteger(value: StorageValue | undefined, field: string): number {
  const integer = readInteger(value, field);

  if (integer < 0) {
    throw malformed(`${field} must not be negative.`);
  }

  return integer;
}

function readBooleanInteger(value: StorageValue | undefined, field: string): boolean {
  const integer = readInteger(value, field);

  if (integer !== 0 && integer !== 1) {
    throw malformed(`${field} must be zero or one.`);
  }

  return integer === 1;
}

function readHiddenColumnKind(
  value: StorageValue | undefined,
  tableName: string,
): SchemaColumn["hidden"] {
  switch (readNonNegativeInteger(value, `hidden flag in ${tableName}`)) {
    case 0:
      return "none";
    case 1:
      return "hidden";
    case 2:
      return "generated_virtual";
    case 3:
      return "generated_stored";
    default:
      throw malformed(`Hidden flag in ${tableName} is not supported.`);
  }
}

function readIndexOrigin(
  value: StorageValue | undefined,
  tableName: string,
): SchemaIndex["origin"] {
  switch (readString(value, `index origin in ${tableName}`)) {
    case "c":
      return "created";
    case "u":
      return "unique_constraint";
    case "pk":
      return "primary_key";
    default:
      throw malformed(`Index origin in ${tableName} is not supported.`);
  }
}

function readSqliteVersion(value: string): readonly number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);

  if (match === null) {
    throw malformed("SQLite version must use major.minor.patch format.");
  }

  return match.slice(1).map((segment) => Number(segment));
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function freezeManifest(manifest: {
  formatVersion: typeof schemaManifestFormatVersion;
  schemaVersion: number;
  hash: string;
  tables: readonly SchemaTable[];
}): SchemaManifest {
  return Object.freeze({
    ...manifest,
    tables: Object.freeze(manifest.tables),
  });
}

function malformed(message: string): SchemaManifestError {
  return new SchemaManifestError("SCHEMA_MANIFEST_MALFORMED", message);
}
