import type { SchemaManifest, SchemaTable } from "@mekka/schema-manifest";

export const queryAstFormatVersion = 1;

export type QueryAst = Readonly<{
  formatVersion: typeof queryAstFormatVersion;
  table: string;
  select: Select;
  filter: BooleanGroup;
  order: readonly OrderTerm[];
  limit: number | null;
  offset: number;
}>;

export type MutationAction = "insert" | "update" | "delete" | "upsert";

export type MutationValue = string | number | null;
export type MutationInput = Readonly<Record<string, MutationValue>>;

export type MutationAst = Readonly<{
  formatVersion: typeof queryAstFormatVersion;
  action: MutationAction;
  table: string;
  values: MutationInput;
  primaryKey: MutationInput | null;
}>;

export type Select =
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "columns"; columns: readonly string[] }>;

export type BooleanGroup = Readonly<{
  kind: "group";
  operator: "and" | "or";
  negated: boolean;
  terms: readonly FilterExpression[];
}>;

export type FilterExpression = BooleanGroup | Filter;

export type Filter = Readonly<{
  kind: "filter";
  column: string;
  operator: FilterOperator;
  negated: boolean;
  value: string | readonly string[] | IsValue;
}>;

export type FilterOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is";
export type IsValue = "null" | "not_null" | "true" | "false" | "unknown";

export type OrderTerm = Readonly<{
  column: string;
  direction: "asc" | "desc";
  nulls: "first" | "last" | null;
}>;

export type QueryParserLimits = Readonly<{
  maxDecodedLength: number;
  maxDepth: number;
  maxNodes: number;
  maxListSize: number;
}>;

export type ParseQueryOptions = Readonly<{
  limits?: Partial<QueryParserLimits>;
}>;

export type QueryAstErrorCode =
  | "QUERY_AST_MALFORMED"
  | "QUERY_AST_UNSUPPORTED"
  | "QUERY_AST_VALIDATION"
  | "QUERY_AST_LIMIT";

export class QueryAstError extends Error {
  readonly code: QueryAstErrorCode;

  constructor(code: QueryAstErrorCode, message: string) {
    super(message);
    this.name = "QueryAstError";
    this.code = code;
  }
}

const defaultLimits: QueryParserLimits = Object.freeze({
  maxDecodedLength: 8_192,
  maxDepth: 8,
  maxNodes: 100,
  maxListSize: 100,
});

const allSelect: Select = Object.freeze({ kind: "all" });

export function parseQuery(
  manifest: SchemaManifest,
  tableName: string,
  query: string,
  options: ParseQueryOptions = {},
): QueryAst {
  const limits = resolveLimits(options.limits);
  const table = findTable(manifest, tableName);
  const columns = new Set(
    table.columns.filter((column) => column.hidden === "none").map((column) => column.name),
  );
  const parameters = decodeQuery(query, limits.maxDecodedLength);
  const values = new Map<string, string>();
  const filters: FilterExpression[] = [];
  const order: OrderTerm[] = [];
  let nodes = 0;

  for (const parameter of parameters) {
    if (isReserved(parameter.key)) {
      if (values.has(parameter.key)) {
        throw malformed(`Query parameter "${parameter.key}" must not be repeated.`);
      }

      values.set(parameter.key, parameter.value);
      continue;
    }

    if (
      parameter.key === "and" ||
      parameter.key === "or" ||
      parameter.key === "not.and" ||
      parameter.key === "not.or"
    ) {
      filters.push(
        parseGroupParameter(parameter.key, parameter.value, columns, limits, () =>
          incrementNodes(limits, ++nodes),
        ),
      );
      continue;
    }

    if (parameter.key.includes(".")) {
      throw unsupported("Embedded resource query parameters are not supported.");
    }

    filters.push(
      parseFilter(parameter.key, parameter.value, columns, limits, () =>
        incrementNodes(limits, ++nodes),
      ),
    );
  }

  const select = parseSelect(values.get("select"), columns, limits, () =>
    incrementNodes(limits, ++nodes),
  );
  parseOrder(values.get("order"), columns, order, limits, () => incrementNodes(limits, ++nodes));
  const limit = parsePagination(values.get("limit"), "limit");
  const offset = parsePagination(values.get("offset"), "offset") ?? 0;

  return Object.freeze({
    formatVersion: queryAstFormatVersion,
    table: table.name,
    select,
    filter: freezeGroup("and", false, filters),
    order: Object.freeze(order),
    limit,
    offset,
  });
}

