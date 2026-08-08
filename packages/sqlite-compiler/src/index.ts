import {
  type BooleanGroup,
  type Filter,
  type FilterExpression,
  type MutationAst,
  type MutationInput,
  type QueryAst,
  queryAstFormatVersion,
} from "@mekka/query-ast";
import type { SchemaManifest, SchemaTable } from "@mekka/schema-manifest";
import type { StorageValue } from "@mekka/storage-core";

export const sqliteCompilerFormatVersion = 1;

export type CompiledSelect = Readonly<{
  formatVersion: typeof sqliteCompilerFormatVersion;
  sql: string;
  parameters: readonly StorageValue[];
  cost: SelectCost;
}>;

export type CompiledMutation = Readonly<{
  formatVersion: typeof sqliteCompilerFormatVersion;
  sql: string;
  parameters: readonly StorageValue[];
}>;

export type SelectCost = Readonly<{
  selectedColumns: number;
  filterNodes: number;
  booleanGroups: number;
  orderTerms: number;
  parameterCount: number;
}>;

export type SQLiteCompilerLimits = Readonly<{
  maxParameters: number;
  maxListSize: number;
}>;

export type CompileSelectOptions = Readonly<{
  limits?: Partial<SQLiteCompilerLimits>;
}>;

export type SQLiteCompilerErrorCode =
  | "SQLITE_COMPILER_MALFORMED"
  | "SQLITE_COMPILER_UNSUPPORTED"
  | "SQLITE_COMPILER_VALIDATION"
  | "SQLITE_COMPILER_LIMIT";

export class SQLiteCompilerError extends Error {
  readonly code: SQLiteCompilerErrorCode;

  constructor(code: SQLiteCompilerErrorCode, message: string) {
    super(message);
    this.name = "SQLiteCompilerError";
    this.code = code;
  }
}

const defaultLimits: SQLiteCompilerLimits = Object.freeze({
  // Kept below SQLite's usual 999-variable default to leave capacity for future policy predicates.
  maxParameters: 500,
  maxListSize: 100,
});

export function compileSelect(
  manifest: SchemaManifest,
  ast: QueryAst,
  options: CompileSelectOptions = {},
): CompiledSelect {
  return compileSelectWithProjection(manifest, ast, options, undefined);
}

export function compileSelectCount(
  manifest: SchemaManifest,
  ast: QueryAst,
  options: CompileSelectOptions = {},
): CompiledSelect {
  return compileSelectWithProjection(
    manifest,
    Object.freeze({ ...ast, order: Object.freeze([]), limit: null, offset: 0 }),
    options,
    "COUNT(*) AS count",
  );
}

export function compileMutation(manifest: SchemaManifest, ast: MutationAst): CompiledMutation {
  if (ast.formatVersion !== queryAstFormatVersion) {
    throw unsupported(`Query AST format version ${String(ast.formatVersion)} is not supported.`);
  }
  const table = findTable(manifest, ast.table);
  const columns = visibleColumns(table);
  const values = compileMutationInput(ast.values, columns, "Mutation values");
  const primaryKey =
    ast.primaryKey === null
      ? null
      : compileMutationInput(ast.primaryKey, columns, "Mutation primary key");
  if (ast.action === "delete") {
    if (values.columns.length !== 0) throw malformed("Delete mutations must not include values.");
  } else if (values.columns.length === 0) {
    throw malformed("Mutation values must not be empty.");
  }

  switch (ast.action) {
    case "insert":
      return freezeMutation(
        `INSERT INTO ${quoteIdentifier(table.name)} (${values.columns.map(quoteIdentifier).join(", ")}) VALUES (${values.columns.map(() => "?").join(", ")}) RETURNING *`,
        values.parameters,
      );
    case "update":
      if (primaryKey === null) {
        throw malformed("Update mutations require a primary key.");
      }
      return freezeMutation(
        `UPDATE ${quoteIdentifier(table.name)} SET ${values.columns.map((column) => `${quoteIdentifier(column)} = ?`).join(", ")} WHERE ${compilePrimaryKeyWhere(primaryKey.columns)} RETURNING *`,
        [...values.parameters, ...primaryKey.parameters],
      );
    case "delete":
      if (primaryKey === null) {
        throw malformed("Delete mutations require a primary key.");
      }
      return freezeMutation(
        `DELETE FROM ${quoteIdentifier(table.name)} WHERE ${compilePrimaryKeyWhere(primaryKey.columns)} RETURNING *`,
        primaryKey.parameters,
      );
    case "upsert": {
      if (primaryKey === null) {
        throw malformed("Upsert mutations require a primary key.");
      }
      const mutableColumns = values.columns.filter(
        (column) => !primaryKey.columns.includes(column),
      );
      const firstPrimaryKey = primaryKey.columns[0];
      if (firstPrimaryKey === undefined) {
        throw malformed("Upsert mutations require a primary key.");
      }
      const conflictAction =
        mutableColumns.length === 0
          ? `DO UPDATE SET ${quoteIdentifier(firstPrimaryKey)} = excluded.${quoteIdentifier(firstPrimaryKey)}`
          : `DO UPDATE SET ${mutableColumns.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(", ")}`;
      return freezeMutation(
        `INSERT INTO ${quoteIdentifier(table.name)} (${values.columns.map(quoteIdentifier).join(", ")}) VALUES (${values.columns.map(() => "?").join(", ")}) ON CONFLICT (${primaryKey.columns.map(quoteIdentifier).join(", ")}) ${conflictAction} RETURNING *`,
        values.parameters,
      );
    }
  }
}

