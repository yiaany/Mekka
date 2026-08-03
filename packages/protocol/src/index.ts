export type TenantIdentity = Readonly<{
  organizationId: string;
  projectId: string;
  environmentId: string;
  branchId: string;
  generation: number;
}>;

export type ErrorCode =
  | "validation"
  | "auth"
  | "forbidden"
  | "conflict"
  | "quota"
  | "unsupported"
  | "infrastructure";

export type HealthStatus = Readonly<{
  status: "ok";
  service: string;
}>;
