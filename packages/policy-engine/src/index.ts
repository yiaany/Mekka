import type { TenantContext } from "@mekka/protocol";
import {
  queryAstFormatVersion,
  type BooleanGroup,
  type FilterExpression,
  type QueryAst,
} from "@mekka/query-ast";
import type { SchemaManifest, SchemaTable } from "@mekka/schema-manifest";
import type { StorageValue } from "@mekka/storage-core";

export const policyFormatVersion = 1;

export type PolicyAction = "select" | "insert" | "update" | "delete";

export type PolicyDocument = Readonly<{
  formatVersion: typeof policyFormatVersion;
  tables: readonly TablePolicy[];
}>;

export type TablePolicy = Readonly<{
  table: string;
  rules: readonly PolicyRule[];
}>;

export type PolicyRule = Readonly<{
  name: string;
  action: PolicyAction;
  using?: PolicyPredicate;
  check?: PolicyPredicate;
  fields?: FieldPolicy;
}>;

export type FieldPolicy = Readonly<{
  allow: readonly string[];
  deny: readonly string[];
}>;

export type PolicyPredicate = PolicyGroup | PolicyComparison;

export type PolicyGroup = Readonly<{
  kind: "group";
  operator: "and" | "or";
  negated: boolean;
  terms: readonly PolicyPredicate[];
}>;

export type PolicyComparison = Readonly<{
  kind: "comparison";
  column: string;
  operator: "eq" | "neq";
  value: PolicyValue;
}>;

export type PolicyValue =
  | Readonly<{ kind: "actor_id" }>
  | Readonly<{ kind: "literal"; value: string }>;

export type PolicyRow = Readonly<Record<string, StorageValue>>;
export type PolicyInput = Readonly<Record<string, StorageValue>>;

export type PolicySimulationRequest = Readonly<{
  context: TenantContext;
  action: PolicyAction;
  table: string;
  row?: PolicyRow;
  input?: PolicyInput;
  fields?: readonly string[];
}>;

export type PolicyDecision = Readonly<{
  allowed: boolean;
  allowedFields: readonly string[];
  matchedRules: readonly string[];
}>;

export type PolicyRewrite = Readonly<{
  ast: QueryAst;
  allowedFields: readonly string[];
  matchedRules: readonly string[];
}>;

export type PolicyErrorCode =
  | "POLICY_MALFORMED"
  | "POLICY_VALIDATION"
  | "POLICY_FORBIDDEN"
  | "POLICY_UNSUPPORTED";

export class PolicyError extends Error {
  readonly code: PolicyErrorCode;

