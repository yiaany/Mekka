const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

export type ServiceConfig = Readonly<{
  host: string;
  port: number;
}>;

export function loadServiceConfig(environment: Record<string, string | undefined>): ServiceConfig {
  const host = environment.HOST ?? DEFAULT_HOST;
  const portValue = environment.PORT ?? String(DEFAULT_PORT);

  if (host.length === 0) {
    throw new Error("HOST must not be empty.");
  }

  if (!/^\d+$/.test(portValue)) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const port = Number(portValue);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return { host, port };
}
