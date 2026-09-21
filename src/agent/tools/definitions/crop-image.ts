import { CropImageInput, CropImageOutput } from "@agent-chat/contracts";
import { AppError } from "@/lib/errors";
import { defineTool } from "../types";
import { runMagicaJob } from "@/agent/providers/magica";
import { assetExpiresAt, catalogCostFallback, estimateWithFallback, guessMimeType, normalizeToSingleUrl, pickNumberField, normalizeSettledOutput } from "./shared";

const NODE_TYPE = "crop_image";
const STATIC_MICROCREDITS = 5_000;

/** Maps the contract's three crop modes (percent / pixel / crop{}) to Magica's flat field set. */
export function toProviderInput(input: CropImageInput): Record<string, unknown> {
  if (input.crop) {
    return {
      image_url: input.image_url,
      x_percent: input.crop.x,
      y_percent: input.crop.y,
      width_percent: input.crop.width,
      height_percent: input.crop.height,
    };
  }
  if (input.x_percent !== undefined) {
    return {
      image_url: input.image_url,
      x_percent: input.x_percent,
      y_percent: input.y_percent,
      width_percent: input.width_percent,
      height_percent: input.height_percent,
    };
  }
  const px: Record<string, unknown> = { image_url: input.image_url, width_px: input.width_px, height_px: input.height_px };
  if (input.x_px !== undefined) px.x_px = input.x_px;
  if (input.y_px !== undefined) px.y_px = input.y_px;
  return px;
}

export function normalizeOutput(raw: unknown): CropImageOutput {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const url = normalizeToSingleUrl(obj.image_url);
  if (!url) {
    throw new AppError("provider_error", "Media provider returned an unexpected result", { retryable: true });
  }
  return CropImageOutput.parse({ image_url: url });
}

export const cropImageTool = defineTool({
  name: "crop_image",
  label: "Crop image",
  description: "Crops a rectangle out of an image, specified by percent, pixels, or a crop box.",
  group: "media",
  input: CropImageInput,
  output: CropImageOutput,
  creditModel: { type: "per_item", microcredits: STATIC_MICROCREDITS },
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
          staticDefault: STATIC_MICROCREDITS,
          log: ctx.log,
          // Catalog `cost.value` is denominated in credits (verified live: 0.005 -> 5,000 µc).
          pick: (cost) => {
            const credits = pickNumberField(cost, "value");
            return credits !== undefined ? Math.round(credits * 1_000_000) : undefined;
          },
        }),
    }),

  execute: async (input, ctx) => {
    const { run, providerRunId, durationMs } = await runMagicaJob({ nodeType: NODE_TYPE, providerInput: toProviderInput(input), ctx });
    return { output: normalizeSettledOutput(run, providerRunId, normalizeOutput), providerRunId, microcreditsCharged: run.creditUsed ?? 0, durationMs };
  },

  effects: (output, ctx) => [
    {
      type: "asset",
      asset: {
        kind: "image",
        url: output.image_url,
        toolCallId: ctx.toolCallId,
        mimeType: guessMimeType(output.image_url, "image"),
        ...(assetExpiresAt(output.image_url) ? { expiresAt: assetExpiresAt(output.image_url) } : {}),
      },
    },
  ],
});