function compileSelectWithProjection(
  manifest: SchemaManifest,
  ast: QueryAst,
  options: CompileSelectOptions,
  fixedProjection: string | undefined,
): CompiledSelect {
  const limits = resolveLimits(options.limits);
  validateAstVersion(ast);
  const table = findTable(manifest, ast.table);
  const columns = visibleColumns(table);
  const parameters: StorageValue[] = [];
  const cost = { selectedColumns: 0, filterNodes: 0, booleanGroups: 0, orderTerms: 0 };
  const select = fixedProjection ?? compileProjection(ast, columns, cost);
  if (fixedProjection !== undefined) {
    cost.selectedColumns = 1;
  }
  const filter = compileGroup(ast.filter, columns, parameters, limits, cost);
  const where = filter.length === 0 ? "" : ` WHERE ${filter}`;
  const order = compileOrder(ast, columns, cost);
  const pagination = compilePagination(ast, parameters);

  if (parameters.length > limits.maxParameters) {
    throw limitExceeded(`Query uses more than ${limits.maxParameters} bound parameters.`);
  }

  return Object.freeze({
    formatVersion: sqliteCompilerFormatVersion,
    sql: `SELECT ${select} FROM ${quoteIdentifier(table.name)}${where}${order}${pagination}`,
    parameters: Object.freeze(parameters),
    cost: Object.freeze({ ...cost, parameterCount: parameters.length }),
  });
}

function compileProjection(
  ast: QueryAst,
  columns: ReadonlySet<string>,
  cost: { selectedColumns: number },
): string {
  if (ast.select.kind === "all") {
    const selected = [...columns];
    cost.selectedColumns = selected.length;
    return selected.map(quoteIdentifier).join(", ");
  }

  if (
    ast.select.kind !== "columns" ||
    !Array.isArray(ast.select.columns) ||
    ast.select.columns.length === 0
  ) {
    throw malformed("select must be all or a non-empty column list.");
  }

  for (const column of ast.select.columns) {
    validateColumn(column, columns);
  }

  cost.selectedColumns = ast.select.columns.length;
  return ast.select.columns.map(quoteIdentifier).join(", ");
}

function compileMutationInput(
  input: MutationInput,
  columns: ReadonlySet<string>,
  description: string,
): Readonly<{ columns: readonly string[]; parameters: readonly StorageValue[] }> {
  const entries = Object.entries(input);
  if (entries.length === 0 && description !== "Mutation values") {
    throw malformed(`${description} must not be empty.`);
  }
  for (const [column, value] of entries) {
    validateColumn(column, columns);
    if (typeof value !== "string" && typeof value !== "number" && value !== null) {
      throw malformed(`${description} contains an unsupported value.`);
    }
  }
  return Object.freeze({
    columns: Object.freeze(entries.map(([column]) => column)),
    parameters: Object.freeze(entries.map(([, value]) => value)),
  });
}

