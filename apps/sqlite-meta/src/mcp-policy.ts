import { policyFormatVersion, type PolicyDocument } from "@mekka/policy-engine";
import type { SchemaManifest } from "@mekka/schema-manifest";

export function createSelfHostedMcpReadPolicy(manifest: SchemaManifest): PolicyDocument {
  return Object.freeze({
    formatVersion: policyFormatVersion,
    tables: Object.freeze(
      manifest.tables.map((table) =>
        Object.freeze({
          table: table.name,
          rules: Object.freeze([
            Object.freeze({
              name: "self-hosted-agent-row-read",
              action: "select" as const,
              fields: Object.freeze({
                allow: Object.freeze(
                  table.columns
                    .filter((column) => column.hidden === "none")
                    .map((column) => column.name),
                ),
                deny: Object.freeze([]),
              }),
            }),
          ]),
        }),
      ),
    ),
  });
}
