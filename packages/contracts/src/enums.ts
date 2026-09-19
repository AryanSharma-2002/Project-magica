import { z } from "zod";

export const MessageRole = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof MessageRole>;

export const MessageStatus = z.enum(["pending", "streaming", "completed", "failed", "cancelled"]);
export type MessageStatus = z.infer<typeof MessageStatus>;

/** Server-owned run lifecycle. `waiting` = paused at a human waitpoint. `stopping` = cancel requested. */
export const RunStatus = z.enum(["queued", "running", "waiting", "stopping", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;
export const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting", "stopping"] as const satisfies readonly RunStatus[];
export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const satisfies readonly RunStatus[];

export const ToolInvocationStatus = z.enum([
  "pending",
  "waiting_approval",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type ToolInvocationStatus = z.infer<typeof ToolInvocationStatus>;

export const WaitpointType = z.enum(["approval", "options", "plan", "credit"]);
export type WaitpointType = z.infer<typeof WaitpointType>;

export const WaitpointStatus = z.enum(["pending", "completed", "expired", "cancelled"]);
export type WaitpointStatus = z.infer<typeof WaitpointStatus>;

export const AttachmentKind = z.enum(["image", "video", "audio", "file"]);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

export const AttachmentSource = z.enum(["upload", "library", "generated"]);
export type AttachmentSource = z.infer<typeof AttachmentSource>;

export const AttachmentStatus = z.enum(["uploading", "processing", "ready", "failed", "expired"]);
export type AttachmentStatus = z.infer<typeof AttachmentStatus>;

export const LedgerEntryType = z.enum(["grant", "reserve", "release", "charge", "refund", "adjust"]);
export type LedgerEntryType = z.infer<typeof LedgerEntryType>;

export const ToolGroup = z.enum(["media", "skills", "system"]);
export type ToolGroup = z.infer<typeof ToolGroup>;

export const WebhookEventType = z.enum(["agent.started", "agent.completed", "agent.failed", "tool.completed"]);
export type WebhookEventType = z.infer<typeof WebhookEventType>;