export function createMutationAst(
  manifest: SchemaManifest,
  action: MutationAction,
  tableName: string,
  values: MutationInput,
  primaryKey: MutationInput | null = null,
): MutationAst {
  if (action !== "insert" && action !== "update" && action !== "delete" && action !== "upsert") {
    throw validation(`Mutation action "${String(action)}" is not supported.`);
  }

  const table = findTable(manifest, tableName);
  const visible = new Set(
    table.columns.filter((column) => column.hidden === "none").map((column) => column.name),
  );
  validateMutationInput(values, visible, "Mutation values");
  if (primaryKey !== null) {
    validateMutationInput(primaryKey, visible, "Mutation primary key");
  }

  if (action === "delete" && Object.keys(values).length !== 0) {
    throw validation("Delete mutations must not include values.");
  }
  if (action !== "delete" && Object.keys(values).length === 0) {
    throw validation("Mutation values must not be empty.");
  }
  if ((action === "update" || action === "delete") && primaryKey === null) {
    throw validation(`${action} mutations require a primary key.`);
  }
  if (action === "upsert" && primaryKey === null) {
    throw validation("Upsert mutations require a primary key.");
  }

  return Object.freeze({
    formatVersion: queryAstFormatVersion,
    action,
    table: table.name,
    values: Object.freeze({ ...values }),
    primaryKey: primaryKey === null ? null : Object.freeze({ ...primaryKey }),
  });
}

function decodeQuery(
  query: string,
  maxDecodedLength: number,
): readonly { key: string; value: string }[] {
  const source = query.startsWith("?") ? query.slice(1) : query;

  if (source.length === 0) {
    return Object.freeze([]);
  }

  const parameters: { key: string; value: string }[] = [];
  let decodedLength = 0;

  for (const segment of source.split("&")) {
    const delimiter = segment.indexOf("=");
    const key = decodeComponent(delimiter === -1 ? segment : segment.slice(0, delimiter));
    const value = decodeComponent(delimiter === -1 ? "" : segment.slice(delimiter + 1));
    decodedLength += key.length + value.length + 1;

    if (decodedLength > maxDecodedLength) {
      throw limitExceeded(`Decoded query length exceeds ${maxDecodedLength} characters.`);
    }

    if (key.length === 0) {
      throw malformed("Query parameter name must not be empty.");
    }

    parameters.push(Object.freeze({ key, value }));
  }

  return Object.freeze(parameters);
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    throw malformed("Query contains invalid percent encoding.");
  }
}

function parseSelect(
  value: string | undefined,
  columns: ReadonlySet<string>,
  limits: QueryParserLimits,
  countNode: () => void,
): Select {
  if (value === undefined || value === "*") {
    return allSelect;
  }

  if (value.includes("(") || value.includes(")") || value.includes(":")) {
    throw unsupported("Nested selects, aliases and embedding are not supported.");
  }

  const selected = value.split(",");

  if (selected.length === 0 || selected.some((column) => column.length === 0)) {
    throw malformed("select must contain one or more column names.");
  }

  if (selected.length > limits.maxListSize) {
    throw limitExceeded(`select exceeds the list limit of ${limits.maxListSize}.`);
  }

  for (const column of selected) {
    validateColumn(column, columns);
    countNode();
  }

  return Object.freeze({ kind: "columns", columns: Object.freeze(selected) });
}

function parseOrder(
  value: string | undefined,
  columns: ReadonlySet<string>,
  order: OrderTerm[],
  limits: QueryParserLimits,
  countNode: () => void,
): void {
  if (value === undefined) {
    return;
  }

  const terms = value.split(",");

  if (terms.length > limits.maxListSize) {
    throw limitExceeded(`order exceeds the list limit of ${limits.maxListSize}.`);
  }

  for (const term of terms) {
    const parts = term.split(".");
    const column = parts[0];
    const direction = parts[1] ?? "asc";
    const nullsValue = parts[2];

    if (column === undefined || column.length === 0 || parts.length > 3) {
      throw malformed("order term must be column[.asc|desc][.nullsfirst|nullslast].");
    }

    validateColumn(column, columns);

    if (direction !== "asc" && direction !== "desc") {
      throw unsupported(`Order direction "${direction}" is not supported.`);
    }

    let nulls: OrderTerm["nulls"] = null;
    if (nullsValue !== undefined) {
      if (nullsValue === "nullsfirst") {
        nulls = "first";
      } else if (nullsValue === "nullslast") {
        nulls = "last";
      } else {
        throw unsupported(`Order null positioning "${nullsValue}" is not supported.`);
      }
    }

    countNode();
    order.push(Object.freeze({ column, direction, nulls }));
  }
}

function parseGroupParameter(
  key: string,
  value: string,
  columns: ReadonlySet<string>,
  limits: QueryParserLimits,
  countNode: () => void,
): BooleanGroup {
  const negated = key.startsWith("not.");
  const operator = key.endsWith("and") ? "and" : "or";

  return new LogicParser(value, columns, limits, countNode).parseGroup(operator, negated);
}

