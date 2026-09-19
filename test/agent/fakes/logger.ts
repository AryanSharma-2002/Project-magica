import type { Logger } from "@/lib/logger";

export function noopLoggerForTests(): Logger {
  const fn = () => noop;
  const noop = { info: fn, warn: fn, error: fn, debug: fn, trace: fn, fatal: fn, child: () => noopLoggerForTests() };
  return noop as unknown as Logger;
}
