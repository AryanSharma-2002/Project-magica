import type { ToolContext } from "@/agent/tools/types";
import { pollRun, runNode, type MagicaRun } from "./client";

export * from "./client";
export * from "./catalog";
export * from "./schema-from-catalog";
export * from "./errors";

export type MagicaJobArgs = {
  nodeType: string;
  subModelId?: string;
  providerInput: Record<string, unknown>;
  ctx: ToolContext;
};

export type MagicaJobResult = { run: MagicaRun; providerRunId: string; durationMs: number };

function progressForStatus(status: MagicaRun["status"]): number {
  switch (status) {
    case "QUEUED":
      return 0.1;
    case "RUNNING":
      return 0.5;
    case "COMPLETED":
      return 1;
    default:
      return 0.1;
  }
}

/**
 * Shared POST + persist + poll glue for the three `durable_child_task` Magica tools
 * (ARCHITECTURE.md §5.3). This runs INSIDE the magica-tool child task (see
 * src/trigger/magica-tool.task.ts), which is why it is safe for it to touch Prisma directly.
 *
 * It reports `providerRunId` through ctx.onProviderRunId the instant the 202 response is known
 * (orchestration persists it) and resumes by polling (skipping the POST) when
 * ctx.existingProviderRunId is set. The provider itself never touches the database.
 */
export async function runMagicaJob(args: MagicaJobArgs): Promise<MagicaJobResult> {
  const started = Date.now();
  let providerRunId = args.ctx.existingProviderRunId ?? null;
  if (!providerRunId) {
    const created = await runNode({
      nodeType: args.nodeType,
      input: args.providerInput,
      ...(args.subModelId ? { subModelId: args.subModelId } : {}),
      signal: args.ctx.signal,
    });
    providerRunId = created.runId;
    await args.ctx.onProviderRunId?.(providerRunId);
  }

  const run = await pollRun(providerRunId, {
    signal: args.ctx.signal,
    onProgress: (r) => args.ctx.onProgress?.(progressForStatus(r.status), r.status),
  });

  return { run, providerRunId, durationMs: Date.now() - started };
}
