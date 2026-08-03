export interface LogEvent {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  processor: string;
  processor_version: string;
  message: string;
  job_id?: string;
  capture_id?: string;
  record_id?: string;
  stage?: string;
  error_code?: string;
  duration_ms?: number;
}

export interface Logger { log(event: Omit<LogEvent, "timestamp">): void }

export function createStructuredLogger(
  sink: (line: string) => void = (line) => console.error(line),
): Logger {
  return { log: (event) => sink(JSON.stringify({ timestamp: new Date().toISOString(), ...event })) };
}

export const NOOP_LOGGER: Logger = { log: () => undefined };
