import type { ContentBlock, JsonValue, SafeError, ToolInvocationStatus } from "@agent-chat/contracts";
import { AppError, errors } from "@/lib/errors";
import type { LlmToolCall } from "@/agent/llm/types";
import type { ToolRegistry } from "@/agent/tools/registry";
import type { AnyToolDefinition, ToolContext, ToolEffect } from "@/agent/tools/types";
import { liveToolState } from "./blocks";
import type { RunDeps, RunRecord } from "./ports";

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parseToolCallArguments(raw: string): { ok: true; value: unknown } | { ok: false; issues: Array<{ path: string; message: string }> } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, issues: [{ path: "", message: "Arguments are not valid JSON" }] };
  }
}

function jsonSummary(value: unknown, maxLen: number): string {
  try {
    return JSON.stringify(value).slice(0, maxLen);
  } catch {
    return "";
  }
}

export function summarizeCallForPlan(call: LlmToolCall, tools: ToolRegistry): string {
  let label = call.name;
  try {
    label = tools.get(call.name).label;
  } catch {
    /* unknown tool name at plan time; fall back to the raw call name */
  }
  const parsed = parseToolCallArguments(call.arguments);
  const summary = parsed.ok ? jsonSummary(parsed.value, 200) : call.arguments.slice(0, 200);
  return `${label}: ${summary}`;
}

export function waitpointExpiredError(): SafeError {
  return new AppError("waitpoint_expired", "Approval timed out. Send a new message to continue.", { retryable: false }).toSafe();
}

/** Dedupe key for skills tools only: (tool, skillName[, assetPath]). Used both to seed the cache
 * from a resumed run's snapshot and to short-circuit re-execution within the same run. */
export function skillDedupeKey(toolName: string, input: unknown): string | undefined {
  if (toolName === "load_skill" && isRecord(input) && typeof input.name === "string") return `load_skill:${input.name}`;
  if (toolName === "read_skill_asset" && isRecord(input) && typeof input.name === "string" && typeof input.path === "string") {
    return `read_skill_asset:${input.name}:${input.path}`;
  }
  return undefined;
}

