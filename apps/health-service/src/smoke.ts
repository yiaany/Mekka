export {};

const port = 32000 + Math.floor(Math.random() * 1000);
const url = `http://127.0.0.1:${port}/health`;
const events: string[] = [];
const { startHealthService } = await import("./server");
const service = startHealthService({ host: "127.0.0.1", port }, (event) => {
  events.push(event.event);
});

try {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Health endpoint returned HTTP ${response.status}.`);
  }

  const body: unknown = await response.json();

  if (JSON.stringify(body) !== JSON.stringify({ status: "ok", service: "health-service" })) {
    throw new Error("Health endpoint returned an unexpected response body.");
  }
} finally {
  service.stop();
}

if (events.join(",") !== "service_started,service_stopped") {
  throw new Error("Health service did not write complete lifecycle logs.");
}
