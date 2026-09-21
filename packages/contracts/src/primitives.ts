import { z } from "zod";

/** Opaque entity id (cuid2 / cuid). */
export const Id = z.string().min(1).max(64);
export type Id = z.infer<typeof Id>;

/** ISO-8601 timestamp with offset, as serialized by the API. */
export const IsoDate = z.string().datetime({ offset: true });
export type IsoDate = z.infer<typeof IsoDate>;

/** Integer microcredits: 1 credit = 1_000_000 microcredits. Safe up to 2^53. */
export const Microcredits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type Microcredits = z.infer<typeof Microcredits>;

/** Signed microcredits (ledger amounts). */
export const SignedMicrocredits = z.number().int().safe();
export type SignedMicrocredits = z.infer<typeof SignedMicrocredits>;

export const HttpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => u.startsWith("https://"), "Only https URLs are allowed");
export type HttpsUrl = z.infer<typeof HttpsUrl>;

/** Free-form but bounded JSON value for provider-neutral payloads (JSONB). */
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(z.string(), JsonValue)]),
);
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonObject = z.record(z.string(), JsonValue);
export type JsonObject = z.infer<typeof JsonObject>;

export const MICROCREDITS_PER_CREDIT = 1_000_000;
