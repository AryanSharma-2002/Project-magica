import { z } from "zod";
import { GptImage2Input, GptImage2Output } from "@agent-chat/contracts";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { defineTool } from "../types";
import { catalogFieldsToZod, findCatalogModel, getCatalog, runMagicaJob, type CatalogField } from "@/agent/providers/magica";
import { assetExpiresAt, catalogCostFallback, estimateWithFallback, guessMimeType, normalizeToUrlList } from "./shared";

const NODE_TYPE = "gpt_image_2";
const CATALOG_MODEL_ID = "gpt-image-2";
const STATIC_MICROCREDITS = 273_936;

type GptImage2SubModelId = "gpt-image-2-text" | "gpt-image-2-edit";

export function subModelIdFor(input: GptImage2Input): GptImage2SubModelId {
  return input.image_urls && input.image_urls.length > 0 ? "gpt-image-2-edit" : "gpt-image-2-text";
}

type IssueSink = { addIssue: (issue: { code: "custom"; message: string }) => void };

/**
 * Mirrors GptImage2Input's own `.superRefine` in packages/contracts/src/tools.ts (aspect ratio
 * <= 3:1, 655,360-8,294,400 total pixels for a Custom size). That file is read-only for this
 * slice, so this is a parallel implementation rather than a shared import - see the final report
 * for a proposed contracts export so this stops needing to be kept in sync by hand. Applied to
 * the catalog-built live schema too (buildLiveInputSchema), since the catalog only carries these
 * bounds as free-text `helpText`, not as machine-checkable constraints.
 *
 * The "missing width/height" branch is unreachable given the current live catalog in practice:
 * its `size` customFields declare `default: 1024` for both, and catalogFieldsToZod applies
 * catalog defaults for non-required fields - so an omitted width/height resolves to 1024x1024 (a
 * valid 1:1 ratio) before this refine ever runs. It's kept as a guard against a future catalog
 * change that drops that default (this function is only used by the live-schema path; the static
 * GptImage2Input fallback has its own superRefine with no such default, so it never defaults
 * width/height at all).
 */
function customSizeChecks(v: { size?: string; width?: number; height?: number }, ctx: IssueSink): void {
  if (v.size !== "Custom") return;
  if (v.width === undefined || v.height === undefined) {
    ctx.addIssue({ code: "custom", message: "Custom size requires width and height" });
    return;
  }
  const long = Math.max(v.width, v.height);
  const short = Math.min(v.width, v.height);
  const pixels = v.width * v.height;
  if (long / short > 3) ctx.addIssue({ code: "custom", message: "Aspect ratio must be <= 3:1" });
  if (pixels < 655_360 || pixels > 8_294_400) ctx.addIssue({ code: "custom", message: "Total pixels must be within 655,360-8,294,400" });
}

/**
 * Builds the live input schema from the catalog's `gpt-image-2` sub-models, so option lists
 * (size/quality/background/output_format enums, width/height bounds) stay current without a
 * redeploy. The provider's `uploadedImages` field is renamed to `image_urls` to match our
 * contract naming (ARCHITECTURE.md §5.3: "image_urls mapped from uploadedImages"). The two
 * sub-models' field sets are unioned; a field present in only one sub-model is optional in the
 * merged schema since which sub-model applies is derived from `image_urls`, not chosen by the
 * caller.
 *
 * Typing note: the return type is asserted to z.ZodType<GptImage2Input>. The catalog's field
 * list is only known at runtime (a live HTTP response), so there is no way for the compiler to
 * verify the dynamic schema's shape matches the static contract type - that boundary is honest,
 * not accidental. Runtime validation (this schema's own .parse/.safeParse) is what actually
 * enforces correctness at the boundary; z.output<typeof GptImage2Input> is the load-bearing type.
 */
async function buildLiveInputSchema(): Promise<z.ZodType<GptImage2Input>> {
  const catalog = await getCatalog();
  const model = findCatalogModel(catalog, CATALOG_MODEL_ID);
  const subModels = model?.subModels ?? [];
  if (subModels.length === 0) throw new Error(`Magica catalog has no sub-models for ${CATALOG_MODEL_ID}`);

  // A field is required in the merged schema only if it is present in EVERY sub-model and
  // required in all of them (e.g. `prompt`). Verified live: `uploadedImages` (renamed to
  // `image_urls`) is `required: true` but present ONLY on the "gpt-image-2-edit" sub-model - it
  // must still end up optional here, since the caller doesn't pick a sub-model directly
  // (subModelIdFor derives it from whether image_urls was supplied).
  const presence = new Map<string, { field: CatalogField; count: number; allRequired: boolean }>();
  for (const subModel of subModels) {
    for (const field of subModel.inputFieldOptions) {
      const renamed: CatalogField = field.zodExpectedName === "uploadedImages" ? { ...field, zodExpectedName: "image_urls" } : field;
      const entry = presence.get(renamed.zodExpectedName);
      if (!entry) {
        presence.set(renamed.zodExpectedName, { field: renamed, count: 1, allRequired: Boolean(renamed.required) });
      } else {
        entry.count += 1;
        entry.allRequired = entry.allRequired && Boolean(renamed.required);
        entry.field = renamed;
      }
    }
  }
  const merged: CatalogField[] = [...presence.values()].map(({ field, count, allRequired }) => ({
    ...field,
    required: allRequired && count === subModels.length,
  }));

  const schema = catalogFieldsToZod(merged, { mode: "input" }).superRefine((v, ctx) => customSizeChecks(v as { size?: string; width?: number; height?: number }, ctx));
  return schema as unknown as z.ZodType<GptImage2Input>;
}

