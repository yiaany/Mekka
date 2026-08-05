import { type PolicyDocument, simulatePolicy } from "@mekka/policy-engine";
import type { TenantContext, TenantIdentity } from "@mekka/protocol";
import type { ChangeRecord } from "@mekka/realtime-core";
import {
  createRealtimeSubscriptionGateway,
  type RealtimeAuthentication,
  type RealtimeSubscriptionLimits,
  type RealtimeSubscriptionSource,
} from "@mekka/realtime-core/subscriptions";
import { buildSchemaManifest, type SchemaManifest } from "@mekka/schema-manifest";
import type { StorageAdapter } from "@mekka/storage-core";
import { Elysia } from "elysia";

export type RealtimeProject = Readonly<{
  tenant: TenantIdentity;
  storage: StorageAdapter;
  policies: PolicyDocument;
  realtimeChannels: readonly RealtimeChannelRule[];
}>;

export type RealtimeChannelRule = Readonly<{
  channel: string;
  memberActorIds: readonly string[];
  broadcast: Readonly<{ read: boolean; write: boolean }>;
  presence: Readonly<{ read: boolean; write: boolean }>;
}>;

export type RealtimeGatewayDependencies = Readonly<{
  authenticateRealtimeToken(
    token: string,
  ): Promise<RealtimeAuthentication> | RealtimeAuthentication;
  resolveRealtimeProject(context: TenantContext): Promise<RealtimeProject> | RealtimeProject;
  now?: () => number;
  realtimeLimits?: Partial<RealtimeSubscriptionLimits>;
}>;

export function createRealtimeRoutes(dependencies: RealtimeGatewayDependencies) {
  const sockets = new Map<object, string>();
  const gateway = createRealtimeSubscriptionGateway({
    authenticate: dependencies.authenticateRealtimeToken,
    resolveSource: async (context) => {
      const project = await dependencies.resolveRealtimeProject(context);
      const manifest = buildSchemaManifest(project.storage);
      return createSubscriptionSource(project, manifest);
    },
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.realtimeLimits === undefined ? {} : { limits: dependencies.realtimeLimits }),
  });

  return new Elysia({ name: "realtime-gateway" })
    .ws("/realtime/v1/websocket", {
      open(ws) {
        const connectionId = crypto.randomUUID();
        sockets.set(ws.raw, connectionId);
        gateway.open(connectionId, {
          send(message) {
            const status = ws.send(message);
            return status > 0 ? "sent" : status === -1 ? "backpressure" : "dropped";
          },
          close(code, reason) {
            ws.close(code, reason);
          },
        });
      },
      message(ws, message) {
        const connectionId = sockets.get(ws.raw);
        if (connectionId !== undefined) {
          return gateway.receive(connectionId, message);
        }
      },
      drain(ws) {
        const connectionId = sockets.get(ws.raw);
        if (connectionId !== undefined) {
          gateway.drain(connectionId);
        }
      },
      close(ws) {
        const connectionId = sockets.get(ws.raw);
        if (connectionId !== undefined) {
          sockets.delete(ws.raw);
          gateway.close(connectionId);
        }
      },
      idleTimeout: 70,
      maxPayloadLength: 64 * 1024,
    })
    .onStop(() => gateway.dispose());
}

function createSubscriptionSource(
  project: RealtimeProject,
  manifest: SchemaManifest,
): RealtimeSubscriptionSource {
  const selectPolicies = new Set(
    project.policies.tables
      .filter((table) => table.rules.some((rule) => rule.action === "select"))
      .map((table) => table.table),
  );
  const subscribableTables = Object.freeze(
    manifest.tables.map((table) => table.name).filter((table) => selectPolicies.has(table)),
  );
  return Object.freeze({
    tenant: project.tenant,
    storage: project.storage,
    subscribableTables,
    authorizeChannel(context, channel) {
      const rule = project.realtimeChannels.find((candidate) => candidate.channel === channel);
      if (rule === undefined || !rule.memberActorIds.includes(context.actor.id)) {
        return null;
      }
      return Object.freeze({ broadcast: rule.broadcast, presence: rule.presence });
    },
    authorize(context, event, policyOldRecord, policyRecord) {
      const oldRecord = projectRecord(
        manifest,
        project.policies,
        context,
        event.table,
        policyOldRecord,
      );
      const record = projectRecord(manifest, project.policies, context, event.table, policyRecord);
      if (oldRecord === null && record === null) {
        return null;
      }
      return Object.freeze({ oldRecord, record });
    },
  });
}

function projectRecord(
  manifest: SchemaManifest,
  policies: PolicyDocument,
  context: TenantContext,
  table: string,
  row: ChangeRecord | null,
): ChangeRecord | null {
  if (row === null) {
    return null;
  }
  const decision = simulatePolicy(manifest, policies, {
    context,
    action: "select",
    table,
    row,
  });
  if (decision.matchedRules.length === 0 || decision.allowedFields.length === 0) {
    return null;
  }
  return Object.freeze(
    Object.fromEntries(decision.allowedFields.map((field) => [field, row[field] ?? null])),
  );
}
