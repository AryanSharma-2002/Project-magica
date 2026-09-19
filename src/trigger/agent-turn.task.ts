import { task } from "@trigger.dev/sdk";

export type AgentTurnPayload = { runId: string };

/**
 * Durable agent turn. Implemented by the magica-durable slice:
 * wires RunDeps (Prisma RunStore, credits, OpenRouter, registry, realtime emitter, durable executor,
 * waitpoint port) and calls runAgentTurn(runId, deps). See ARCHITECTURE.md §5.2.
 */
export const agentTurnTask = task({
  id: "agent-turn",
  maxDuration: 3600,
  retry: { maxAttempts: 1 },
  run: async (_payload: AgentTurnPayload) => {
    throw new Error("agent-turn not implemented");
  },
});
