import { loadServiceConfig } from "./config";
import { startHealthService } from "./server";

const config = loadServiceConfig(process.env);
const service = startHealthService(config);

process.once("SIGINT", service.stop);
process.once("SIGTERM", service.stop);
