import { MergeVideosInput, MergeVideosOutput } from "@agent-chat/contracts";
import { AppError } from "@/lib/errors";
import { defineTool } from "../types";
import { runMagicaJob } from "@/agent/providers/magica";
import { assetExpiresAt, catalogCostFallback, estimateWithFallback, guessMimeType, normalizeToSingleUrl, pickNumberField, truncateUrlArraysForDisplay } from "./shared";

const NODE_TYPE = "merge_videos";
const STATIC_PER_MINUTE = 40_000;
const STATIC_EXTRA_PER_ITEM = 10_000;

export function toProviderInput(input: MergeVideosInput): Record<string, unknown> {
  // Order is preserved end-to-end: the array is passed through untouched.
  return { video_urls: input.video_urls, transition: input.transition };
}

export function normalizeOutput(raw: unknown): MergeVideosOutput {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const url = normalizeToSingleUrl(obj.video_url);
  if (!url) {
    throw new AppError("provider_error", "Media provider returned an unexpected result", { retryable: true });
  }
  return MergeVideosOutput.parse({ video_url: url });
}

/** No duration is known before the job runs, so this assumes ~1 minute of output for the base tier. Documented in the final report. */
function staticFallback(itemCount: number): number {
  return STATIC_PER_MINUTE + STATIC_EXTRA_PER_ITEM * Math.max(0, itemCount - 1);
}

export const mergeVideosTool = defineTool({
  name: "merge_videos",
  label: "Merge videos",
  description: "Concatenates 2-100 videos in order, with an optional transition between clips.",
  group: "media",
  input: MergeVideosInput,
  output: MergeVideosOutput,
  creditModel: { type: "per_minute", microcredits: STATIC_PER_MINUTE, extraPerItem: STATIC_EXTRA_PER_ITEM },
  requiresApproval: "above_threshold",
  execution: "durable_child_task",

  estimate: async (input, ctx) =>
    estimateWithFallback({
      nodeType: NODE_TYPE,
      providerInput: toProviderInput(input),
      signal: ctx.signal,
      log: ctx.log,
      fallback: () =>
        catalogCostFallback({
          idOrNodeType: NODE_TYPE,
          staticDefault: staticFallback(input.video_urls.length),
          log: ctx.log,
          // The catalog's defaultEstimateMicrocredits for merge_videos is a flat number for the
          // minimum 2-video case (50,000) - using it as-is for a 100-video merge would massively
          // under-estimate and could let a large job slip under the approval threshold. This
          // tool's own cost arithmetic scales with item count, so it is tried FIRST.
          preferCostArithmetic: true,
          // Catalog cost is { type: "per_minute", baseValue, extraPerVideo } in CREDITS (verified
          // live: baseValue 0.04 -> 40,000 µc, extraPerVideo 0.01 -> 10,000 µc).
          pick: (cost) => {
            const baseCredits = pickNumberField(cost, "baseValue", "perMinute", "per_minute");
            if (baseCredits === undefined) return undefined;
            const extraCredits = pickNumberField(cost, "extraPerVideo", "extraPerItem", "extra_per_item") ?? 0;
            const totalCredits = baseCredits + extraCredits * Math.max(0, input.video_urls.length - 1);
            return Math.round(totalCredits * 1_000_000);
          },
        }),
    }),

  execute: async (input, ctx) => {
    const { run, providerRunId, durationMs } = await runMagicaJob({ nodeType: NODE_TYPE, providerInput: toProviderInput(input), ctx });
    return { output: normalizeOutput(run.output), providerRunId, microcreditsCharged: run.creditUsed ?? 0, durationMs };
  },

  effects: (output, ctx) => [
    {
      type: "asset",
      asset: {
        kind: "video",
        url: output.video_url,
        toolCallId: ctx.toolCallId,
        mimeType: guessMimeType(output.video_url, "video"),
        ...(assetExpiresAt(output.video_url) ? { expiresAt: assetExpiresAt(output.video_url) } : {}),
      },
    },
  ],

  sanitizeInput: (input) => truncateUrlArraysForDisplay(input, 20),
});