function isTerminalStatus(status: ToolInvocationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function statusToResultStatus(status: ToolInvocationStatus): "completed" | "failed" | "cancelled" {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function pushToolUse(blocks: ContentBlock[], call: LlmToolCall, invocationId: string, input: JsonValue): void {
  blocks.push({ type: "tool_use", toolCallId: call.id, invocationId, toolName: call.name, input });
}

function pushToolResult(
  blocks: ContentBlock[],
  call: LlmToolCall,
  invocationId: string,
  patch: { status: "completed" | "failed" | "cancelled"; output?: JsonValue; error?: SafeError; durationMs?: number; microcredits?: number },
): void {
  blocks.push({
    type: "tool_result",
    toolCallId: call.id,
    invocationId,
    toolName: call.name,
    status: patch.status,
    ...(patch.output !== undefined ? { output: patch.output } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
    ...(patch.microcredits !== undefined ? { microcredits: patch.microcredits } : {}),
  });
}

function buildToolContext(args: { deps: RunDeps; run: RunRecord; invocationId: string; call: LlmToolCall; attachments: ToolContext["attachments"] }): ToolContext {
  return {
    userId: args.run.userId,
    runId: args.run.id,
    chatId: args.run.chatId,
    invocationId: args.invocationId,
    toolCallId: args.call.id,
    signal: args.deps.signal,
    log: args.deps.log,
    attachments: args.attachments,
  };
}

async function applyEffects(args: { deps: RunDeps; run: RunRecord; assistantMessageId: string; invocationId: string; effects: ToolEffect[] }): Promise<ContentBlock[]> {
  const assetBlocks: ContentBlock[] = [];
  for (const effect of args.effects) {
    if (effect.type === "record_skill") {
      await args.deps.store.recordSkill(args.run.id, effect.skillName, effect.assetPath, effect.contentHash);
    } else {
      const saved = await args.deps.store.saveGeneratedAssets({
        runId: args.run.id,
        userId: args.run.userId,
        chatId: args.run.chatId,
        messageId: args.assistantMessageId,
        invocationId: args.invocationId,
        assets: [effect.asset],
      });
      assetBlocks.push(...saved);
    }
  }
  return assetBlocks;
}

/** Runs `worker` over `items` in chunks of at most `limit` concurrently, chunk by chunk. */
export async function runWithConcurrencyLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let start = 0; start < items.length; start += limit) {
    const chunk = items.slice(start, start + limit);
    const settled = await Promise.allSettled(chunk.map((item) => worker(item)));
    results.push(...settled);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

export type ToolBatchOutcome = { kind: "continue" } | { kind: "stop"; status: "failed"; error: SafeError } | { kind: "stop"; status: "cancelled" };

export type ToolBatchArgs = {
  toolCalls: LlmToolCall[];
  /** Mutated in place: tool_use / tool_result / asset blocks are appended directly. */
  blocks: ContentBlock[];
  deps: RunDeps;
  run: RunRecord;
  assistantMessageId: string;
  attachments: ToolContext["attachments"];
  isFirstBatch: boolean;
  /** Consecutive-malformed-call counter per tool name; persists across turns of the same run. */
  malformedStreak: Map<string, number>;
  /** In-run cache of (skillTool, args) -> validated output, for load_skill/read_skill_asset dedupe. */
  skillCache: Map<string, unknown>;
  now: () => Date;
};

type ReadyForExecution = { call: LlmToolCall; tool: AnyToolDefinition; parsedInput: unknown; invocationId: string; estimate: number; toolUseIndex: number };

export async function processToolBatch(ctx: ToolBatchArgs): Promise<ToolBatchOutcome> {
  const { toolCalls, blocks, deps, run, assistantMessageId, attachments, now } = ctx;
  const cap = deps.limits.maxToolCallsPerTurn;

  // ---- plan-mode gate: the first batch of the run only ----
  let planDeclined = false;
  if (ctx.isFirstBatch && run.planMode && toolCalls.length > 0) {
    const steps = toolCalls.slice(0, cap).map((c) => ({ id: c.id.slice(0, 64), title: summarizeCallForPlan(c, deps.tools).slice(0, 300) }));
    await deps.store.setStatus(run.id, "waiting");
    const ask = await deps.waitpoints.ask({
      runId: run.id,
      toolInvocationId: null,
      type: "plan",
      prompt: { type: "plan", title: "Proposed steps", steps },
      timeoutSeconds: deps.limits.waitpointTimeoutSeconds,
    });
    if (ask.outcome.kind === "expired") return { kind: "stop", status: "failed", error: waitpointExpiredError() };
    if (ask.outcome.kind === "cancelled") return { kind: "stop", status: "cancelled" };
    await deps.store.setStatus(run.id, "running");
    const resolution = ask.outcome.resolution;
    if (resolution.type === "plan" && !resolution.approved) planDeclined = true;
  }

  const readyForExecution: ReadyForExecution[] = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]!;

    // ---- per-turn tool-call cap: overflow calls are cancelled without preparation ----
    if (i >= cap) {
      const invocationId = (
        await deps.store.createInvocation({ runId: run.id, messageId: assistantMessageId, toolCallId: call.id, toolName: call.name, input: {}, blockIndex: blocks.length, microcreditsEstimated: 0 })
      ).invocationId;
      pushToolUse(blocks, call, invocationId, {});
      await deps.store.updateInvocation(invocationId, { status: "cancelled", finishedAt: now() });
      pushToolResult(blocks, call, invocationId, { status: "cancelled" });
      continue;
    }

    // ---- parse & validate arguments ----
    const parsedArgs = parseToolCallArguments(call.arguments);
    let tool: AnyToolDefinition | undefined;
    let parseError: AppError | undefined;
    let parsedInput: unknown;
    if (!parsedArgs.ok) {
      parseError = new AppError("malformed_tool_call", `Invalid arguments for tool ${call.name}`, { details: { toolName: call.name, issues: parsedArgs.issues } });
    } else {
      try {
        parsedInput = await deps.tools.parseInput(call.name as never, parsedArgs.value);
        tool = deps.tools.get(call.name);
      } catch (err) {
        parseError = AppError.from(err, { code: "malformed_tool_call" });
      }
    }

    if (parseError) {
      const streak = (ctx.malformedStreak.get(call.name) ?? 0) + 1;
      ctx.malformedStreak.set(call.name, streak);

      const bestEffortInput: JsonValue = parsedArgs.ok ? (parsedArgs.value as JsonValue) : { raw: call.arguments.slice(0, 2000) };
      const invocationId = (
        await deps.store.createInvocation({
          runId: run.id,
          messageId: assistantMessageId,
          toolCallId: call.id,
          toolName: call.name,
          input: bestEffortInput,
          blockIndex: blocks.length,
          microcreditsEstimated: 0,
        })
      ).invocationId;
      pushToolUse(blocks, call, invocationId, bestEffortInput);
      await deps.store.updateInvocation(invocationId, { status: "failed", error: parseError.toSafe(), finishedAt: now() });
      pushToolResult(blocks, call, invocationId, { status: "failed", error: parseError.toSafe() });

      if (streak >= 2) {
        return {
          kind: "stop",
          status: "failed",
          error: new AppError("malformed_tool_call", `The model repeatedly sent invalid arguments for ${call.name}.`, { retryable: false }).toSafe(),
        };
      }
      continue;
    }

    ctx.malformedStreak.set(call.name, 0);
    const activeTool = tool!;

    // ---- skill dedupe short-circuit (load_skill / read_skill_asset only) ----
    const dedupeKey = skillDedupeKey(activeTool.name, parsedInput);
    if (dedupeKey !== undefined && ctx.skillCache.has(dedupeKey)) {
      const cachedOutput = ctx.skillCache.get(dedupeKey);
      const sanitized = (activeTool.sanitizeInput?.(parsedInput as never) ?? (parsedInput as JsonValue)) as JsonValue;
      const invocationId = (
        await deps.store.createInvocation({ runId: run.id, messageId: assistantMessageId, toolCallId: call.id, toolName: activeTool.name, input: sanitized, blockIndex: blocks.length, microcreditsEstimated: 0 })
      ).invocationId;
      pushToolUse(blocks, call, invocationId, sanitized);
      const provisionalCtx = buildToolContext({ deps, run, invocationId, call, attachments });
      const effects = activeTool.effects?.(cachedOutput as never, provisionalCtx) ?? [];
      await applyEffects({ deps, run, assistantMessageId, invocationId, effects });
      await deps.store.updateInvocation(invocationId, { status: "completed", output: cachedOutput as JsonValue, microcreditsCharged: 0, durationMs: 0, finishedAt: now() });
      pushToolResult(blocks, call, invocationId, { status: "completed", output: cachedOutput as JsonValue, microcredits: 0, durationMs: 0 });
      continue;
    }

    // ---- estimate (placeholder ctx: the real invocationId does not exist until createInvocation
    // below, which itself requires the estimate; see final report for the spine note on this) ----
    const estimateCtx = buildToolContext({ deps, run, invocationId: call.id, call, attachments });
    const estimate = await activeTool.estimate(parsedInput as never, estimateCtx);
    const sanitized = (activeTool.sanitizeInput?.(parsedInput as never) ?? (parsedInput as JsonValue)) as JsonValue;
    const blockIndex = blocks.length;
    const created = await deps.store.createInvocation({
      runId: run.id,
      messageId: assistantMessageId,
      toolCallId: call.id,
      toolName: activeTool.name,
      input: sanitized,
      blockIndex,
      microcreditsEstimated: estimate,
    });
    pushToolUse(blocks, call, created.invocationId, sanitized);

    if (created.existing && isTerminalStatus(created.status)) {
      const error: SafeError | undefined = created.status === "failed" ? { code: "internal", message: "This tool call previously failed.", retryable: false } : undefined;
      pushToolResult(blocks, call, created.invocationId, {
        status: statusToResultStatus(created.status),
        ...(created.output !== null ? { output: created.output } : {}),
        ...(error ? { error } : {}),
        microcredits: created.microcreditsCharged,
      });
      continue;
    }

    if (planDeclined) {
      await deps.store.updateInvocation(created.invocationId, { status: "cancelled", finishedAt: now() });
      pushToolResult(blocks, call, created.invocationId, { status: "cancelled" });
      continue;
    }

    // ---- approval ----
    const needsApproval = activeTool.requiresApproval === "always" || (activeTool.requiresApproval === "above_threshold" && estimate > deps.limits.approvalThresholdMicrocredits);
    if (needsApproval) {
      await deps.store.setStatus(run.id, "waiting");
      await deps.store.updateInvocation(created.invocationId, { status: "waiting_approval" });
      const description = jsonSummary(sanitized, 2000);
      const ask = await deps.waitpoints.ask({
        runId: run.id,
        toolInvocationId: created.invocationId,
        type: "approval",
        prompt: {
          type: "approval",
          title: `Approve ${activeTool.label}?`.slice(0, 200),
          ...(description.length > 0 ? { description } : {}),
          toolName: activeTool.name,
          toolCallId: call.id,
          input: sanitized,
          microcreditsEstimated: estimate,
        },
        timeoutSeconds: deps.limits.waitpointTimeoutSeconds,
      });

      if (ask.outcome.kind === "expired") {
        await deps.store.updateInvocation(created.invocationId, { status: "cancelled", finishedAt: now() });
        pushToolResult(blocks, call, created.invocationId, { status: "cancelled" });
        return { kind: "stop", status: "failed", error: waitpointExpiredError() };
      }
      if (ask.outcome.kind === "cancelled") {
        await deps.store.updateInvocation(created.invocationId, { status: "cancelled", finishedAt: now() });
        pushToolResult(blocks, call, created.invocationId, { status: "cancelled" });
        return { kind: "stop", status: "cancelled" };
      }
      await deps.store.setStatus(run.id, "running");
      const resolution = ask.outcome.resolution;
      const approved = resolution.type === "approval" && resolution.approved;
      if (!approved) {
        await deps.store.updateInvocation(created.invocationId, { status: "cancelled", finishedAt: now() });
        pushToolResult(blocks, call, created.invocationId, { status: "cancelled" });
        continue;
      }
    }

    // ---- credit check (explicit pre-check + defense-in-depth on the reserve call itself) ----
    const balance = await deps.credits.balance(run.userId);
    if (balance < estimate) {
      const error = errors.insufficientCredits(estimate, balance).toSafe();
      await deps.store.updateInvocation(created.invocationId, { status: "failed", error, finishedAt: now() });
      pushToolResult(blocks, call, created.invocationId, { status: "failed", error });
      return { kind: "stop", status: "failed", error };
    }
    try {
      await deps.credits.reserveInvocation({ userId: run.userId, runId: run.id, invocationId: created.invocationId, microcredits: estimate });
    } catch (err) {
      const appErr = AppError.from(err, { code: "insufficient_credits" });
      await deps.store.updateInvocation(created.invocationId, { status: "failed", error: appErr.toSafe(), finishedAt: now() });
      pushToolResult(blocks, call, created.invocationId, { status: "failed", error: appErr.toSafe() });
      return { kind: "stop", status: "failed", error: appErr.toSafe() };
    }

    readyForExecution.push({ call, tool: activeTool, parsedInput, invocationId: created.invocationId, estimate, toolUseIndex: blockIndex });
  }

  // ---- parallel execution (concurrency <= 4); results appended in ORIGINAL CALL ORDER ----
  if (readyForExecution.length > 0) {
    const settled = await runWithConcurrencyLimit(readyForExecution, 4, (item) => executeOne({ deps, run, assistantMessageId, attachments, item, now, skillCache: ctx.skillCache }));
    for (let i = 0; i < readyForExecution.length; i++) {
      const item = readyForExecution[i]!;
      const result = settled[i]!;
      if (result.status === "fulfilled") {
        blocks.push(...result.value);
      } else {
        const appErr = AppError.from(result.reason);
        blocks.push({ type: "tool_result", toolCallId: item.call.id, invocationId: item.invocationId, toolName: item.tool.name, status: "failed", error: appErr.toSafe() });
      }
    }
  }

  return { kind: "continue" };
}

async function executeOne(args: {
  deps: RunDeps;
  run: RunRecord;
  assistantMessageId: string;
  attachments: ToolContext["attachments"];
  item: ReadyForExecution;
  now: () => Date;
  skillCache: Map<string, unknown>;
}): Promise<ContentBlock[]> {
  const { deps, run, item, now } = args;
  const startedAt = now();
  await deps.store.updateInvocation(item.invocationId, { status: "running", startedAt });
  deps.realtime.metadata({
    tools: { [item.call.id]: liveToolState({ invocationId: item.invocationId, toolName: item.tool.name, status: "running", index: item.toolUseIndex, startedAt: startedAt.toISOString() }) },
  });

  const ctx: ToolContext = {
    userId: run.userId,
    runId: run.id,
    chatId: run.chatId,
    invocationId: item.invocationId,
    toolCallId: item.call.id,
    signal: deps.signal,
    log: deps.log,
    onProgress: (progress, label) => deps.realtime.metadata({ progress, ...(label !== undefined ? { step: label } : {}) }),
    attachments: args.attachments,
  };

  try {
    const raw =
      item.tool.execution === "inline"
        ? await item.tool.execute(item.parsedInput as never, ctx)
        : await deps.durable.execute({ invocationId: item.invocationId, toolName: item.tool.name, input: item.parsedInput, ctx });
    const output = deps.tools.parseOutput(item.tool.name, raw.output) as JsonValue;
    const dedupeKey = skillDedupeKey(item.tool.name, item.parsedInput);
    if (dedupeKey !== undefined) args.skillCache.set(dedupeKey, output);
    await deps.credits.settleInvocation({ userId: run.userId, runId: run.id, invocationId: item.invocationId, estimated: item.estimate, charged: raw.microcreditsCharged });
    const assetBlocks = await applyEffects({
      deps,
      run,
      assistantMessageId: args.assistantMessageId,
      invocationId: item.invocationId,
      effects: item.tool.effects?.(output as never, ctx) ?? [],
    });
    const finishedAt = now();
    await deps.store.updateInvocation(item.invocationId, {
      status: "completed",
      output,
      providerRunId: raw.providerRunId ?? null,
      durationMs: raw.durationMs,
      microcreditsCharged: raw.microcreditsCharged,
      finishedAt,
    });
    deps.realtime.metadata({
      tools: {
        [item.call.id]: liveToolState({
          invocationId: item.invocationId,
          toolName: item.tool.name,
          status: "completed",
          index: item.toolUseIndex,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          microcredits: raw.microcreditsCharged,
          providerRunId: raw.providerRunId ?? null,
        }),
      },
    });
    const resultBlock: ContentBlock = {
      type: "tool_result",
      toolCallId: item.call.id,
      invocationId: item.invocationId,
      toolName: item.tool.name,
      status: "completed",
      output,
      durationMs: raw.durationMs,
      microcredits: raw.microcreditsCharged,
    };
    return [...assetBlocks, resultBlock];
  } catch (err) {
    const appErr = AppError.from(err);
    await deps.credits.releaseInvocation({ userId: run.userId, runId: run.id, invocationId: item.invocationId, estimated: item.estimate }).catch(() => {});
    const finishedAt = now();
    await deps.store.updateInvocation(item.invocationId, { status: "failed", error: appErr.toSafe(), finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime() });
    deps.realtime.metadata({
      tools: {
        [item.call.id]: liveToolState({
          invocationId: item.invocationId,
          toolName: item.tool.name,
          status: "failed",
          index: item.toolUseIndex,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          error: appErr.toSafe(),
        }),
      },
    });
    return [{ type: "tool_result", toolCallId: item.call.id, invocationId: item.invocationId, toolName: item.tool.name, status: "failed", error: appErr.toSafe() }];
  }
}