function parseFilter(
  column: string,
  value: string,
  columns: ReadonlySet<string>,
  limits: QueryParserLimits,
  countNode: () => void,
): Filter {
  validateColumn(column, columns);
  const parser = new LogicParser(value, columns, limits, countNode);
  const filter = parser.parseFilter(column);
  parser.expectEnd();
  return filter;
}

class LogicParser {
  #index = 0;

  constructor(
    readonly input: string,
    readonly columns: ReadonlySet<string>,
    readonly limits: QueryParserLimits,
    readonly countNode: () => void,
  ) {}

  parseGroup(operator: "and" | "or", negated: boolean): BooleanGroup {
    const group = this.parseGroupAt(operator, negated, 1);
    this.expectEnd();
    return group;
  }

  parseFilter(column: string, stopAtGroupDelimiter = false): Filter {
    if (this.peek() === ".") {
      this.#index += 1;
    }
    const negated = this.consumeWord("not.");
    const operator = this.readUntil(".");

    if (operator === "in") {
      this.consume(".");
      const value = this.parseList();
      this.countNode();
      return freezeFilter(column, operator, negated, value);
    }

    if (operator === "is") {
      this.consume(".");
      const value = this.readScalarValue(stopAtGroupDelimiter);
      if (!isIsValue(value)) {
        throw validation(
          `is accepts only null, not_null, true, false or unknown; received "${value}".`,
        );
      }

      this.countNode();
      return freezeFilter(column, operator, negated, value);
    }

    if (!isComparisonOperator(operator)) {
      throw unsupported(`Filter operator "${operator}" is not supported.`);
    }

    this.consume(".");
    const value = this.readScalarValue(stopAtGroupDelimiter);
    this.countNode();
    return freezeFilter(column, operator, negated, value);
  }

  private parseGroupAt(operator: "and" | "or", negated: boolean, depth: number): BooleanGroup {
    if (depth > this.limits.maxDepth) {
      throw limitExceeded(`Boolean group depth exceeds ${this.limits.maxDepth}.`);
    }

    this.consume("(");
    const terms: FilterExpression[] = [];

    while (true) {
      if (this.peek() === ")") {
        if (terms.length === 0) {
          throw malformed("Boolean groups must contain at least one condition.");
        }
        this.#index += 1;
        break;
      }

      terms.push(this.parseExpression(depth));
      const next = this.peek();
      if (next === ",") {
        this.#index += 1;
        continue;
      }
      if (next === ")") {
        continue;
      }
      throw malformed("Boolean group terms must be separated by commas.");
    }

    this.countNode();
    return freezeGroup(operator, negated, terms);
  }

  private parseExpression(depth: number): FilterExpression {
    const negated = this.consumeWord("not.");
    const start = this.#index;
    const word = this.readUntil(".", "(");

    if ((word === "and" || word === "or") && this.peek() === "(") {
      return this.parseGroupAt(word, negated, depth + 1);
    }

    if (word.length === 0) {
      throw malformed("Boolean group contains an empty condition.");
    }

    this.#index = start;
    const column = this.readUntil(".");
    validateColumn(column, this.columns);
    const filter = this.parseFilter(column, true);
    return negated ? Object.freeze({ ...filter, negated: !filter.negated }) : filter;
  }

  private parseList(): readonly string[] {
    this.consume("(");
    const values: string[] = [];

    while (true) {
      if (values.length >= this.limits.maxListSize) {
        throw limitExceeded(`in list exceeds the list limit of ${this.limits.maxListSize}.`);
      }

      values.push(this.parseListValue());
      const next = this.peek();
      if (next === ",") {
        this.#index += 1;
        continue;
      }
      if (next === ")") {
        this.#index += 1;
        break;
      }
      throw malformed("in list values must be separated by commas.");
    }

    if (values.length === 0) {
      throw malformed("in requires at least one value.");
    }

    return Object.freeze(values);
  }

