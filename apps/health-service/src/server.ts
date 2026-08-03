import { app } from "./app";
import type { ServiceConfig } from "./config";
import { logEvent, type LogWriter } from "./logger";

export type RunningHealthService = Readonly<{
  stop: () => void;
}>;

export function startHealthService(
  config: ServiceConfig,
  writeLog: LogWriter = logEvent,
): RunningHealthService {
  const server = app.listen({ hostname: config.host, port: config.port });
  let stopping = false;

  writeLog({ event: "service_started", host: config.host, port: config.port });

  return {
    stop() {
      if (stopping) {
        return;
      }

      stopping = true;
      server.stop();
      writeLog({ event: "service_stopped", host: config.host, port: config.port });
    },
  };
}
