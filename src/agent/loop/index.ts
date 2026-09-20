import type { AssetBlock, ContentBlock, RunUsage, SafeError, TextBlock, ThinkingBlock } from "@agent-chat/contracts";
import { AppError } from "@/lib/errors";
import type { LlmMessage, LlmProvider, LlmRequest, LlmToolCall } from "@/agent/llm/types";
import type { ProviderToolSpec } from "@/agent/tools/registry";
import { buildSystemPrompt } from "@/agent/prompt/system";
import { assistantBlocksToLlmMessages, historyToLlmMessages } from "@/agent/prompt/history";
import { seedSkillCache } from "./skills";
import { processToolBatch } from "./tools";
import { accumulateUsage, buildUsageBlock, emptyUsage } from "./usage";
import { backoffMs, defaultRandom, defaultSleep, isRetryableProviderError, MAX_LLM_ATTEMPTS, terminalCodeAfterExhaustion, type RandomFn, type Sleep } from "./retry";
import type { RunDeps, RunOutcome, RunRecord } from "./ports";

// ---------------------------------------------------------------------------
// Single LLM streaming attempt: turns provider events into blocks/realtime.
// ---------------------------------------------------------------------------

type AttemptResult = {
  finishReason: string;
  toolCalls: LlmToolCall[];
  routedModel: string | null;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
};

async function runOneLlmAttempt(args: { llm: LlmProvider; request: LlmRequest; blocks: ContentBlock[]; realtime: RunDeps["realtime"]; now: () => Date }): Promise<AttemptResult> {
  let active: { type: "text" | "thinking"; index: number } | null = null;
  let thinkingStartedAt: Date | null = null;
  let toolCalls: LlmToolCall[] = [];
  let routedModel: string | null = null;
  let usage: AttemptResult["usage"];
  let finishReason = "stop";

  const finalizeThinking = () => {
    if (!active || active.type !== "thinking" || !thinkingStartedAt) return;
    const ms = args.now().getTime() - thinkingStartedAt.getTime();
    (args.blocks[active.index] as ThinkingBlock).durationMs = ms;
    args.realtime.metadata({ step: null, thinkingStartedAt: null, thinkingMs: ms });
    thinkingStartedAt = null;
  };

  for await (const event of args.llm.stream(args.request)) {
    if (event.type === "text_delta") {
      if (active?.type !== "text") {
        if (active?.type === "thinking") finalizeThinking();
        const index = args.blocks.length;
        args.blocks.push({ type: "text", text: "" });
        active = { type: "text", index };
      }
      (args.blocks[active.index] as TextBlock).text += event.delta;
      args.realtime.text({ t: "text", i: active.index, d: event.delta });
    } else if (event.type === "thinking_delta") {
      if (active?.type !== "thinking") {
        const index = args.blocks.length;
        args.blocks.push({ type: "thinking", text: "" });
        active = { type: "thinking", index };
        thinkingStartedAt = args.now();
        args.realtime.metadata({ step: "Thinking", thinkingStartedAt: thinkingStartedAt.toISOString() });
      }
      (args.blocks[active.index] as ThinkingBlock).text += event.delta;
      args.realtime.text({ t: "thinking", i: active.index, d: event.delta });
    } else if (event.type === "usage") {
      usage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens, totalTokens: event.totalTokens };
      if (!routedModel) routedModel = event.model;
    } else if (event.type === "finish") {
      finishReason = event.reason;
      toolCalls = event.toolCalls;
      if (event.model) routedModel = event.model;
    }
    // tool_call_delta is informational only; the loop acts on the fully accumulated finish.toolCalls.
  }

  finalizeThinking();
  return { finishReason, toolCalls, routedModel, ...(usage ? { usage } : {}) };
}

// ---------------------------------------------------------------------------
// Retry wrapper: up to MAX_LLM_ATTEMPTS, backoff 1s -> 2s, never retries cancellation.
// ---------------------------------------------------------------------------

type LlmTurnOutcome = ({ kind: "success" } & AttemptResult) | { kind: "cancelled" } | { kind: "failed"; error: SafeError };

