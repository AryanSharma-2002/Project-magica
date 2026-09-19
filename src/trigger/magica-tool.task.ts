import { task } from "@trigger.dev/sdk";

export type MagicaToolPayload = { invocationId: string };

/**
 * Child task for durable Magica tool execution (idempotencyKey = invocationId).
 * Implemented by the magica-durable slice. See ARCHITECTURE.md §5.3.
 */
export const magicaToolTask = task({
  id: "magica-tool",
  maxDuration: 900,
  retry: { maxAttempts: 1 },
  run: async (_payload: MagicaToolPayload) => {
    throw new Error("magica-tool not implemented");
  },
});
