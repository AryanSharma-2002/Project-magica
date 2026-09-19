import type {
  AppLimits,
  Attachment,
  ContentBlock,
  JsonValue,
  Message,
  RunMetadata,
  RunStatus,
  RunUsage,
  SafeError,
  TextChunk,
  ToolInvocationStatus,
  WaitpointPrompt,
  WaitpointResolution,
  WaitpointType,
} from "@agent-chat/contracts";
import type { Logger } from "@/lib/logger";
import type { LlmProvider } from "@/agent/llm/types";
import type { ToolRegistry } from "@/agent/tools/registry";
import type { ToolContext, ToolEffect, ToolExecutionResult } from "@/agent/tools/types";
import type { SkillRegistry } from "@/agent/skills/types";

/**
 * Ports the agent loop depends on. Each is implemented by a different slice:
 *   RunStore + CreditPort            -> src/services/run-store.ts, src/lib/credits (backend-core)
 *   RealtimeEmitter, DurableExecutor,
 *   WaitpointPort                    -> src/trigger/adapters/* (magica-durable), running inside the Trigger task
 *   LlmProvider, SkillRegistry, loop -> src/agent/** (agent-engine), tested with in-memory fakes
 */

export type RunRecord = {
  id: string;
  chatId: string;
  userId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: RunStatus;
  planMode: boolean;
  requestedModel: string;
  microcreditsReserved: number;
  cancelRequestedAt: string | null;
};

export type RunSnapshot = {
  run: RunRecord;
  /** Oldest -> newest, bounded window (store decides the bound). Includes the current user message; excludes the assistant placeholder. */
  history: Message[];
  /** READY attachments of the current user message, in position order. */
  attachments: Attachment[];
  /** Skills already recorded on this run (restore on retry/resume). */
  loadedSkills: Array<{ skillName: string; assetPath: string; contentHash: string }>;
  /** Blocks already checkpointed on the assistant message (resume support). */
  persistedBlocks: ContentBlock[];
};

export type InvocationCreate = {
  runId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  blockIndex: number;
  microcreditsEstimated: number;
};

export type InvocationPatch = Partial<{
  status: ToolInvocationStatus;
  output: JsonValue | null;
  error: SafeError | null;
  providerRunId: string | null;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  microcreditsCharged: number;
}>;

export type FinalizeInput = {
  status: "completed" | "failed" | "cancelled";
  blocks: ContentBlock[];
  usage: RunUsage;
  routedModel: string | null;
  error?: SafeError;
};

export interface RunStore {
  loadSnapshot(runId: string): Promise<RunSnapshot>;
  /** QUEUED|RUNNING -> RUNNING (sets startedAt/heartbeat). Returns false if the run is no longer active. */
  markRunning(runId: string): Promise<boolean>;
  /** Updates heartbeatAt (+ optional currentStep / routedModel). Cheap; called every loop step. */
  heartbeat(runId: string, patch?: { currentStep?: string | null; routedModel?: string | null }): Promise<void>;
  isCancelRequested(runId: string): Promise<boolean>;
  /** RUNNING <-> WAITING transitions; no-op if the run is terminal. */
  setStatus(runId: string, status: "running" | "waiting"): Promise<void>;
  /** assistant message content = blocks, status STREAMING. Called after every loop step. */
  checkpoint(runId: string, blocks: ContentBlock[]): Promise<void>;
  /** Idempotent on (runId, toolCallId). `existing` = a previous attempt already created it. */
  createInvocation(input: InvocationCreate): Promise<{
    invocationId: string;
    existing: boolean;
    status: ToolInvocationStatus;
    output: JsonValue | null;
    /** Stored SafeError when a previous attempt failed (resume support). */
    error: SafeError | null;
    providerRunId: string | null;
    microcreditsCharged: number;
  }>;
  updateInvocation(invocationId: string, patch: InvocationPatch): Promise<void>;
  /** Upsert RunSkill; deduplicated=true when the same (skill, asset, hash) was already recorded. */
  recordSkill(runId: string, skillName: string, assetPath: string, contentHash: string): Promise<{ deduplicated: boolean }>;
  /** Creates Attachment(GENERATED) rows and returns asset blocks with attachmentId filled. */
  saveGeneratedAssets(args: { runId: string; userId: string; chatId: string; messageId: string; invocationId: string; assets: Array<Extract<ToolEffect, { type: "asset" }>["asset"]> }): Promise<ContentBlock[]>;
  /** Single transaction: message status/content, run status/usage/routedModel/error/finishedAt, release admission. Idempotent (WHERE status IN active). */
  finalize(runId: string, input: FinalizeInput): Promise<void>;
}

export interface CreditPort {
  balance(userId: string): Promise<number>;
  /** ledger `reserve:<invocationId>`; throws AppError(insufficient_credits). Idempotent. */
  reserveInvocation(args: { userId: string; runId: string; invocationId: string; microcredits: number }): Promise<void>;
  /** ledger `release:<invocationId>` (+estimated) and `charge:<invocationId>` (-charged) in one tx. Idempotent. */
  settleInvocation(args: { userId: string; runId: string; invocationId: string; estimated: number; charged: number }): Promise<void>;
  /** ledger `release:<invocationId>` only (failed/cancelled tool). Idempotent. */
  releaseInvocation(args: { userId: string; runId: string; invocationId: string; estimated: number }): Promise<void>;
}

export interface RealtimeEmitter {
  /** Append a token delta to the agent-text stream. */
  text(chunk: TextChunk): void | Promise<void>;
  /** Shallow-merge into RunMetadata; implementation throttles + flushes. `tools` merges by key. */
  metadata(patch: Partial<Omit<RunMetadata, "v" | "runId" | "chatId" | "assistantMessageId">>): void;
  flush(): Promise<void>;
}

export interface DurableExecutor {
  /** Runs a `durable_child_task` tool in a Trigger child task with idempotencyKey = invocationId. */
  execute(args: { invocationId: string; toolName: string; input: unknown; ctx: ToolContext }): Promise<ToolExecutionResult<unknown>>;
}

export type WaitpointAsk = {
  runId: string;
  toolInvocationId: string | null;
  type: WaitpointType;
  prompt: WaitpointPrompt;
  timeoutSeconds: number;
};

export interface WaitpointPort {
  /** Creates the Trigger token + Waitpoint row, updates metadata, suspends until resolved or expired. */
  ask(args: WaitpointAsk): Promise<{ waitpointId: string; outcome: { kind: "resolved"; resolution: WaitpointResolution } | { kind: "expired" } | { kind: "cancelled" } }>;
}

export type RunDeps = {
  llm: LlmProvider;
  tools: ToolRegistry;
  skills: SkillRegistry;
  store: RunStore;
  credits: CreditPort;
  realtime: RealtimeEmitter;
  durable: DurableExecutor;
  waitpoints: WaitpointPort;
  limits: AppLimits;
  signal: AbortSignal;
  log: Logger;
  now?: () => Date;
};

export type RunOutcome = { status: "completed" | "failed" | "cancelled"; error?: SafeError };

/**
 * Implemented in src/agent/loop/index.ts (agent-engine slice):
 *   export async function runAgentTurn(runId: string, deps: RunDeps): Promise<RunOutcome>
 * Contract: never throws for run-level failures (they are finalized + returned); always calls store.finalize exactly once.
 */
