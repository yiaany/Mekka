import {
  createTenantCacheKey,
  parseTenantIdentity,
  type TenantContext,
  type TenantIdentity,
} from "@mekka/protocol";
import type { StorageExecutor } from "@mekka/storage-core";
import {
  createInMemoryRealtimeChannelCoordinator,
  type RealtimeChannelCoordinator,
  type RealtimeChannelEvent,
  type RealtimeJsonObject,
} from "./channels";
import {
  type ChangefeedEvent,
  ChangefeedError,
  type ChangeRecord,
  readChangefeedForDelivery,
} from "./index";

export type RealtimeAuthentication = Readonly<{
  context: TenantContext;
  expiresAt: number;
}>;

export type RealtimeSubscriptionSource = Readonly<{
  tenant: TenantIdentity;
  storage: StorageExecutor;
  subscribableTables: readonly string[];
  authorizeChannel(context: TenantContext, channel: string): RealtimeChannelPolicy | null;
  authorize(
    context: TenantContext,
    event: ChangefeedEvent,
    policyOldRecord: ChangeRecord | null,
    policyRecord: ChangeRecord | null,
  ): Readonly<{ oldRecord: ChangeRecord | null; record: ChangeRecord | null }> | null;
}>;

export type RealtimeChannelPolicy = Readonly<{
  broadcast: Readonly<{ read: boolean; write: boolean }>;
  presence: Readonly<{ read: boolean; write: boolean }>;
}>;

export type RealtimeSocket = Readonly<{
  send(message: string): "sent" | "backpressure" | "dropped";
  close(code: number, reason: string): void;
}>;

export type RealtimeSubscriptionLimits = Readonly<{
  maxConnections: number;
  maxConnectionsPerTenant: number;
  maxChannelsPerConnection: number;
  maxSubscriptionsPerChannel: number;
  maxMessageBytes: number;
  maxUnackedEvents: number;
  maxUnackedBytes: number;
  readBatchSize: number;
  authenticationTimeoutMs: number;
  heartbeatTimeoutMs: number;
  pollIntervalMs: number;
  maxBroadcastPayloadBytes: number;
  maxPresencePayloadBytes: number;
  maxBroadcastMessagesPerWindow: number;
  maxPresenceMessagesPerWindow: number;
  maxPresenceEntriesPerChannel: number;
  messageRateWindowMs: number;
  presenceLeaseMs: number;
}>;

export type RealtimeSubscriptionGatewayOptions = Readonly<{
  authenticate(token: string): Promise<RealtimeAuthentication> | RealtimeAuthentication;
  resolveSource(
    context: TenantContext,
  ): Promise<RealtimeSubscriptionSource> | RealtimeSubscriptionSource;
  now?: () => number;
  limits?: Partial<RealtimeSubscriptionLimits>;
  coordinator?: RealtimeChannelCoordinator;
}>;

export type RealtimeSubscriptionGateway = Readonly<{
  open(connectionId: string, socket: RealtimeSocket): void;
  receive(connectionId: string, message: unknown): Promise<void>;
  drain(connectionId: string): void;
  close(connectionId: string): void;
  tick(): Promise<void>;
  dispose(): void;
}>;

type WireMessage = Readonly<{
  joinRef: string | null;
  ref: string | null;
  topic: string;
  event: string;
  payload: Readonly<Record<string, unknown>>;
}>;

type Subscription = Readonly<{
  id: string;
  event: "*" | "INSERT" | "UPDATE" | "DELETE";
  schema: "public";
  table: string;
}>;

type PendingDelivery = Readonly<{ cursor: number; bytes: number }>;

type RateWindow = { startedAt: number; count: number };

type ChannelConfig = Readonly<{
  subscriptions: readonly Subscription[];
  broadcast: Readonly<{ ack: boolean; self: boolean }>;
  presence: Readonly<{ enabled: boolean; key: string }>;
}>;

type ChannelState = {
  topic: string;
  joinRef: string | null;
  subscriptions: readonly Subscription[];
  channelName: string;
  scope: string;
  policy: RealtimeChannelPolicy;
  broadcast: Readonly<{ ack: boolean; self: boolean }>;
  presence: Readonly<{ enabled: boolean; key: string }>;
  unsubscribe: () => void;
  broadcastRate: RateWindow;
  presenceRate: RateWindow;
  acknowledgedCursor: number;
  sentCursor: number;
  pending: PendingDelivery[];
  pendingBytes: number;
  transportBlocked: boolean;
  pumping: boolean;
};

