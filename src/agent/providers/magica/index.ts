import { prisma } from "@/lib/db";
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
 * It persists `providerRunId` on the ToolInvocation the instant the 202 response is known, and
 * resumes by polling (skipping the POST) when a `providerRunId` is already present - covering
 * both "duplicate dispatch" (ARCHITECTURE §5.3) and a crashed-and-retried child task.
 *
 * NOTE ON THE SPINE: src/agent/tools/types.ts says "Tools never touch chat state, credits, or
 * messages" and ToolContext has no hook for provider-run reconciliation. This function is a
 * narrow, explicitly-specified exception (ARCHITECTURE §5.3: "persist providerRunId ... via
 * prisma.toolInvocation.update immediately after the 202"). See the final report for a proposed
 * `ToolContext.onProviderRunId` addition that would let tool `execute()` stay DB-free.
 */
export async function runMagicaJob(args: MagicaJobArgs): Promise<MagicaJobResult> {
  const started = Date.now();
  const existing = await prisma.toolInvocation.findUnique({
    where: { id: args.ctx.invocationId },
    select: { providerRunId: true },
  });

  let providerRunId = existing?.providerRunId ?? null;
  if (!providerRunId) {
    const created = await runNode({
      nodeType: args.nodeType,
      input: args.providerInput,
      ...(args.subModelId ? { subModelId: args.subModelId } : {}),
      signal: args.ctx.signal,
    });
    providerRunId = created.runId;
    await prisma.toolInvocation.update({ where: { id: args.ctx.invocationId }, data: { providerRunId } });
  }

  const run = await pollRun(providerRunId, {
    signal: args.ctx.signal,
    onProgress: (r) => args.ctx.onProgress?.(progressForStatus(r.status), r.status),
  });

  return { run, providerRunId, durationMs: Date.now() - started };
}
