import { DEFAULT_LIMITS, RUN_METADATA_VERSION, type AppLimits, type RunMetadata } from "@agent-chat/contracts";
import type { RunDeps, RunSnapshot } from "@/agent/loop/ports";
import { getEnv } from "@/lib/env";
import { logger, type Logger } from "@/lib/logger";
import { createRunStore } from "@/services/run-store";
import { createCreditPort } from "@/lib/credits";
import { createLlmProvider } from "@/agent/llm";
import { getSkillRegistry } from "@/agent/skills";
import { toolRegistry } from "@/agent/tools";
import { createRealtimeEmitter } from "./realtime";
import { createDurableExecutor } from "./durable";
import { createWaitpointPort } from "./waitpoints";

/** DEFAULT_LIMITS + the env-overridable knobs (ARCHITECTURE.md §7). */
export function buildLimits(): AppLimits {
  const env = getEnv();
  return {
    ...DEFAULT_LIMITS,
    admissionMicrocredits: env.ADMISSION_MICROCREDITS,
    approvalThresholdMicrocredits: env.APPROVAL_THRESHOLD_MICROCREDITS,
  };
}

function initialRunMetadata(snapshot: RunSnapshot, now: () => Date): RunMetadata {
  return {
    v: RUN_METADATA_VERSION,
    runId: snapshot.run.id,
    chatId: snapshot.run.chatId,
    assistantMessageId: snapshot.run.assistantMessageId,
    status: snapshot.run.status,
    step: null,
    progress: null,
    thinkingStartedAt: null,
    thinkingMs: null,
    routedModel: null,
    tools: {},
    waitpoint: null,
    assets: [],
    reasoning: [],
    error: null,
    persistedUpTo: -1,
    updatedAt: now().toISOString(),
  };
}

export type BuildRunDepsArgs = { runId: string; triggerRunId: string; signal: AbortSignal; now?: () => Date; log?: Logger };

/**
 * Builds RunDeps for one agent-turn task attempt. Loads the run snapshot first (needed for the
 * initial RunMetadata's chatId/assistantMessageId/status), then wires the rest of the ports
 * around it. Returns the snapshot too, so the caller doesn't have to load it a second time.
 */
export async function buildRunDeps(args: BuildRunDepsArgs): Promise<{ deps: RunDeps; snapshot: RunSnapshot }> {
  const now = args.now ?? (() => new Date());
  const log = args.log ?? logger({ runId: args.runId, triggerRunId: args.triggerRunId });

  const store = createRunStore();
  const snapshot = await store.loadSnapshot(args.runId);

  const realtime = createRealtimeEmitter(initialRunMetadata(snapshot, now));
  // Force the initial full-snapshot write immediately (an empty patch is a no-op merge, but the
  // very first scheduled write is never throttled - see adapters/realtime.ts's scheduleWrite).
  realtime.metadata({});

  const deps: RunDeps = {
    llm: createLlmProvider(),
    tools: toolRegistry,
    skills: getSkillRegistry(),
    store,
    credits: createCreditPort(),
    realtime,
    durable: createDurableExecutor(),
    waitpoints: createWaitpointPort({ realtime }),
    limits: buildLimits(),
    signal: args.signal,
    log,
    now,
  };

  return { deps, snapshot };
}
