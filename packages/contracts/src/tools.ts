import { z } from "zod";
import { HttpsUrl, Microcredits } from "./primitives";
import { ToolGroup } from "./enums";

/**
 * Tool contracts shared by backend (validation + execution) and frontend (result cards).
 * The backend registry is the single source of truth; this file is what it exposes.
 */

export const CreditModel = z.discriminatedUnion("type", [
  z.object({ type: z.literal("free") }),
  z.object({ type: z.literal("per_item"), microcredits: Microcredits }),
  z.object({ type: z.literal("per_minute"), microcredits: Microcredits, extraPerItem: Microcredits.optional() }),
  z.object({ type: z.literal("tiered"), defaultMicrocredits: Microcredits }),
  z.object({ type: z.literal("provider_estimate") }),
]);
export type CreditModel = z.infer<typeof CreditModel>;

/** Metadata exposed via GET /api/v1/tools. JSON Schema is derived from Zod with z.toJSONSchema. */
export const ToolDescriptor = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().max(80),
  description: z.string().max(1000),
  group: ToolGroup,
  creditModel: CreditModel,
  requiresApproval: z.enum(["never", "above_threshold", "always"]),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  /** Provider run reconciliation (Magica) vs. in-process execution. */
  execution: z.enum(["inline", "durable_child_task"]),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;

// ---------- Magica: crop_image ----------

const pct = z.number().min(0).max(100);
const px = z.number().int().min(0);

/**
 * Accepts image_url plus exactly one complete rectangle:
 *   (a) percent: x_percent,y_percent,width_percent,height_percent
 *   (b) pixels:  x_px,y_px,width_px,height_px  (x/y optional => centered)
 *   (c) crop: { x, y, width, height } in percent (0-100)
 */
export const CropImageInput = z
  .object({
    image_url: HttpsUrl,
    x_percent: pct.optional(),
    y_percent: pct.optional(),
    width_percent: pct.optional(),
    height_percent: pct.optional(),
    x_px: px.optional(),
    y_px: px.optional(),
    width_px: px.min(1).optional(),
    height_px: px.min(1).optional(),
    crop: z.object({ x: pct, y: pct, width: pct.gt(0), height: pct.gt(0) }).optional(),
  })
  .superRefine((v, ctx) => {
    const hasPct = [v.x_percent, v.y_percent, v.width_percent, v.height_percent].some((n) => n !== undefined);
    const fullPct = [v.x_percent, v.y_percent, v.width_percent, v.height_percent].every((n) => n !== undefined);
    const hasPx = [v.width_px, v.height_px, v.x_px, v.y_px].some((n) => n !== undefined);
    const fullPx = v.width_px !== undefined && v.height_px !== undefined;
    const modes = [hasPct, hasPx, v.crop !== undefined].filter(Boolean).length;
    if (modes !== 1) {
      ctx.addIssue({ code: "custom", message: "Provide exactly one crop mode: percent fields, pixel fields, or crop{}" });
      return;
    }
    if (hasPct && !fullPct) ctx.addIssue({ code: "custom", message: "Percent crop requires x_percent, y_percent, width_percent, height_percent" });
    if (hasPct && fullPct && ((v.x_percent as number) + (v.width_percent as number) > 100 || (v.y_percent as number) + (v.height_percent as number) > 100))
      ctx.addIssue({ code: "custom", message: "Percent crop rectangle exceeds image bounds" });
    if (hasPx && !fullPx) ctx.addIssue({ code: "custom", message: "Pixel crop requires width_px and height_px" });
    if (v.crop && (v.crop.x + v.crop.width > 100 || v.crop.y + v.crop.height > 100))
      ctx.addIssue({ code: "custom", message: "crop rectangle exceeds image bounds" });
  });
export type CropImageInput = z.infer<typeof CropImageInput>;

export const CropImageOutput = z.object({ image_url: HttpsUrl });
export type CropImageOutput = z.infer<typeof CropImageOutput>;

// ---------- Magica: gpt_image_2 ----------

export const GptImage2Size = z.enum([
  "Auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
  "Custom",
]);
export const GptImage2Quality = z.enum(["High", "Medium", "Low"]);

/**
 * Baseline contract. At runtime the backend intersects this with the field options resolved
 * from the Magica model catalog (inputFieldOptions), so option lists never go stale.
 * mode is derived: image_urls present => "gpt-image-2-edit", else "gpt-image-2-text".
 */
export const GptImage2Input = z
  .object({
    prompt: z.string().min(1).max(4000),
    /** Optional; an EMPTY array means text mode (callers check `length > 0`). No `.min(1)`: free
     * models routinely send `image_urls: []`, and the live catalog schema defaults it to `[]`, so a
     * parsed input must re-parse cleanly (the durable child task re-validates it). */
    image_urls: z.array(HttpsUrl).max(10).optional(),
    size: GptImage2Size.default("Auto"),
    width: z.number().int().min(1024).max(3840).multipleOf(16).optional(),
    height: z.number().int().min(1024).max(3840).multipleOf(16).optional(),
    quality: GptImage2Quality.default("High"),
    background: z.enum(["Auto", "Opaque", "Transparent"]).default("Auto"),
    n: z.number().int().min(1).max(4).default(1),
    output_format: z.enum(["PNG", "JPEG", "WebP"]).default("PNG"),
  })
  .superRefine((v, ctx) => {
    if (v.size === "Custom") {
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
  });
export type GptImage2Input = z.infer<typeof GptImage2Input>;

export const GptImage2Output = z.object({ images: z.array(HttpsUrl).min(1) });
export type GptImage2Output = z.infer<typeof GptImage2Output>;

// ---------- Magica: merge_videos ----------

export const MergeVideosTransition = z.enum(["none", "fade", "dissolve"]);
export const MergeVideosInput = z.object({
  /** Ordered. Order is preserved end-to-end. */
  video_urls: z.array(HttpsUrl).min(2).max(100),
  transition: MergeVideosTransition.default("none"),
});
export type MergeVideosInput = z.infer<typeof MergeVideosInput>;

export const MergeVideosOutput = z.object({ video_url: HttpsUrl });
export type MergeVideosOutput = z.infer<typeof MergeVideosOutput>;

// ---------- Skills loader tools ----------

export const SkillName = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);

export const LoadSkillInput = z.object({ name: SkillName });
export const LoadSkillOutput = z.object({
  name: SkillName,
  version: z.string().max(32).optional(),
  contentHash: z.string().length(64),
  body: z.string().max(64_000),
  assets: z.array(z.string().max(255)),
});
export type LoadSkillInput = z.infer<typeof LoadSkillInput>;
export type LoadSkillOutput = z.infer<typeof LoadSkillOutput>;

export const ReadSkillAssetInput = z.object({
  name: SkillName,
  /** Relative path inside the skill directory; traversal is rejected server-side. */
  path: z.string().min(1).max(255),
});
export const ReadSkillAssetOutput = z.object({
  name: SkillName,
  path: z.string().max(255),
  contentHash: z.string().length(64),
  mimeType: z.string().max(100),
  content: z.string().max(64_000),
});
export type ReadSkillAssetInput = z.infer<typeof ReadSkillAssetInput>;
export type ReadSkillAssetOutput = z.infer<typeof ReadSkillAssetOutput>;

/** Names are the registry keys; the frontend result-card registry is keyed by these too. */
export const TOOL_NAMES = ["crop_image", "gpt_image_2", "merge_videos", "load_skill", "read_skill_asset"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
