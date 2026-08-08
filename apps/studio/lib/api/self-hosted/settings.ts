import { components } from "api-types";

import { assertSelfHosted } from "./util";
import {
  PROJECT_DB_HOST,
  PROJECT_ENDPOINT,
  PROJECT_ENDPOINT_PROTOCOL,
} from "@/lib/constants/api";

type ProjectAppConfig =
  components["schemas"]["ProjectSettingsResponse"]["app_config"] & {
    protocol?: string;
  };

export type ProjectSettings =
  components["schemas"]["ProjectSettingsResponse"] & {
    app_config?: ProjectAppConfig;
  };

/**
 * Gets self-hosted project settings
 *
 * _Only call this from server-side self-hosted code._
 */
export function getProjectSettings(): ProjectSettings {
  assertSelfHosted();

  const response: ProjectSettings = {
    app_config: {
      db_schema: "main",
      endpoint: PROJECT_ENDPOINT,
      storage_endpoint: PROJECT_ENDPOINT,
      // manually added to force the frontend to use the correct URL
      protocol: PROJECT_ENDPOINT_PROTOCOL,
    },
    cloud_provider: "AWS",
    db_dns_name: "-",
    db_host: PROJECT_DB_HOST,
    db_ip_addr_config: "legacy" as const,
    db_name: "sqlite",
    db_port: 0,
    db_user: "local",
    inserted_at: "2021-08-02T06:40:40.646Z",
    jwt_secret: "",
    name: process.env.DEFAULT_PROJECT_NAME || "Local Project",
    ref: "local",
    region: "local",
    service_api_keys: [],
    ssl_enforced: false,
    status: "ACTIVE_HEALTHY",
  };

  return response;
}
