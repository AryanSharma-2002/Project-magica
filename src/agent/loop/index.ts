import type { RunDeps, RunOutcome } from "./ports";

/** Implemented by the agent-engine slice. See ports.ts for the contract. */
export async function runAgentTurn(_runId: string, _deps: RunDeps): Promise<RunOutcome> {
  throw new Error("runAgentTurn not implemented");
}
