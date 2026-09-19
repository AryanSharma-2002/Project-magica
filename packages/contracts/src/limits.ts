import { z } from "zod";

/**
 * Product limits are BACKEND-OWNED. The frontend reads them from GET /api/v1/config
 * and never hardcodes them. These are the server defaults.
 */
export const AppLimits = z.object({
  maxMessageChars: z.number().int().positive(),
  maxAttachmentsPerMessage: z.number().int().positive(),
  /** Transloadit Community plan: 0.5 GB per file. */
  maxFileBytes: z.number().int().positive(),
  /** Transloadit Community plan: 5 GB / month, service stops at the cap. */
  monthlyUploadBytes: z.number().int().positive(),
  allowedMimeTypes: z.array(z.string()),
  maxToolCallsPerTurn: z.number().int().positive(),
  maxTurnsPerRun: z.number().int().positive(),
  waitpointTimeoutSeconds: z.number().int().positive(),
  /** Minimum refundable admission reserved at send time. */
  admissionMicrocredits: z.number().int().nonnegative(),
  /** Tool estimates above this require an approval waitpoint. */
  approvalThresholdMicrocredits: z.number().int().nonnegative(),
});
export type AppLimits = z.infer<typeof AppLimits>;

export const DEFAULT_LIMITS: AppLimits = {
  maxMessageChars: 20_000,
  maxAttachmentsPerMessage: 10,
  maxFileBytes: 500 * 1024 * 1024,
  monthlyUploadBytes: 5 * 1024 * 1024 * 1024,
  allowedMimeTypes: [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "audio/mpeg",
    "audio/wav",
    "audio/mp4",
    "audio/webm",
  ],
  maxToolCallsPerTurn: 8,
  maxTurnsPerRun: 12,
  waitpointTimeoutSeconds: 600,
  admissionMicrocredits: 10_000,
  approvalThresholdMicrocredits: 50_000,
};

export const ModelInfo = z.object({
  /** Only "openrouter/free" is accepted at the boundary; paid ids are rejected. */
  id: z.literal("openrouter/free"),
  label: z.string(),
  provider: z.literal("openrouter"),
  free: z.literal(true),
  /** Live availability signal for the composer status pill. */
  status: z.enum(["available", "degraded", "unavailable", "unknown"]),
});
export type ModelInfo = z.infer<typeof ModelInfo>;
export const OPENROUTER_FREE_MODEL = "openrouter/free" as const;