  constructor(code: PolicyErrorCode, message: string) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

export function simulatePolicy(
  manifest: SchemaManifest,
  document: PolicyDocument,
  request: PolicySimulationRequest,
): PolicyDecision {
  const table = resolveTable(manifest, request.table);
  const rules = resolveRules(document, table, request.action);
  const fields = resolveRequestedFields(request.fields, request.action, table, request.input);
  const matchedRules = rules.filter((rule) =>
    ruleMatches(rule, request.context, request.row, request.input),
  );
  const allowedFields = allowedFieldsForRules(matchedRules, fields, request.action);
  const allowed = matchedRules.length > 0 && fields.every((field) => allowedFields.includes(field));

  return freezeDecision(
    allowed,
    allowedFields,
    matchedRules.map((rule) => rule.name),
  );
}

export function rewritePolicyQuery(
  manifest: SchemaManifest,
  document: PolicyDocument,
  context: TenantContext,
  action: "select" | "update" | "delete",
  ast: QueryAst,
): PolicyRewrite {
  if (ast.formatVersion !== queryAstFormatVersion) {
    throw unsupported(`Query AST format version ${String(ast.formatVersion)} is not supported.`);
  }

  const table = resolveTable(manifest, ast.table);
  const rules = resolveRules(document, table, action);
  const visible = visibleColumns(table);

  if (rules.length === 0) {
    throw forbidden(`No ${action} policy exists for table "${table.name}".`);
  }

  const policyFields = allowedFieldsForRules(rules, [...visible], action);
  const requested = ast.select.kind === "all" ? [...visible] : [...ast.select.columns];
  if (action === "select" && requested.some((field) => !policyFields.includes(field))) {
    throw forbidden("Selected fields are not permitted by policy.");
  }

  const policyTerms = rules.map((rule) => compilePredicate(rule.using, context));
  const policyFilter = freezeGroup("or", false, policyTerms);
  const filter =
    ast.filter.terms.length === 0
      ? policyFilter
      : freezeGroup("and", false, [ast.filter, policyFilter]);
  const select =
    action === "select" && ast.select.kind === "all"
      ? Object.freeze({ kind: "columns" as const, columns: Object.freeze(policyFields) })
      : action === "select"
        ? ast.select
        : Object.freeze({ kind: "columns" as const, columns: Object.freeze([...visible]) });

  return Object.freeze({
    ast: Object.freeze({ ...ast, select, filter }),
    allowedFields: Object.freeze(policyFields),
    matchedRules: Object.freeze(rules.map((rule) => rule.name)),
  });
}

function resolveRules(
  document: PolicyDocument,
  table: SchemaTable,
  action: PolicyAction,
): readonly PolicyRule[] {
  validateDocument(document);
  const tablePolicy = document.tables.find((candidate) => candidate.table === table.name);
  if (tablePolicy === undefined) {
    return Object.freeze([]);
  }

  const visible = visibleColumns(table);
  const rules = tablePolicy.rules.filter((rule) => rule.action === action);
  for (const rule of rules) {
    validateRule(rule, visible);
  }
  return Object.freeze(rules);
}

function ruleMatches(
  rule: PolicyRule,
  context: TenantContext,
  row: PolicyRow | undefined,
  input: PolicyInput | undefined,
): boolean {
  if ((rule.action === "select" || rule.action === "delete") && row === undefined) {
    return false;
  }
  if (rule.action === "insert" && input === undefined) {
    return false;
  }
  if (rule.action === "update" && (row === undefined || input === undefined)) {
    return false;
  }

  const existingAllowed =
    rule.using === undefined || evaluatePredicate(rule.using, context, row ?? input ?? {});
  const newValues = row === undefined ? (input ?? {}) : { ...row, ...input };
  const newAllowed = rule.check === undefined || evaluatePredicate(rule.check, context, newValues);
  return existingAllowed && newAllowed;
}

function evaluatePredicate(
  predicate: PolicyPredicate,
  context: TenantContext,
  values: PolicyRow | PolicyInput,
): boolean {
  if (predicate.kind === "group") {
    const result =
      predicate.operator === "and"
        ? predicate.terms.every((term) => evaluatePredicate(term, context, values))
        : predicate.terms.some((term) => evaluatePredicate(term, context, values));
    return predicate.negated ? !result : result;
  }

  const expected = predicate.value.kind === "actor_id" ? context.actor.id : predicate.value.value;
  const actual = values[predicate.column];
  const equal = actual === expected;
  return predicate.operator === "eq" ? equal : !equal;
}

function compilePredicate(
  predicate: PolicyPredicate | undefined,
  context: TenantContext,
): FilterExpression {
  if (predicate === undefined) {
    throw malformed("A row predicate is required for query rewriting.");
  }
  if (predicate.kind === "group") {
    return freezeGroup(
      predicate.operator,
      predicate.negated,
      predicate.terms.map((term) => compilePredicate(term, context)),
    );
  }

  return Object.freeze({
    kind: "filter" as const,
    column: predicate.column,
    operator: predicate.operator === "eq" ? "eq" : "neq",
    negated: false,
    value: predicate.value.kind === "actor_id" ? context.actor.id : predicate.value.value,
  });
}

function resolveRequestedFields(
  requested: readonly string[] | undefined,
  action: PolicyAction,
  table: SchemaTable,
  input: PolicyInput | undefined,
): readonly string[] {
  if (action === "delete") {
    return Object.freeze([]);
  }
  const fields =
    action === "select"
      ? (requested ?? [...visibleColumns(table)])
      : resolveMutationFields(requested, input);
  const visible = visibleColumns(table);
  for (const field of fields) {
    if (!visible.has(field)) {
      throw validation(`Field "${field}" is not exposed by the schema manifest.`);
    }
  }
  return Object.freeze([...fields]);
}

function resolveMutationFields(
  requested: readonly string[] | undefined,
  input: PolicyInput | undefined,
): readonly string[] {
  if (input === undefined) {
    return Object.freeze([]);
  }

  const fields = Object.keys(input);
  if (
    requested !== undefined &&
    (requested.length !== fields.length || requested.some((field) => !fields.includes(field)))
  ) {
    throw validation("Mutation fields must exactly match the input keys.");
  }
  return Object.freeze(fields);
}

function allowedFieldsForRules(
  rules: readonly PolicyRule[],
  requested: readonly string[],
  action: PolicyAction,
): readonly string[] {
  if (action === "delete") {
    return Object.freeze([]);
  }

  const allowed = new Set<string>();
  const denied = new Set<string>();
  for (const rule of rules) {
    if (rule.fields === undefined) {
      continue;
    }
    for (const field of rule.fields.allow) {
      allowed.add(field);
    }
    for (const field of rule.fields.deny) {
      denied.add(field);
    }
  }
  return Object.freeze(requested.filter((field) => allowed.has(field) && !denied.has(field)));
}

function validateDocument(document: PolicyDocument): void {
  if (
    !isRecord(document) ||
    document.formatVersion !== policyFormatVersion ||
    !Array.isArray(document.tables)
  ) {
    throw malformed("Policy document has an invalid shape or format version.");
  }
}

function validateRule(rule: PolicyRule, visible: ReadonlySet<string>): void {
  if (
    !isRecord(rule) ||
    typeof rule.name !== "string" ||
    rule.name.length === 0 ||
    !isAction(rule.action)
  ) {
    throw malformed("Policy rule has an invalid shape.");
  }
  if (
    (rule.action === "select" || rule.action === "update" || rule.action === "delete") &&
    rule.using === undefined
  ) {
    throw malformed(`Policy rule "${rule.name}" requires a using predicate.`);
  }
  if ((rule.action === "insert" || rule.action === "update") && rule.check === undefined) {
    throw malformed(`Policy rule "${rule.name}" requires a check predicate.`);
  }
  if (rule.using !== undefined) {
    validatePredicate(rule.using, visible);
  }
  if (rule.check !== undefined) {
    validatePredicate(rule.check, visible);
  }
  if (rule.fields !== undefined) {
    if (!Array.isArray(rule.fields.allow) || !Array.isArray(rule.fields.deny)) {
      throw malformed(`Policy rule "${rule.name}" has invalid field rules.`);
    }
    for (const field of [...rule.fields.allow, ...rule.fields.deny]) {
      if (typeof field !== "string" || !visible.has(field)) {
        throw validation(`Field "${String(field)}" is not exposed by the schema manifest.`);
      }
    }
  }
}

function validatePredicate(predicate: PolicyPredicate, visible: ReadonlySet<string>): void {
  if (!isRecord(predicate)) {
    throw malformed("Policy predicate has an invalid shape.");
  }
  if (predicate.kind === "group") {
    if (
      (predicate.operator !== "and" && predicate.operator !== "or") ||
      typeof predicate.negated !== "boolean" ||
      !Array.isArray(predicate.terms) ||
      predicate.terms.length === 0
    ) {
      throw malformed("Policy group has an invalid shape.");
    }
    for (const term of predicate.terms) {
      validatePredicate(term, visible);
    }
    return;
  }
  if (
    predicate.kind !== "comparison" ||
    !visible.has(predicate.column) ||
    (predicate.operator !== "eq" && predicate.operator !== "neq") ||
    !isRecord(predicate.value) ||
    (predicate.value.kind !== "actor_id" &&
      (predicate.value.kind !== "literal" || typeof predicate.value.value !== "string"))
  ) {
    throw validation("Policy comparison is invalid or references a non-visible field.");
  }
}

function resolveTable(manifest: SchemaManifest, tableName: string): SchemaTable {
  if (!isRecord(manifest) || !Array.isArray(manifest.tables)) {
    throw malformed("Schema manifest has an invalid shape.");
  }
  const table = manifest.tables.find((candidate) => candidate.name === tableName);
  if (table === undefined) {
    throw validation(`Table "${tableName}" is not exposed by the schema manifest.`);
  }
  return table;
}

function visibleColumns(table: SchemaTable): ReadonlySet<string> {
  return new Set(
    table.columns.filter((column) => column.hidden === "none").map((column) => column.name),
  );
}

function freezeGroup(
  operator: BooleanGroup["operator"],
  negated: boolean,
  terms: readonly FilterExpression[],
): BooleanGroup {
  return Object.freeze({ kind: "group", operator, negated, terms: Object.freeze(terms) });
}

function freezeDecision(
  allowed: boolean,
  allowedFields: readonly string[],
  matchedRules: readonly string[],
): PolicyDecision {
  return Object.freeze({
    allowed,
    allowedFields: Object.freeze([...allowedFields]),
    matchedRules: Object.freeze([...matchedRules]),
  });
}

function isAction(value: unknown): value is PolicyAction {
  return value === "select" || value === "insert" || value === "update" || value === "delete";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function malformed(message: string): PolicyError {
  return new PolicyError("POLICY_MALFORMED", message);
}

function validation(message: string): PolicyError {
  return new PolicyError("POLICY_VALIDATION", message);
}

function forbidden(message: string): PolicyError {
  return new PolicyError("POLICY_FORBIDDEN", message);
}

function unsupported(message: string): PolicyError {
  return new PolicyError("POLICY_UNSUPPORTED", message);
}