type ConnectionState = {
  id: string;
  socket: RealtimeSocket;
  context: TenantContext | null;
  source: RealtimeSubscriptionSource | null;
  expiresAt: number;
  tenantKey: string | null;
  openedAt: number;
  lastHeartbeatAt: number;
  channels: Map<string, ChannelState>;
  joiningTopics: Set<string>;
  closed: boolean;
};

const defaultLimits: RealtimeSubscriptionLimits = Object.freeze({
  maxConnections: 10_000,
  maxConnectionsPerTenant: 100,
  maxChannelsPerConnection: 16,
  maxSubscriptionsPerChannel: 16,
  maxMessageBytes: 64 * 1024,
  maxUnackedEvents: 100,
  maxUnackedBytes: 1024 * 1024,
  readBatchSize: 100,
  authenticationTimeoutMs: 10_000,
  heartbeatTimeoutMs: 60_000,
  pollIntervalMs: 100,
  maxBroadcastPayloadBytes: 32 * 1024,
  maxPresencePayloadBytes: 16 * 1024,
  maxBroadcastMessagesPerWindow: 100,
  maxPresenceMessagesPerWindow: 20,
  maxPresenceEntriesPerChannel: 1_000,
  messageRateWindowMs: 10_000,
  presenceLeaseMs: 30_000,
});

const safeConnectionIdPattern = /^[A-Za-z0-9_-]{8,128}$/;
const safeTopicPattern = /^realtime:[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const safeTablePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const safeReferencePattern = /^[A-Za-z0-9_-]{1,64}$/;
const tokenPattern = /^[A-Za-z0-9._~-]{16,8192}$/;
const safeChannelNamePattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,118}$/;
const safeBroadcastEventPattern = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const reservedPresenceFields = new Set(["actor_id", "phx_ref", "presence_ref"]);
const deniedChannelPolicy: RealtimeChannelPolicy = Object.freeze({
  broadcast: Object.freeze({ read: false, write: false }),
  presence: Object.freeze({ read: false, write: false }),
});