export function toProviderInput(input: GptImage2Input): Record<string, unknown> {
  const providerInput: Record<string, unknown> = {
    prompt: input.prompt,
    size: input.size,
    quality: input.quality,
    background: input.background,
    n: input.n,
    output_format: input.output_format,
  };
  if (input.size === "Custom") {
    if (input.width !== undefined) providerInput.width = input.width;
    if (input.height !== undefined) providerInput.height = input.height;
  }
  if (input.image_urls && input.image_urls.length > 0) providerInput.uploadedImages = input.image_urls;
  return providerInput;
}

/**
 * Live shape (verified 2026-09-21, run cmuaw742r0013l304egohpdlm): gpt_image_2 does NOT follow the
 * `image_url` convention of crop_image. It returns
 * `{ result: string[], provider, creditUsed, resultMetadata: [{ width, height, mimeType, ... }] }`.
 * `images` / `image_url` are kept as fallbacks for the other shapes seen in the catalog docs.
 */
export function normalizeOutput(raw: unknown): GptImage2Output {
  let images: string[] = [];
  if (typeof raw === "string") {
    images = [raw];
  } else if (Array.isArray(raw)) {
    images = normalizeToUrlList(raw);
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    images = normalizeToUrlList(obj.result ?? obj.images ?? obj.image_url);
  }
  if (images.length === 0) {
    throw new AppError("provider_error", "Media provider returned an unexpected result", { retryable: true });
  }
  return GptImage2Output.parse({ images });
}

export const gptImage2Tool = defineTool<z.ZodType<GptImage2Input>, typeof GptImage2Output>({
  name: "gpt_image_2",
  label: "Generate or edit image",
  description: "Generates a new image from a prompt, or edits up to 10 supplied images with a prompt.",
  group: "media",
  input: GptImage2Input,
  output: GptImage2Output,
  creditModel: { type: "tiered", defaultMicrocredits: STATIC_MICROCREDITS },
  requiresApproval: "above_threshold",
  execution: "durable_child_task",

  resolveInputSchema: async () => {
    try {
      return await buildLiveInputSchema();
    } catch (err) {
      logger().warn({ err }, "gpt_image_2: falling back to the baseline input schema (catalog unavailable)");
      return GptImage2Input;
    }
  },

  estimate: async (input, ctx) => {
    const subModelId = subModelIdFor(input);
    return estimateWithFallback({
      nodeType: NODE_TYPE,
      subModelId,
      providerInput: toProviderInput(input),
      signal: ctx.signal,
      log: ctx.log,
      fallback: () =>
        catalogCostFallback({
          idOrNodeType: CATALOG_MODEL_ID,
          subModelId,
          staticDefault: STATIC_MICROCREDITS,
          log: ctx.log,
          // In practice defaultEstimateMicrocredits (checked first, inside catalogCostFallback)
          // always wins for this model - this only runs if that field is ever removed. Verified
          // live shape: { type: "tiered", tiers: { "High:1024x1024": 0.21072, ... } }, values in
          // CREDITS.
          pick: (cost) => {
            const tiers = (cost as { tiers?: Record<string, number> } | undefined)?.tiers;
            const credits = tiers?.[`${input.quality}:${input.size}`];
            return typeof credits === "number" ? Math.round(credits * 1_000_000) : undefined;
          },
        }),
    });
  },

  execute: async (input, ctx) => {
    const subModelId = subModelIdFor(input);
    const { run, providerRunId, durationMs } = await runMagicaJob({
      nodeType: NODE_TYPE,
      subModelId,
      providerInput: toProviderInput(input),
      ctx,
    });
    return { output: normalizeOutput(run.output), providerRunId, microcreditsCharged: run.creditUsed ?? 0, durationMs };
  },

  effects: (output, ctx) =>
    output.images.map((url) => ({
      type: "asset" as const,
      asset: {
        kind: "image" as const,
        url,
        toolCallId: ctx.toolCallId,
        mimeType: guessMimeType(url, "image"),
        ...(assetExpiresAt(url) ? { expiresAt: assetExpiresAt(url) } : {}),
      },
    })),
});
