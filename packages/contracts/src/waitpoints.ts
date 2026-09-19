import { z } from "zod";
import { Id, IsoDate, JsonValue, Microcredits } from "./primitives";
import { WaitpointStatus, WaitpointType } from "./enums";

/** What the UI must render for a pending waitpoint. Adding a waitpoint type = add a variant here + a renderer. */
export const WaitpointPrompt = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approval"),
    title: z.string().max(200),
    description: z.string().max(2000).optional(),
    toolName: z.string().max(64),
    toolCallId: z.string().max(128),
    input: JsonValue,
    microcreditsEstimated: Microcredits,
  }),
  z.object({
    type: z.literal("options"),
    title: z.string().max(200),
    description: z.string().max(2000).optional(),
    multi: z.boolean().default(false),
    options: z
      .array(z.object({ id: z.string().max(64), label: z.string().max(200), description: z.string().max(500).optional() }))
      .min(1)
      .max(12),
  }),
  z.object({
    type: z.literal("plan"),
    title: z.string().max(200),
    steps: z.array(z.object({ id: z.string().max(64), title: z.string().max(300), detail: z.string().max(1000).optional() })).min(1).max(30),
  }),
  z.object({
    type: z.literal("credit"),
    title: z.string().max(200),
    microcreditsRequired: Microcredits,
    microcreditsAvailable: Microcredits,
  }),
]);
export type WaitpointPrompt = z.infer<typeof WaitpointPrompt>;

export const WaitpointResolution = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approval"), approved: z.boolean() }),
  z.object({ type: z.literal("options"), selected: z.array(z.string().max(64)).min(1).max(12) }),
  z.object({ type: z.literal("plan"), approved: z.boolean(), feedback: z.string().max(2000).optional() }),
  z.object({ type: z.literal("credit"), proceed: z.boolean() }),
]);
export type WaitpointResolution = z.infer<typeof WaitpointResolution>;

export const Waitpoint = z.object({
  id: Id,
  runId: Id,
  toolInvocationId: Id.nullable(),
  type: WaitpointType,
  status: WaitpointStatus,
  prompt: WaitpointPrompt,
  resolution: WaitpointResolution.nullable(),
  expiresAt: IsoDate,
  resolvedAt: IsoDate.nullable(),
  createdAt: IsoDate,
});
export type Waitpoint = z.infer<typeof Waitpoint>;
