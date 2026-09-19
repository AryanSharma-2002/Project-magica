import type { RunStore } from "@/agent/loop/ports";

/** Prisma implementation of RunStore. Implemented by the backend-core slice. */
export function createRunStore(): RunStore {
  throw new Error("createRunStore not implemented");
}