export function createRealtimeSubscriptionGateway(
  options: RealtimeSubscriptionGatewayOptions,
): RealtimeSubscriptionGateway {
  const limits = resolveLimits(options.limits);
  const now = options.now ?? Date.now;
  const coordinator = options.coordinator ?? createInMemoryRealtimeChannelCoordinator();
  const ownsCoordinator = options.coordinator === undefined;
  const connections = new Map<string, ConnectionState>();
  const tenantConnections = new Map<string, number>();
  let disposed = false;
  const timer = setInterval(() => void tick(), limits.pollIntervalMs);
  timer.unref();

  function open(connectionId: string, socket: RealtimeSocket): void {
    if (
      disposed ||
      !safeConnectionIdPattern.test(connectionId) ||
      connections.has(connectionId) ||
      connections.size >= limits.maxConnections
    ) {
      socket.close(1013, "connection_quota");
      return;
    }
    connections.set(connectionId, {
      id: connectionId,
      socket,
      context: null,
      source: null,
      expiresAt: 0,
      tenantKey: null,
      openedAt: now(),
      lastHeartbeatAt: now(),
      channels: new Map(),
      joiningTopics: new Set(),
      closed: false,
    });
  }

  async function receive(connectionId: string, rawMessage: unknown): Promise<void> {
    const connection = connections.get(connectionId);
    if (connection === undefined || connection.closed) {
      return;
    }
    try {
      const message = parseWireMessage(rawMessage, limits.maxMessageBytes);
      if (message.topic === "phoenix" && message.event === "heartbeat") {
        connection.lastHeartbeatAt = now();
        await refreshSource(connection);
        sendReply(connection, message, "ok", {});
        await pumpConnection(connection);
        return;
      }
      if (message.event === "phx_join") {
        await joinChannel(connection, message);
        return;
      }
      if (message.event === "phx_leave") {
        leaveChannel(connection, message);
        return;
      }
      if (message.event === "broadcast") {
        broadcast(connection, message);
        return;
      }
      if (message.event === "presence") {
        presence(connection, message);
        return;
      }
      if (message.event === "access_token") {
        await refreshAuthentication(connection, message);
        return;
      }
      if (message.event === "mekka_ack") {
        acknowledge(connection, message);
        await pumpConnection(connection);
        return;
      }
      sendReply(connection, message, "error", { reason: "unsupported_event" });
    } catch (error) {
      if (error instanceof RealtimeProtocolError) {
        closeConnection(connection, error.closeCode, error.reason);
        return;
      }
      closeConnection(connection, 1011, "realtime_failure");
    }
  }

  function drain(connectionId: string): void {
    const connection = connections.get(connectionId);
    if (connection === undefined || connection.closed) {
      return;
    }
    for (const channel of connection.channels.values()) {
      channel.transportBlocked = false;
    }
    void pumpConnection(connection);
  }

  function close(connectionId: string): void {
    const connection = connections.get(connectionId);
    if (connection !== undefined) {
      removeConnection(connection);
    }
  }

  async function tick(): Promise<void> {
    if (disposed) {
      return;
    }
    coordinator.sweepPresence(now());
    await Promise.all([...connections.values()].map((connection) => pumpConnection(connection)));
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    clearInterval(timer);
    for (const connection of [...connections.values()]) {
      closeConnection(connection, 1012, "server_shutdown");
    }
    if (ownsCoordinator) {
      coordinator.dispose();
    }
  }

  async function joinChannel(connection: ConnectionState, message: WireMessage): Promise<void> {
    if (
      !safeTopicPattern.test(message.topic) ||
      connection.channels.has(message.topic) ||
      connection.joiningTopics.has(message.topic)
    ) {
      throw protocol(1008, "invalid_channel");
    }
    if (connection.channels.size >= limits.maxChannelsPerConnection) {
      throw protocol(1013, "channel_quota");
    }
    connection.joiningTopics.add(message.topic);

    try {
      const token = readToken(message.payload.access_token);
      const authentication = await authenticate(options, token);
      validateAuthentication(authentication, now());
      const source = await options.resolveSource(authentication.context);
      if (connection.closed) {
        return;
      }
      const tenant = parseTenantIdentity(source.tenant);
      if (!sameTenant(tenant, authentication.context.tenant)) {
        throw protocol(1008, "tenant_mismatch");
      }
      bindConnectionAuthentication(connection, authentication, source);

      const config = parseChannelConfig(message.payload.config, limits.maxSubscriptionsPerChannel);
      const subscriptions = config.subscriptions;
      if (
        subscriptions.some(
          (subscription) => !source.subscribableTables.includes(subscription.table),
        )
      ) {
        throw protocol(1008, "channel_forbidden");
      }
      const channelName = message.topic.slice("realtime:".length);
      if (!safeChannelNamePattern.test(channelName)) {
        throw protocol(1008, "invalid_channel");
      }
      const authorizedPolicy = source.authorizeChannel(authentication.context, channelName);
      if (authorizedPolicy === null && subscriptions.length === 0) {
        throw protocol(1008, "channel_forbidden");
      }
      const policy = authorizedPolicy ?? deniedChannelPolicy;
      const presenceKey = resolvePresenceKey(config.presence.key, authentication.context.actor.id);
      const cursor = parseCursor(message.payload.cursor ?? 0);
      if (subscriptions.length > 0) {
        readChangefeedForDelivery(source.storage, {
          tenant: authentication.context.tenant,
          afterCursor: cursor,
          limit: 1,
        });
      }
      const scope = createTenantCacheKey(authentication.context.tenant, `realtime:${channelName}`);
      const channel: ChannelState = {
        topic: message.topic,
        joinRef: message.ref,
        subscriptions,
        channelName,
        scope,
        policy,
        broadcast: config.broadcast,
        presence: Object.freeze({ enabled: config.presence.enabled, key: presenceKey }),
        unsubscribe: () => undefined,
        broadcastRate: { startedAt: now(), count: 0 },
        presenceRate: { startedAt: now(), count: 0 },
        acknowledgedCursor: cursor,
        sentCursor: cursor,
        pending: [],
        pendingBytes: 0,
        transportBlocked: false,
        pumping: false,
      };
      channel.unsubscribe = coordinator.subscribe(scope, (event) =>
        deliverChannelEvent(connection, channel, event),
      );
      connection.channels.set(message.topic, channel);
      sendReply(connection, message, "ok", {
        postgres_changes: subscriptions.map((subscription) => ({ ...subscription })),
        cursor,
        presence: { key: presenceKey },
      });
      if (channel.presence.enabled && channel.policy.presence.read) {
        sendChannelMessage(
          connection,
          channel.topic,
          "presence_state",
          coordinator.presenceState(scope),
        );
      }
      await pumpChannel(connection, channel);
    } finally {
      connection.joiningTopics.delete(message.topic);
    }
  }

  async function refreshAuthentication(
    connection: ConnectionState,
    message: WireMessage,
  ): Promise<void> {
    if (connection.context === null || connection.source === null) {
      throw protocol(1008, "channel_not_joined");
    }
    const authentication = await authenticate(options, readToken(message.payload.access_token));
    validateAuthentication(authentication, now());
    if (
      !sameTenant(authentication.context.tenant, connection.context.tenant) ||
      authentication.context.actor.kind !== connection.context.actor.kind ||
      authentication.context.actor.id !== connection.context.actor.id
    ) {
      throw protocol(1008, "authentication_binding_changed");
    }
    const source = await options.resolveSource(authentication.context);
    if (!sameTenant(source.tenant, authentication.context.tenant)) {
      throw protocol(1008, "tenant_mismatch");
    }
    connection.context = authentication.context;
    connection.source = source;
    connection.expiresAt = authentication.expiresAt;
    refreshChannelPolicies(connection, source);
    renewConnectionPresence(connection);
    sendReply(connection, message, "ok", {});
  }

  function broadcast(connection: ConnectionState, message: WireMessage): void {
    const channel = requireChannel(connection, message.topic);
    if (!channel.policy.broadcast.write) {
      sendReply(connection, message, "error", { reason: "channel_forbidden" });
      return;
    }
    if (
      !consumeRate(
        channel.broadcastRate,
        limits.maxBroadcastMessagesPerWindow,
        limits.messageRateWindowMs,
        now(),
      )
    ) {
      sendReply(connection, message, "error", { reason: "rate_limit" });
      return;
    }
    const event = message.payload.event;
    const payload = message.payload.payload;
    if (
      message.payload.type !== "broadcast" ||
      typeof event !== "string" ||
      !safeBroadcastEventPattern.test(event) ||
      !isJsonObject(payload) ||
      jsonBytes(payload) > limits.maxBroadcastPayloadBytes
    ) {
      throw protocol(1008, "invalid_broadcast");
    }
    coordinator.broadcast(
      Object.freeze({
        kind: "broadcast",
        scope: channel.scope,
        senderOwnerId: presenceOwnerId(connection, channel),
        event,
        payload,
      }),
    );
    if (channel.broadcast.ack) {
      sendReply(connection, message, "ok", {});
    }
  }

  function presence(connection: ConnectionState, message: WireMessage): void {
    const channel = requireChannel(connection, message.topic);
    if (!channel.policy.presence.write) {
      sendReply(connection, message, "error", { reason: "channel_forbidden" });
      return;
    }
    if (
      !consumeRate(
        channel.presenceRate,
        limits.maxPresenceMessagesPerWindow,
        limits.messageRateWindowMs,
        now(),
      )
    ) {
      sendReply(connection, message, "error", { reason: "rate_limit" });
      return;
    }
    const event = message.payload.event;
    if (message.payload.type !== "presence" || typeof event !== "string") {
      throw protocol(1008, "invalid_presence");
    }
    const normalizedEvent = event.toLowerCase();
    const ownerId = presenceOwnerId(connection, channel);
    if (normalizedEvent === "track") {
      const payload = message.payload.payload ?? {};
      if (
        !isJsonObject(payload) ||
        Object.keys(payload).some((field) => reservedPresenceFields.has(field)) ||
        jsonBytes(payload) > limits.maxPresencePayloadBytes
      ) {
        throw protocol(1008, "invalid_presence");
      }
      const presenceEntries = Object.values(coordinator.presenceState(channel.scope)).reduce(
        (total, entry) => total + entry.metas.length,
        0,
      );
      if (
        presenceEntries >= limits.maxPresenceEntriesPerChannel &&
        !coordinator.hasPresence(channel.scope, ownerId)
      ) {
        sendReply(connection, message, "error", { reason: "presence_quota" });
        return;
      }
      const context = connection.context;
      if (context === null) {
        throw protocol(1008, "channel_not_joined");
      }
      channel.presence = Object.freeze({ ...channel.presence, enabled: true });
      coordinator.trackPresence({
        scope: channel.scope,
        ownerId,
        key: channel.presence.key,
        actorId: context.actor.id,
        payload,
        expiresAt: now() + limits.presenceLeaseMs,
      });
    } else if (normalizedEvent === "untrack") {
      coordinator.untrackPresence(ownerId);
    } else {
      throw protocol(1008, "unsupported_presence_event");
    }
    sendReply(connection, message, "ok", {});
  }

  function deliverChannelEvent(
    connection: ConnectionState,
    channel: ChannelState,
    event: RealtimeChannelEvent,
  ): void {
    if (connection.closed || connection.channels.get(channel.topic) !== channel) {
      return;
    }
    if (event.kind === "broadcast") {
      if (
        !channel.policy.broadcast.read ||
        (!channel.broadcast.self && event.senderOwnerId === presenceOwnerId(connection, channel))
      ) {
        return;
      }
      sendChannelMessage(connection, channel.topic, "broadcast", {
        type: "broadcast",
        event: event.event,
        payload: event.payload,
      });
      return;
    }
    if (channel.presence.enabled && channel.policy.presence.read) {
      sendChannelMessage(connection, channel.topic, "presence_diff", {
        joins: event.joins,
        leaves: event.leaves,
      });
    }
  }

  async function refreshSource(connection: ConnectionState): Promise<void> {
    if (connection.context === null || connection.source === null) {
      return;
    }
    const source = await options.resolveSource(connection.context);
    if (!sameTenant(source.tenant, connection.context.tenant)) {
      throw protocol(1008, "tenant_mismatch");
    }
    if (
      [...connection.channels.values()].some((channel) =>
        channel.subscriptions.some(
          (subscription) => !source.subscribableTables.includes(subscription.table),
        ),
      )
    ) {
      throw protocol(1008, "channel_forbidden");
    }
    connection.source = source;
    refreshChannelPolicies(connection, source);
    renewConnectionPresence(connection);
  }

  function renewConnectionPresence(connection: ConnectionState): void {
    const expiresAt = now() + limits.presenceLeaseMs;
    for (const channel of connection.channels.values()) {
      coordinator.renewPresence(presenceOwnerId(connection, channel), expiresAt);
    }
  }

  function refreshChannelPolicies(
    connection: ConnectionState,
    source: RealtimeSubscriptionSource,
  ): void {
    if (connection.context === null) {
      throw protocol(1008, "channel_not_joined");
    }
    for (const channel of connection.channels.values()) {
      const authorizedPolicy = source.authorizeChannel(connection.context, channel.channelName);
      const policy =
        authorizedPolicy ?? (channel.subscriptions.length > 0 ? deniedChannelPolicy : null);
      if (
        policy === null ||
        (channel.policy.broadcast.read && !policy.broadcast.read) ||
        (channel.policy.presence.read && !policy.presence.read)
      ) {
        throw protocol(1008, "channel_forbidden");
      }
      channel.policy = policy;
    }
  }

  function bindConnectionAuthentication(
    connection: ConnectionState,
    authentication: RealtimeAuthentication,
    source: RealtimeSubscriptionSource,
  ): void {
    if (connection.context !== null) {
      if (
        !sameTenant(connection.context.tenant, authentication.context.tenant) ||
        connection.context.actor.kind !== authentication.context.actor.kind ||
        connection.context.actor.id !== authentication.context.actor.id
      ) {
        throw protocol(1008, "authentication_binding_changed");
      }
      connection.context = authentication.context;
      connection.source = source;
      connection.expiresAt = authentication.expiresAt;
      return;
    }

    const tenantKey = createTenantCacheKey(authentication.context.tenant, "realtime-connections");
    const count = tenantConnections.get(tenantKey) ?? 0;
    if (count >= limits.maxConnectionsPerTenant) {
      throw protocol(1013, "tenant_connection_quota");
    }
    tenantConnections.set(tenantKey, count + 1);
    connection.context = authentication.context;
    connection.source = source;
    connection.expiresAt = authentication.expiresAt;
    connection.tenantKey = tenantKey;
  }

  function leaveChannel(connection: ConnectionState, message: WireMessage): void {
    const channel = connection.channels.get(message.topic);
    if (channel === undefined) {
      sendReply(connection, message, "error", { reason: "channel_not_joined" });
      return;
    }
    channel.unsubscribe();
    coordinator.untrackPresence(presenceOwnerId(connection, channel));
    connection.channels.delete(message.topic);
    sendReply(connection, message, "ok", { cursor: channel.acknowledgedCursor });
  }

  function acknowledge(connection: ConnectionState, message: WireMessage): void {
    const channel = connection.channels.get(message.topic);
    if (channel === undefined) {
      throw protocol(1008, "channel_not_joined");
    }
    const cursor = parseCursor(message.payload.cursor);
    if (cursor < channel.acknowledgedCursor || cursor > channel.sentCursor) {
      throw protocol(1008, "invalid_ack_cursor");
    }
    const acknowledged = channel.pending.filter((delivery) => delivery.cursor <= cursor);
    if (acknowledged.length === 0 && cursor !== channel.acknowledgedCursor) {
      throw protocol(1008, "invalid_ack_cursor");
    }
    const acknowledgedBytes = acknowledged.reduce((total, delivery) => total + delivery.bytes, 0);
    channel.pending = channel.pending.filter((delivery) => delivery.cursor > cursor);
    channel.pendingBytes -= acknowledgedBytes;
    channel.acknowledgedCursor = channel.pending.length === 0 ? channel.sentCursor : cursor;
    sendReply(connection, message, "ok", { cursor: channel.acknowledgedCursor });
  }

  async function pumpConnection(connection: ConnectionState): Promise<void> {
    if (connection.closed) {
      return;
    }
    const currentTime = now();
    if (connection.context === null || connection.source === null) {
      if (currentTime - connection.openedAt > limits.authenticationTimeoutMs) {
        closeConnection(connection, 4001, "authentication_timeout");
      }
      return;
    }
    if (connection.expiresAt * 1000 <= currentTime) {
      closeConnection(connection, 4001, "token_expired");
      return;
    }
    if (currentTime - connection.lastHeartbeatAt > limits.heartbeatTimeoutMs) {
      closeConnection(connection, 4002, "heartbeat_timeout");
      return;
    }
    try {
      await refreshSource(connection);
    } catch (error) {
      if (error instanceof RealtimeProtocolError) {
        closeConnection(connection, error.closeCode, error.reason);
      } else {
        closeConnection(connection, 1011, "realtime_failure");
      }
      return;
    }
    await Promise.all(
      [...connection.channels.values()].map((channel) => pumpChannel(connection, channel)),
    );
  }

  async function pumpChannel(connection: ConnectionState, channel: ChannelState): Promise<void> {
    if (
      channel.pumping ||
      channel.transportBlocked ||
      connection.closed ||
      connection.context === null ||
      connection.source === null
    ) {
      return;
    }
    if (channel.subscriptions.length === 0) {
      return;
    }
    channel.pumping = true;
    try {
      const available = limits.maxUnackedEvents - channel.pending.length;
      if (available < 1) {
        const unread = readChangefeedForDelivery(connection.source.storage, {
          tenant: connection.context.tenant,
          afterCursor: channel.sentCursor,
          limit: 1,
        });
        if (unread.events.length > 0) {
          closeConnection(connection, 1013, "slow_consumer");
        }
        return;
      }
      const batch = readChangefeedForDelivery(connection.source.storage, {
        tenant: connection.context.tenant,
        afterCursor: channel.sentCursor,
        limit: Math.min(available, limits.readBatchSize),
      });
      for (const delivery of batch.events) {
        const event = delivery.event;
        const matching = channel.subscriptions.filter(
          (subscription) =>
            subscription.table === event.table &&
            (subscription.event === "*" || subscription.event === event.operation),
        );
        const authorized = connection.source.authorize(
          connection.context,
          event,
          delivery.policyOldRecord,
          delivery.policyRecord,
        );
        if (matching.length === 0 || authorized === null) {
          channel.sentCursor = event.cursor;
          if (channel.pending.length === 0) {
            channel.acknowledgedCursor = event.cursor;
          }
          continue;
        }

        const encoded = encodeMessage(null, null, channel.topic, "postgres_changes", {
          ids: matching.map((subscription) => subscription.id),
          data: {
            schema: "public",
            table: event.table,
            commit_timestamp: new Date(event.transaction.occurredAt).toISOString(),
            type: event.operation,
            errors: null,
            record: authorized.record ?? {},
            old_record: authorized.oldRecord ?? {},
            cursor: event.cursor,
            event_id: event.eventId,
          },
        });
        const bytes = Buffer.byteLength(encoded);
        if (
          channel.pending.length >= limits.maxUnackedEvents ||
          channel.pendingBytes + bytes > limits.maxUnackedBytes
        ) {
          closeConnection(connection, 1013, "slow_consumer");
          return;
        }
        const sendStatus = connection.socket.send(encoded);
        if (sendStatus === "dropped") {
          closeConnection(connection, 1013, "slow_consumer");
          return;
        }
        channel.sentCursor = event.cursor;
        channel.pending.push(Object.freeze({ cursor: event.cursor, bytes }));
        channel.pendingBytes += bytes;
        if (sendStatus === "backpressure") {
          channel.transportBlocked = true;
          return;
        }
      }
    } catch (error) {
      if (error instanceof ChangefeedError && error.code === "CHANGEFEED_RESYNC_REQUIRED") {
        sendSystem(connection, channel.topic, "resync_required");
        closeConnection(connection, 4009, "resync_required");
        return;
      }
      closeConnection(connection, 1011, "realtime_failure");
    } finally {
      channel.pumping = false;
    }
  }

  function sendReply(
    connection: ConnectionState,
    message: WireMessage,
    status: "ok" | "error",
    response: Readonly<Record<string, unknown>>,
  ): void {
    const result = connection.socket.send(
      encodeMessage(message.joinRef, message.ref, message.topic, "phx_reply", {
        status,
        response,
      }),
    );
    if (result !== "sent") {
      closeConnection(connection, 1013, "slow_consumer");
    }
  }

  function sendChannelMessage(
    connection: ConnectionState,
    topic: string,
    event: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    const encoded = encodeMessage(null, null, topic, event, payload);
    if (Buffer.byteLength(encoded) > limits.maxMessageBytes) {
      closeConnection(connection, 1013, "channel_state_too_large");
      return;
    }
    if (connection.socket.send(encoded) !== "sent") {
      closeConnection(connection, 1013, "slow_consumer");
    }
  }

  function sendSystem(connection: ConnectionState, topic: string, reason: string): void {
    connection.socket.send(
      encodeMessage(null, null, topic, "system", {
        extension: "postgres_changes",
        status: "error",
        message: reason,
        channel: topic.slice("realtime:".length),
      }),
    );
  }

  function closeConnection(connection: ConnectionState, code: number, reason: string): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    connection.socket.close(code, reason);
    removeConnection(connection);
  }

  function removeConnection(connection: ConnectionState): void {
    connections.delete(connection.id);
    if (connection.tenantKey !== null) {
      const count = tenantConnections.get(connection.tenantKey) ?? 0;
      if (count <= 1) {
        tenantConnections.delete(connection.tenantKey);
      } else {
        tenantConnections.set(connection.tenantKey, count - 1);
      }
      connection.tenantKey = null;
    }
    connection.closed = true;
    for (const channel of connection.channels.values()) {
      coordinator.untrackPresence(presenceOwnerId(connection, channel));
      channel.unsubscribe();
    }
    connection.channels.clear();
    connection.joiningTopics.clear();
  }

  return Object.freeze({ open, receive, drain, close, tick, dispose });
}