function compilePrimaryKeyWhere(columns: readonly string[]): string {
  if (columns.length === 0) {
    throw malformed("Mutation primary key must not be empty.");
  }
  return columns.map((column) => `${quoteIdentifier(column)} = ?`).join(" AND ");
}

function freezeMutation(sql: string, parameters: readonly StorageValue[]): CompiledMutation {
  return Object.freeze({
    formatVersion: sqliteCompilerFormatVersion,
    sql,
    parameters: Object.freeze([...parameters]),
  });
}

function compileGroup(
  group: BooleanGroup,
  columns: ReadonlySet<string>,
  parameters: StorageValue[],
  limits: SQLiteCompilerLimits,
  cost: { filterNodes: number; booleanGroups: number },
): string {
  if (
    group.kind !== "group" ||
    (group.operator !== "and" && group.operator !== "or") ||
    typeof group.negated !== "boolean" ||
    !Array.isArray(group.terms)
  ) {
    throw malformed("Boolean group has an invalid shape.");
  }

  cost.booleanGroups += 1;
  if (group.terms.length === 0) {
    return "";
  }

  const expression = group.terms
    .map((term) => compileExpression(term, columns, parameters, limits, cost))
    .join(group.operator === "and" ? " AND " : " OR ");
  const wrapped = `(${expression})`;
  return group.negated ? `NOT ${wrapped}` : wrapped;
}

function compileExpression(
  expression: FilterExpression,
  columns: ReadonlySet<string>,
  parameters: StorageValue[],
  limits: SQLiteCompilerLimits,
  cost: { filterNodes: number; booleanGroups: number },
): string {
  if (expression.kind === "group") {
    const compiled = compileGroup(expression, columns, parameters, limits, cost);
    if (compiled.length === 0) {
      throw malformed("Nested boolean groups must contain at least one condition.");
    }
    return compiled;
  }

  if (expression.kind !== "filter") {
    throw malformed("Filter expression has an invalid kind.");
  }

  return compileFilter(expression, columns, parameters, limits, cost);
}

function compileFilter(
  filter: Filter,
  columns: ReadonlySet<string>,
  parameters: StorageValue[],
  limits: SQLiteCompilerLimits,
  cost: { filterNodes: number },
): string {
  if (typeof filter.negated !== "boolean") {
    throw malformed("Filter negated flag must be boolean.");
  }

  validateColumn(filter.column, columns);
  const column = quoteIdentifier(filter.column);
  let expression: string;

  switch (filter.operator) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof filter.value !== "string") {
        throw malformed(`${filter.operator} requires a scalar string value.`);
      }
      parameters.push(filter.value);
      expression = `${column} ${comparisonOperator(filter.operator)} ?`;
      break;
    }
    case "in": {
      if (!Array.isArray(filter.value) || filter.value.length === 0) {
        throw malformed("in requires a non-empty string list.");
      }
      if (filter.value.length > limits.maxListSize) {
        throw limitExceeded(`in list exceeds the list limit of ${limits.maxListSize}.`);
      }
      if (filter.value.some((value) => typeof value !== "string")) {
        throw malformed("in requires a string list.");
      }
      parameters.push(...filter.value);
      expression = `${column} IN (${filter.value.map(() => "?").join(", ")})`;
      break;
    }
    case "is":
      expression = compileIsExpression(column, filter.value);
      break;
    default:
      throw unsupported(`Filter operator "${String(filter.operator)}" is not supported.`);
  }

  cost.filterNodes += 1;
  const wrapped = `(${expression})`;
  return filter.negated ? `NOT ${wrapped}` : wrapped;
}

function compileIsExpression(column: string, value: Filter["value"]): string {
  switch (value) {
    case "null":
    case "unknown":
      return `${column} IS NULL`;
    case "not_null":
      return `${column} IS NOT NULL`;
    case "true":
      return `${column} IS TRUE`;
    case "false":
      return `${column} IS FALSE`;
    default:
      throw malformed("is requires null, not_null, true, false or unknown.");
  }
}