async function runLlmTurnWithRetry(args: {
  deps: RunDeps;
  helpers: { sleep: Sleep; random: RandomFn };
  blocks: ContentBlock[];
  messages: LlmMessage[];
  providerTools: ProviderToolSpec[];
  run: RunRecord;
  now: () => Date;
}): Promise<LlmTurnOutcome> {
  for (let attemptNumber = 1; attemptNumber <= MAX_LLM_ATTEMPTS; attemptNumber++) {
    if (args.deps.signal.aborted) return { kind: "cancelled" };

    const blocksLenBeforeAttempt = args.blocks.length;
    const attemptController = new AbortController();
    const onAbort = () => attemptController.abort();
    args.deps.signal.addEventListener("abort", onAbort);

    const request: LlmRequest = {
      model: args.run.requestedModel,
      messages: args.messages,
      tools: args.providerTools,
      toolChoice: "auto",
      parallelToolCalls: true,
      signal: attemptController.signal,
      metadata: { runId: args.run.id, chatId: args.run.chatId },
    };

    try {
      const result = await runOneLlmAttempt({ llm: args.deps.llm, request, blocks: args.blocks, realtime: args.deps.realtime, now: args.now });
      return { kind: "success", ...result };
    } catch (err) {
      const appErr = AppError.from(err);
      if (appErr.code === "cancelled" || args.deps.signal.aborted) {
        return { kind: "cancelled" };
      }
      const canRetry = isRetryableProviderError(appErr) && attemptNumber < MAX_LLM_ATTEMPTS;
      if (canRetry) {
        args.blocks.length = blocksLenBeforeAttempt;
        await args.helpers.sleep(backoffMs(attemptNumber + 1, args.helpers.random));
        continue;
      }
      const mappedCode = terminalCodeAfterExhaustion(appErr.code);
      return { kind: "failed", error: { ...appErr.toSafe(), code: mappedCode } };
    } finally {
      args.deps.signal.removeEventListener("abort", onAbort);
    }
  }
  /* istanbul ignore next: unreachable, loop always returns within MAX_LLM_ATTEMPTS iterations */
  return { kind: "failed", error: new AppError("internal", "Unexpected retry loop exit").toSafe() };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/** RunMetadata.assets/reasoning are the live view's source for asset/reasoning blocks (realtime.ts:
 * "the live view builds ... tool/asset/reasoning blocks from metadata"), each bounded and carrying
 * the block's index. Recomputed from `blocks` (cheap at these sizes) rather than tracked
 * incrementally, so it can never drift from what was actually appended. */
function publishAssetsAndReasoning(realtime: RunDeps["realtime"], blocks: ContentBlock[]): void {
  const assets: Array<AssetBlock & { index: number }> = [];
  const reasoning: Array<{ index: number; text: string }> = [];
  blocks.forEach((block, index) => {
    if (block.type === "asset") assets.push({ ...block, index });
    else if (block.type === "reasoning") reasoning.push({ index, text: block.text });
  });
  realtime.metadata({ assets: assets.slice(-20), reasoning: reasoning.slice(-50) });
}

type LoopResult = {
  status: "completed" | "failed" | "cancelled";
  blocks: ContentBlock[];
  usage: RunUsage;
  routedModel: string | null;
  requestedModel: string;
  error?: SafeError;
};

async function runLoop(runId: string, deps: RunDeps, helpers: { sleep: Sleep; random: RandomFn }): Promise<LoopResult> {
  const now = deps.now ?? (() => new Date());
  let blocks: ContentBlock[] = [];
  let usage = emptyUsage();
  let routedModel: string | null = null;
  let requestedModel = "unknown";

  try {
    const snapshot = await deps.store.loadSnapshot(runId);
    requestedModel = snapshot.run.requestedModel;
    blocks = [...snapshot.persistedBlocks];

    const stillActive = await deps.store.markRunning(runId);
    if (!stillActive) {
      return { status: "cancelled", blocks, usage, routedModel, requestedModel };
    }
    // Realtime status must track the store (queued -> running here, running <-> waiting in tools.ts);
    // the frontend gates the streaming label and the waitpoint overlay on it.
    deps.realtime.metadata({ status: "running" });

    const attachmentsForCtx = snapshot.attachments.map((a) => ({ id: a.id, kind: a.kind, url: a.url ?? "", mimeType: a.mimeType }));
    const readyAttachmentsForPrompt = snapshot.attachments.filter((a) => a.status === "ready").map((a) => ({ kind: a.kind, url: a.url ?? "" }));
    const { cache: skillCache, loadedSkillsForPrompt, hashMismatchReasoning } = await seedSkillCache(deps.skills, snapshot.loadedSkills);
    for (const reasoning of hashMismatchReasoning) blocks.push(reasoning);
    if (hashMismatchReasoning.length > 0) publishAssetsAndReasoning(deps.realtime, blocks);

    const malformedStreak = new Map<string, number>();
    let firstBatchDone = false;

    for (let turn = 0; turn < deps.limits.maxTurnsPerRun; turn++) {
      if (deps.signal.aborted || (await deps.store.isCancelRequested(runId))) {
        return { status: "cancelled", blocks, usage, routedModel, requestedModel };
      }

      const systemPrompt = buildSystemPrompt({
        skills: deps.skills,
        limits: deps.limits,
        now: now(),
        attachments: readyAttachmentsForPrompt,
        planMode: snapshot.run.planMode,
        loadedSkills: loadedSkillsForPrompt,
      });
      // historyToLlmMessages replays PAST, persisted assistant Messages; snapshot.history excludes
      // the in-progress assistant message (ports.ts), so this run's OWN blocks so far (text,
      // tool_use, tool_result from earlier turns in THIS run) are appended separately here, whole
      // (never subject to the history char/message bound - it is the live turn, not scrollback).
      const messages: LlmMessage[] = [
        { role: "system", content: systemPrompt },
        ...historyToLlmMessages(snapshot.history, snapshot.attachments),
        ...assistantBlocksToLlmMessages(blocks),
      ];
      const providerTools = await deps.tools.toProviderTools();

      const attempt = await runLlmTurnWithRetry({ deps, helpers, blocks, messages, providerTools, run: snapshot.run, now });
      if (attempt.kind === "cancelled") return { status: "cancelled", blocks, usage, routedModel, requestedModel };
      if (attempt.kind === "failed") return { status: "failed", blocks, usage, routedModel, requestedModel, error: attempt.error };

      usage = accumulateUsage(usage, attempt.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      if (attempt.routedModel) {
        routedModel = attempt.routedModel;
        usage = { ...usage, model: routedModel };
      }

      await deps.store.checkpoint(runId, blocks);
      await deps.store.heartbeat(runId, { routedModel });
      deps.realtime.metadata({ persistedUpTo: blocks.length - 1, ...(routedModel ? { routedModel } : {}) });

      if (attempt.finishReason !== "tool_calls" || attempt.toolCalls.length === 0) {
        return { status: "completed", blocks, usage, routedModel, requestedModel };
      }

      const batchOutcome = await processToolBatch({
        toolCalls: attempt.toolCalls,
        blocks,
        deps,
        run: snapshot.run,
        assistantMessageId: snapshot.run.assistantMessageId,
        attachments: attachmentsForCtx,
        isFirstBatch: !firstBatchDone,
        malformedStreak,
        skillCache,
        now,
      });
      firstBatchDone = true;

      await deps.store.checkpoint(runId, blocks);
      await deps.store.heartbeat(runId);
      deps.realtime.metadata({ persistedUpTo: blocks.length - 1 });
      publishAssetsAndReasoning(deps.realtime, blocks);

      if (batchOutcome.kind === "stop") {
        return {
          status: batchOutcome.status,
          blocks,
          usage,
          routedModel,
          requestedModel,
          ...(batchOutcome.status === "failed" ? { error: batchOutcome.error } : {}),
        };
      }
    }

    return {
      status: "failed",
      blocks,
      usage,
      routedModel,
      requestedModel,
      error: new AppError("max_turns_exceeded", "This turn needed more steps than allowed. Try breaking your request into smaller, separate messages.", {
        retryable: false,
      }).toSafe(),
    };
  } catch (err) {
    return { status: "failed", blocks, usage, routedModel, requestedModel, error: AppError.from(err).toSafe() };
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Builds runAgentTurn with injectable retry timing (sleep/random) for tests. Production code uses
 * the default export `runAgentTurn` below; tests call createAgentLoop({ sleep, random }) to avoid
 * real delays while still exercising the exact backoff schedule.
 */
export function createAgentLoop(overrides: { sleep?: Sleep; random?: RandomFn } = {}) {
  const sleep = overrides.sleep ?? defaultSleep;
  const random = overrides.random ?? defaultRandom;

  return async function runAgentTurn(runId: string, deps: RunDeps): Promise<RunOutcome> {
    const result = await runLoop(runId, deps, { sleep, random });
    const now = deps.now ?? (() => new Date());

    const finalBlocks: ContentBlock[] = [...result.blocks, buildUsageBlock(result.usage, result.requestedModel)];

    // store.finalize is the durable source of truth and MUST be called exactly once regardless of
    // what happens next; realtime is transport-only, so a metadata/flush failure here is logged
    // and swallowed rather than risking a skipped or duplicated finalize.
    await deps.store.finalize(runId, {
      status: result.status,
      blocks: finalBlocks,
      usage: result.usage,
      routedModel: result.routedModel,
      ...(result.error ? { error: result.error } : {}),
    });

    try {
      deps.realtime.metadata({
        status: result.status,
        step: null,
        waitpoint: null,
        progress: null,
        routedModel: result.routedModel,
        persistedUpTo: finalBlocks.length - 1,
        error: result.error ?? null,
        updatedAt: now().toISOString(),
      });
      await deps.realtime.flush();
    } catch (err) {
      deps.log.error({ err, runId }, "failed to publish final realtime metadata (run already finalized in the store)");
    }

    return { status: result.status, ...(result.error ? { error: result.error } : {}) };
  };
}

/** Implemented by the agent-engine slice. See ports.ts for the contract. */
export const runAgentTurn = createAgentLoop();