function parseWireMessage(rawMessage: unknown, maxBytes: number): WireMessage {
  let parsed: unknown = rawMessage;
  if (typeof rawMessage === "string") {
    if (Buffer.byteLength(rawMessage) > maxBytes) {
      throw protocol(1009, "message_too_large");
    }
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      throw protocol(1008, "invalid_message");
    }
  } else if (Buffer.byteLength(JSON.stringify(rawMessage)) > maxBytes) {
    throw protocol(1009, "message_too_large");
  }
  if (!Array.isArray(parsed) || parsed.length !== 5) {
    throw protocol(1008, "invalid_message");
  }
  const [joinRef, ref, topic, event, payload] = parsed;
  if (
    !isReference(joinRef) ||
    !isReference(ref) ||
    typeof topic !== "string" ||
    typeof event !== "string" ||
    !isRecord(payload)
  ) {
    throw protocol(1008, "invalid_message");
  }
  return Object.freeze({ joinRef, ref, topic, event, payload });
}

function parseChannelConfig(value: unknown, maxSubscriptions: number): ChannelConfig {
  if (!isRecord(value)) {
    throw protocol(1008, "invalid_channel_config");
  }
  const postgresChanges = value.postgres_changes ?? [];
  if (!Array.isArray(postgresChanges)) {
    throw protocol(1008, "invalid_subscription");
  }
  if (postgresChanges.length > maxSubscriptions) {
    throw protocol(1013, "subscription_quota");
  }
  const subscriptions = Object.freeze(
    postgresChanges.map((candidate, index) => {
      if (
        !isRecord(candidate) ||
        (candidate.event !== "*" &&
          candidate.event !== "INSERT" &&
          candidate.event !== "UPDATE" &&
          candidate.event !== "DELETE") ||
        candidate.schema !== "public" ||
        typeof candidate.table !== "string" ||
        !safeTablePattern.test(candidate.table) ||
        candidate.filter !== undefined ||
        candidate.select !== undefined
      ) {
        throw protocol(1008, "unsupported_subscription");
      }
      return Object.freeze({
        id: `mekka-${index + 1}`,
        event: candidate.event,
        schema: "public" as const,
        table: candidate.table,
      });
    }),
  );
  const broadcastValue = value.broadcast ?? {};
  const presenceValue = value.presence ?? {};
  if (!isRecord(broadcastValue) || !isRecord(presenceValue)) {
    throw protocol(1008, "invalid_channel_config");
  }
  if (
    (broadcastValue.ack !== undefined && typeof broadcastValue.ack !== "boolean") ||
    (broadcastValue.self !== undefined && typeof broadcastValue.self !== "boolean") ||
    broadcastValue.replay !== undefined ||
    broadcastValue.replication_ready !== undefined ||
    (presenceValue.enabled !== undefined && typeof presenceValue.enabled !== "boolean") ||
    (presenceValue.key !== undefined && typeof presenceValue.key !== "string")
  ) {
    throw protocol(1008, "unsupported_channel_config");
  }
  return Object.freeze({
    subscriptions,
    broadcast: Object.freeze({
      ack: broadcastValue.ack === true,
      self: broadcastValue.self === true,
    }),
    presence: Object.freeze({
      enabled: presenceValue.enabled === true,
      key: typeof presenceValue.key === "string" ? presenceValue.key : "",
    }),
  });
}