  private parseListValue(): string {
    if (this.peek() === '"') {
      this.#index += 1;
      let value = "";

      while (this.#index < this.input.length) {
        const character = this.input[this.#index] as string;
        this.#index += 1;
        if (character === '"') {
          return value;
        }
        if (character === "\\") {
          const escaped = this.input[this.#index];
          if (escaped === undefined) {
            throw malformed("Quoted in value ends with an escape character.");
          }
          value += escaped;
          this.#index += 1;
          continue;
        }
        value += character;
      }

      throw malformed("Quoted in value is not terminated.");
    }

    const start = this.#index;
    while (this.#index < this.input.length && this.peek() !== "," && this.peek() !== ")") {
      this.#index += 1;
    }
    const value = this.input.slice(start, this.#index).trim();
    if (value.length === 0) {
      throw malformed("in values must not be empty.");
    }
    return value;
  }

  private consume(value: string): void {
    if (!this.input.startsWith(value, this.#index)) {
      throw malformed(`Expected "${value}" in query expression.`);
    }
    this.#index += value.length;
  }

  private consumeWord(value: string): boolean {
    if (!this.input.startsWith(value, this.#index)) {
      return false;
    }
    this.#index += value.length;
    return true;
  }

  private readUntil(...delimiters: string[]): string {
    const start = this.#index;
    while (
      this.#index < this.input.length &&
      !delimiters.includes(this.input[this.#index] as string)
    ) {
      this.#index += 1;
    }
    return this.input.slice(start, this.#index).trim();
  }

  private readScalarValue(stopAtGroupDelimiter: boolean): string {
    if (!stopAtGroupDelimiter) {
      const value = this.input.slice(this.#index);
      this.#index = this.input.length;
      return value;
    }

    const start = this.#index;
    while (this.#index < this.input.length && this.peek() !== "," && this.peek() !== ")") {
      this.#index += 1;
    }
    return this.input.slice(start, this.#index);
  }

  private peek(): string | undefined {
    return this.input[this.#index];
  }

  expectEnd(): void {
    if (this.#index !== this.input.length) {
      throw malformed("Query expression contains trailing input.");
    }
  }
}

function parsePagination(value: string | undefined, name: "limit" | "offset"): number | null {
  if (value === undefined) {
    return null;
  }
  if (!isDecimalInteger(value)) {
    throw validation(`${name} must be a non-negative safe integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw validation(`${name} must be a non-negative safe integer.`);
  }
  return parsed;
}

function findTable(manifest: SchemaManifest, name: string): SchemaTable {
  const table = manifest.tables.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw validation(`Table "${name}" is not exposed by the schema manifest.`);
  }
  return table;
}

function validateColumn(column: string, columns: ReadonlySet<string>): void {
  if (!columns.has(column)) {
    throw validation(`Column "${column}" is not exposed by the schema manifest.`);
  }
}

function validateMutationInput(
  input: MutationInput,
  columns: ReadonlySet<string>,
  description: string,
): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validation(`${description} must be an object.`);
  }

  for (const [column, value] of Object.entries(input)) {
    validateColumn(column, columns);
    if (typeof value !== "string" && typeof value !== "number" && value !== null) {
      throw validation(`${description} contains an unsupported value for "${column}".`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw validation(`${description} contains a non-finite number for "${column}".`);
    }
  }
}

function resolveLimits(overrides: Partial<QueryParserLimits> | undefined): QueryParserLimits {
  const limits = { ...defaultLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw validation(`Parser limit "${name}" must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

function freezeGroup(
  operator: BooleanGroup["operator"],
  negated: boolean,
  terms: readonly FilterExpression[],
): BooleanGroup {
  return Object.freeze({ kind: "group", operator, negated, terms: Object.freeze(terms) });
}

function freezeFilter(
  column: string,
  operator: FilterOperator,
  negated: boolean,
  value: Filter["value"],
): Filter {
  return Object.freeze({ kind: "filter", column, operator, negated, value });
}

function incrementNodes(limits: QueryParserLimits, count: number): void {
  if (count > limits.maxNodes) {
    throw limitExceeded(`Query AST exceeds the node limit of ${limits.maxNodes}.`);
  }
}

function isReserved(key: string): key is "select" | "order" | "limit" | "offset" {
  return key === "select" || key === "order" || key === "limit" || key === "offset";
}

function isComparisonOperator(value: string): value is Exclude<FilterOperator, "in" | "is"> {
  return (
    value === "eq" ||
    value === "neq" ||
    value === "gt" ||
    value === "gte" ||
    value === "lt" ||
    value === "lte"
  );
}

function isIsValue(value: string): value is IsValue {
  return (
    value === "null" ||
    value === "not_null" ||
    value === "true" ||
    value === "false" ||
    value === "unknown"
  );
}

function isDecimalInteger(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (const character of value) {
    if (character < "0" || character > "9") {
      return false;
    }
  }
  return true;
}

function malformed(message: string): QueryAstError {
  return new QueryAstError("QUERY_AST_MALFORMED", message);
}

function unsupported(message: string): QueryAstError {
  return new QueryAstError("QUERY_AST_UNSUPPORTED", message);
}

function validation(message: string): QueryAstError {
  return new QueryAstError("QUERY_AST_VALIDATION", message);
}

function limitExceeded(message: string): QueryAstError {
  return new QueryAstError("QUERY_AST_LIMIT", message);
}