function compileOrder(
  ast: QueryAst,
  columns: ReadonlySet<string>,
  cost: { orderTerms: number },
): string {
  if (!Array.isArray(ast.order)) {
    throw malformed("order must be an array.");
  }
  if (ast.order.length === 0) {
    return "";
  }

  const terms = ast.order.map((term) => {
    validateColumn(term.column, columns);
    if (term.direction !== "asc" && term.direction !== "desc") {
      throw malformed("Order direction must be asc or desc.");
    }
    if (term.nulls !== null && term.nulls !== "first" && term.nulls !== "last") {
      throw malformed("Order null positioning must be first, last or null.");
    }

    cost.orderTerms += 1;
    const nulls = term.nulls === null ? "" : ` NULLS ${term.nulls.toUpperCase()}`;
    return `${quoteIdentifier(term.column)} ${term.direction.toUpperCase()}${nulls}`;
  });

  return ` ORDER BY ${terms.join(", ")}`;
}

function compilePagination(ast: QueryAst, parameters: StorageValue[]): string {
  if (ast.limit !== null && !isNonNegativeSafeInteger(ast.limit)) {
    throw malformed("limit must be a non-negative safe integer or null.");
  }
  if (!isNonNegativeSafeInteger(ast.offset)) {
    throw malformed("offset must be a non-negative safe integer.");
  }
  if (ast.limit === null && ast.offset === 0) {
    return "";
  }

  parameters.push(ast.limit ?? -1);
  if (ast.offset === 0) {
    return " LIMIT ?";
  }

  parameters.push(ast.offset);
  return " LIMIT ? OFFSET ?";
}

function findTable(manifest: SchemaManifest, tableName: string): SchemaTable {
  if (!isRecord(manifest) || !Array.isArray(manifest.tables)) {
    throw malformed("Schema manifest has an invalid shape.");
  }
  if (typeof tableName !== "string") {
    throw malformed("Query table must be a string.");
  }

  const table = manifest.tables.find((candidate) => candidate.name === tableName);
  if (table === undefined) {
    throw validation(`Table "${tableName}" is not exposed by the schema manifest.`);
  }
  return table;
}

function visibleColumns(table: SchemaTable): ReadonlySet<string> {
  if (!Array.isArray(table.columns)) {
    throw malformed(`Table "${table.name}" has invalid column metadata.`);
  }
  return new Set(
    table.columns
      .filter((column) => column.hidden === "none")
      .map((column) => {
        if (typeof column.name !== "string") {
          throw malformed(`Table "${table.name}" has an invalid column name.`);
        }
        return column.name;
      }),
  );
}

function validateAstVersion(ast: QueryAst): void {
  if (!isRecord(ast) || ast.formatVersion !== queryAstFormatVersion) {
    throw unsupported(`Query AST format version ${String(ast?.formatVersion)} is not supported.`);
  }
}

function validateColumn(column: unknown, columns: ReadonlySet<string>): asserts column is string {
  if (typeof column !== "string" || !columns.has(column)) {
    throw validation(`Column "${String(column)}" is not exposed by the schema manifest.`);
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function comparisonOperator(operator: Filter["operator"]): string {
  switch (operator) {
    case "eq":
      return "=";
    case "neq":
      return "<>";
    case "gt":
      return ">";
    case "gte":
      return ">=";
    case "lt":
      return "<";
    case "lte":
      return "<=";
    default:
      throw unsupported(`Filter operator "${operator}" is not supported.`);
  }
}

function resolveLimits(overrides: Partial<SQLiteCompilerLimits> | undefined): SQLiteCompilerLimits {
  const limits = { ...defaultLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!isNonNegativeSafeInteger(value) || value === 0) {
      throw validation(`Compiler limit "${name}" must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function malformed(message: string): SQLiteCompilerError {
  return new SQLiteCompilerError("SQLITE_COMPILER_MALFORMED", message);
}

function unsupported(message: string): SQLiteCompilerError {
  return new SQLiteCompilerError("SQLITE_COMPILER_UNSUPPORTED", message);
}

function validation(message: string): SQLiteCompilerError {
  return new SQLiteCompilerError("SQLITE_COMPILER_VALIDATION", message);
}

function limitExceeded(message: string): SQLiteCompilerError {
  return new SQLiteCompilerError("SQLITE_COMPILER_LIMIT", message);
}
