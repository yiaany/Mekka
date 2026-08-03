export type LogEvent = Readonly<{
  event: "service_started" | "service_stopped";
  host: string;
  port: number;
}>;

export type LogWriter = (event: LogEvent) => void;

export function logEvent(event: LogEvent): void {
  console.info(JSON.stringify(event));
}