function validateAuthentication(authentication: RealtimeAuthentication, now: number): void {
  if (
    !Number.isSafeInteger(authentication.expiresAt) ||
    authentication.expiresAt * 1000 <= now ||
    authentication.context.actor.kind !== "user"
  ) {
    throw protocol(4001, "invalid_token");
  }
  parseTenantIdentity(authentication.context.tenant);
}

async function authenticate(
  options: RealtimeSubscriptionGatewayOptions,
  token: string,
): Promise<RealtimeAuthentication> {
  try {
    return await options.authenticate(token);
  } catch {
    throw protocol(4001, "invalid_token");
  }
}

function readToken(value: unknown): string {
  if (typeof value !== "string" || !tokenPattern.test(value)) {
    throw protocol(4001, "invalid_token");
  }
  return value;
}

function parseCursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw protocol(1008, "invalid_cursor");
  }
  return value;
}

function encodeMessage(
  joinRef: string | null,
  ref: string | null,
  topic: string,
  event: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify([joinRef, ref, topic, event, payload]);
}

function resolveLimits(overrides: Partial<RealtimeSubscriptionLimits> | undefined) {
  const limits = { ...defaultLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Realtime limit ${name} must be a positive safe integer.`);
    }
  }
  if (limits.readBatchSize > limits.maxUnackedEvents) {
    throw new Error("Realtime read batch size cannot exceed the unacked event limit.");
  }
  return Object.freeze(limits);
}

function isReference(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && safeReferencePattern.test(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is RealtimeJsonObject {
  return isRecord(value) && isJsonValue(value, 0);
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 16) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.length <= 1_000 && value.every((item) => isJsonValue(item, depth + 1));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return (
      entries.length <= 1_000 &&
      entries.every(([key, item]) => key.length <= 128 && isJsonValue(item, depth + 1))
    );
  }
  return false;
}

function jsonBytes(value: RealtimeJsonObject): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function resolvePresenceKey(requestedKey: string, actorId: string): string {
  if (requestedKey !== "" && requestedKey !== actorId) {
    throw protocol(1008, "presence_impersonation");
  }
  return actorId;
}

function requireChannel(connection: ConnectionState, topic: string): ChannelState {
  const channel = connection.channels.get(topic);
  if (channel === undefined || connection.context === null || connection.source === null) {
    throw protocol(1008, "channel_not_joined");
  }
  return channel;
}

function presenceOwnerId(connection: ConnectionState, channel: ChannelState): string {
  return `${connection.id}:${channel.topic}`;
}

function consumeRate(window: RateWindow, limit: number, windowMs: number, now: number): boolean {
  if (now - window.startedAt >= windowMs) {
    window.startedAt = now;
    window.count = 0;
  }
  if (window.count >= limit) {
    return false;
  }
  window.count += 1;
  return true;
}

function sameTenant(left: TenantIdentity, right: TenantIdentity): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId &&
    left.branchId === right.branchId &&
    left.generation === right.generation
  );
}

class RealtimeProtocolError extends Error {
  constructor(
    readonly closeCode: number,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "RealtimeProtocolError";
  }
}

function protocol(closeCode: number, reason: string): RealtimeProtocolError {
  return new RealtimeProtocolError(closeCode, reason);
}
