import type { EngineError } from "@mekka/engine-core";
import type {
  TursoBranchAdapter,
  TursoBranchCreateInput,
  TursoBranchDatabase,
} from "@mekka/turso-branch";

export const tursoDatabaseTokenPrefix = "db-token-";

export type StubAdapter = TursoBranchAdapter & {
  providerDatabases(): string[];
  removeProviderResource(name: string): void;
  setCreateFailure(error: EngineError | null): void;
  setStatusFailure(error: EngineError | null): void;
  setDeleteFailure(error: EngineError | null): void;
  createCalls(): number;
  deleteCalls(): number;
};

export function createStubAdapter(): StubAdapter {
  const databases = new Map<string, { record: TursoBranchDatabase; token: string }>();
  let createFailure: EngineError | null = null;
  let statusFailure: EngineError | null = null;
  let deleteFailure: EngineError | null = null;
  let creates = 0;
  let deletes = 0;

  return {
    capabilities: () => Object.freeze({ provider: "turso", supported: true, reason: null }),
    async probe() {
      return Object.freeze({ ok: true, error: null });
    },
    async createBranch(input: TursoBranchCreateInput) {
      creates += 1;
      if (createFailure !== null) throw createFailure;
      const record = Object.freeze({
        resourceId: `id-${input.name}`,
        name: input.name,
        hostname: `${input.name}.example.turso.io`,
        group: "default",
        parentName: "main",
      });
      databases.set(input.name, { record, token: `${tursoDatabaseTokenPrefix}${input.name}` });
      return Object.freeze({
        database: record,
        token: `${tursoDatabaseTokenPrefix}${input.name}`,
        tokenExpiresAt: Date.now() + input.tokenExpirationSeconds * 1000,
      });
    },
    async getBranchStatus(name: string) {
      if (statusFailure !== null) throw statusFailure;
      const entry = databases.get(name);
      return entry === undefined
        ? Object.freeze({ exists: false, database: null })
        : Object.freeze({ exists: true, database: entry.record });
    },
    async deleteBranch(name: string) {
      deletes += 1;
      if (deleteFailure !== null) throw deleteFailure;
      databases.delete(name);
      return Object.freeze({ deleted: true });
    },
    publicInfo: () =>
      Object.freeze({
        provider: "turso",
        organization: "acme",
        group: "default",
        sourceDatabase: "main",
        baseUrl: "https://api.turso.tech",
      }),
    providerDatabases: () => [...databases.keys()],
    removeProviderResource(name: string) {
      databases.delete(name);
    },
    setCreateFailure(error) {
      createFailure = error;
    },
    setStatusFailure(error) {
      statusFailure = error;
    },
    setDeleteFailure(error) {
      deleteFailure = error;
    },
    createCalls: () => creates,
    deleteCalls: () => deletes,
  };
}
