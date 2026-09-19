import pino, { type Logger } from "pino";
import { getEnv } from "./env";

/**
 * Structured logs. Every log line carries processId; child loggers add
 * traceId, chatId, runId, messageId, waitpointTokenId, toolInvocationId where applicable.
 */
export type LogContext = Partial<{
  traceId: string;
  chatId: string;
  runId: string;
  messageId: string;
  userId: string;
  toolInvocationId: string;
  waitpointTokenId: string;
  triggerRunId: string;
}>;

const root: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { processId: process.pid, service: "agent-chat-backend" },
  redact: { paths: ["*.authorization", "*.apiKey", "*.secret", "req.headers.authorization"], censor: "[redacted]" },
  ...(process.env.NODE_ENV === "test" ? { enabled: false } : {}),
});

export function logger(ctx: LogContext = {}): Logger {
  try {
    root.level = getEnv().LOG_LEVEL;
  } catch {
    /* env not ready during build */
  }
  return root.child(ctx);
}
export type { Logger };
