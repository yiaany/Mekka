export type RealtimeJsonObject = Readonly<Record<string, unknown>>;

export type RealtimeBroadcast = Readonly<{
  kind: "broadcast";
  scope: string;
  senderOwnerId: string;
  event: string;
  payload: RealtimeJsonObject;
}>;

export type RealtimePresenceMeta = RealtimeJsonObject &
  Readonly<{
    phx_ref: string;
    actor_id: string;
  }>;

export type RealtimePresenceEntry = Readonly<{
  metas: readonly RealtimePresenceMeta[];
}>;

export type RealtimePresenceState = Readonly<Record<string, RealtimePresenceEntry>>;

export type RealtimePresenceDiff = Readonly<{
  kind: "presence_diff";
  scope: string;
  joins: RealtimePresenceState;
  leaves: RealtimePresenceState;
}>;

export type RealtimeChannelEvent = RealtimeBroadcast | RealtimePresenceDiff;

export type RealtimeChannelCoordinator = Readonly<{
  subscribe(scope: string, listener: (event: RealtimeChannelEvent) => void): () => void;
  broadcast(event: RealtimeBroadcast): void;
  presenceState(scope: string): RealtimePresenceState;
  hasPresence(scope: string, ownerId: string): boolean;
  trackPresence(
    input: Readonly<{
      scope: string;
      ownerId: string;
      key: string;
      actorId: string;
      payload: RealtimeJsonObject;
      expiresAt: number;
    }>,
  ): void;
  renewPresence(ownerId: string, expiresAt: number): void;
  untrackPresence(ownerId: string): void;
  sweepPresence(now: number): void;
  dispose(): void;
}>;

type PresenceRecord = Readonly<{
  ownerId: string;
  key: string;
  meta: RealtimePresenceMeta;
  expiresAt: number;
}>;

export function createInMemoryRealtimeChannelCoordinator(): RealtimeChannelCoordinator {
  const listeners = new Map<string, Set<(event: RealtimeChannelEvent) => void>>();
  const presences = new Map<string, Map<string, PresenceRecord>>();
  let nextPresenceRef = 1;
  let disposed = false;

  function subscribe(scope: string, listener: (event: RealtimeChannelEvent) => void): () => void {
    if (disposed) {
      throw new Error("Realtime channel coordinator is disposed.");
    }
    const scopeListeners = listeners.get(scope) ?? new Set();
    scopeListeners.add(listener);
    listeners.set(scope, scopeListeners);
    return () => {
      scopeListeners.delete(listener);
      if (scopeListeners.size === 0) {
        listeners.delete(scope);
      }
    };
  }

  function broadcast(event: RealtimeBroadcast): void {
    publish(event);
  }

  function presenceState(scope: string): RealtimePresenceState {
    return groupPresence(presences.get(scope)?.values() ?? []);
  }

  function hasPresence(scope: string, ownerId: string): boolean {
    return presences.get(scope)?.has(ownerId) === true;
  }

  function trackPresence(
    input: Readonly<{
      scope: string;
      ownerId: string;
      key: string;
      actorId: string;
      payload: RealtimeJsonObject;
      expiresAt: number;
    }>,
  ): void {
    const scopePresences = presences.get(input.scope) ?? new Map<string, PresenceRecord>();
    const previous = scopePresences.get(input.ownerId);
    const nextMeta = Object.freeze({
      ...input.payload,
      phx_ref: `mekka-presence-${nextPresenceRef++}`,
      actor_id: input.actorId,
    });
    if (
      previous !== undefined &&
      previous.key === input.key &&
      sameJsonPayload(previous.meta, nextMeta)
    ) {
      scopePresences.set(input.ownerId, Object.freeze({ ...previous, expiresAt: input.expiresAt }));
      return;
    }
    const next = Object.freeze({
      ownerId: input.ownerId,
      key: input.key,
      meta: nextMeta,
      expiresAt: input.expiresAt,
    });
    scopePresences.set(input.ownerId, next);
    presences.set(input.scope, scopePresences);
    publish(
      Object.freeze({
        kind: "presence_diff",
        scope: input.scope,
        joins: groupPresence([next]),
        leaves: previous === undefined ? Object.freeze({}) : groupPresence([previous]),
      }),
    );
  }

  function renewPresence(ownerId: string, expiresAt: number): void {
    for (const scopePresences of presences.values()) {
      const presence = scopePresences.get(ownerId);
      if (presence !== undefined) {
        scopePresences.set(ownerId, Object.freeze({ ...presence, expiresAt }));
      }
    }
  }

  function untrackPresence(ownerId: string): void {
    removePresence((presence) => presence.ownerId === ownerId);
  }

  function sweepPresence(now: number): void {
    removePresence((presence) => presence.expiresAt <= now);
  }

  function removePresence(predicate: (presence: PresenceRecord) => boolean): void {
    for (const [scope, scopePresences] of presences) {
      const removed: PresenceRecord[] = [];
      for (const [ownerId, presence] of scopePresences) {
        if (predicate(presence)) {
          scopePresences.delete(ownerId);
          removed.push(presence);
        }
      }
      if (scopePresences.size === 0) {
        presences.delete(scope);
      }
      if (removed.length > 0) {
        publish(
          Object.freeze({
            kind: "presence_diff",
            scope,
            joins: Object.freeze({}),
            leaves: groupPresence(removed),
          }),
        );
      }
    }
  }

  function publish(event: RealtimeChannelEvent): void {
    if (disposed) {
      return;
    }
    for (const listener of listeners.get(event.scope) ?? []) {
      listener(event);
    }
  }

  function dispose(): void {
    disposed = true;
    listeners.clear();
    presences.clear();
  }

  return Object.freeze({
    subscribe,
    broadcast,
    presenceState,
    hasPresence,
    trackPresence,
    renewPresence,
    untrackPresence,
    sweepPresence,
    dispose,
  });
}

function groupPresence(records: Iterable<PresenceRecord>): RealtimePresenceState {
  const grouped = new Map<string, RealtimePresenceMeta[]>();
  for (const record of records) {
    const metas = grouped.get(record.key) ?? [];
    metas.push(record.meta);
    grouped.set(record.key, metas);
  }
  return Object.freeze(
    Object.fromEntries(
      [...grouped].map(([key, metas]) => [key, Object.freeze({ metas: Object.freeze(metas) })]),
    ),
  );
}

function sameJsonPayload(left: RealtimePresenceMeta, right: RealtimePresenceMeta): boolean {
  const { phx_ref: _leftRef, ...leftPayload } = left;
  const { phx_ref: _rightRef, ...rightPayload } = right;
  return JSON.stringify(leftPayload) === JSON.stringify(rightPayload);
}
