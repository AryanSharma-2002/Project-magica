import type { JsonValue } from "@agent-chat/contracts";
import type { Logger } from "@/lib/logger";
import { estimateCredits, findCatalogModel, getCatalog } from "@/agent/providers/magica";

/**
 * Small helpers shared by the three Magica tool definitions (crop_image, gpt_image_2,
 * merge_videos). Kept here instead of duplicated per file.
 */

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
};

export function guessMimeType(url: string, kind: "image" | "video"): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop()?.toLowerCase();
    if (ext && MIME_BY_EXTENSION[ext]) return MIME_BY_EXTENSION[ext];
  } catch {
    /* fall through to kind default below */
  }
  return kind === "image" ? "image/png" : "video/mp4";
}

/**
 * Assumption (undocumented by the Magica API): inference-output URLs are treated as temporary
 * (24h expiry) unless the host is a well-known permanent object-storage domain. Magica does not
 * publish a "temporary vs. permanent" flag, so this is a heuristic - documented in the final
 * report.
 */
const PERMANENT_HOST_SUFFIXES = [".amazonaws.com", ".r2.cloudflarestorage.com", ".storage.googleapis.com", ".digitaloceanspaces.com"];

export function looksPermanentHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PERMANENT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

/** ISO expiry 24h from now, or undefined for hosts that look permanent. */
export function assetExpiresAt(url: string, now: () => Date = () => new Date()): string | undefined {
  if (looksPermanentHost(url)) return undefined;
  return new Date(now().getTime() + 24 * 60 * 60 * 1000).toISOString();
}

/** For sanitizeInput: truncates any top-level string-array field to `max` entries (display only). */
export function truncateUrlArraysForDisplay<T extends Record<string, unknown>>(input: T, max = 20): JsonValue {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      out[key] = value.length > max ? [...value.slice(0, max), `…(${value.length - max} more)`] : (value as string[]);
    } else {
      out[key] = value as JsonValue;
    }
  }
  return out;
}

export function normalizeToUrlList(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  return [];
}

export function normalizeToSingleUrl(raw: unknown): string | undefined {
  const list = normalizeToUrlList(raw);
  return list[0];
}

export type EstimateArgs = {
  nodeType: string;
  subModelId?: string;
  providerInput: Record<string, unknown>;
  signal?: AbortSignal;
  log: Logger;
  /** Called only when the live Magica estimate call fails. */
  fallback: () => Promise<number> | number;
};

/** Provider estimate first, then the caller's fallback (catalog cost arithmetic -> static default). */
export async function estimateWithFallback(args: EstimateArgs): Promise<number> {
  try {
    const [microcredits] = await estimateCredits(
      [{ type: args.nodeType, ...(args.subModelId ? { subModelId: args.subModelId } : {}), data: args.providerInput }],
      args.signal,
    );
    if (typeof microcredits === "number" && Number.isFinite(microcredits) && microcredits >= 0) return microcredits;
  } catch (err) {
    args.log.warn({ err, nodeType: args.nodeType }, "Magica estimate-credits failed; using the fallback estimate");
  }
  return args.fallback();
}

/**
 * Catalog-informed fallback estimate, tried when the live Magica estimate-credits call fails.
 * Two sources, order controlled by `preferCostArithmetic`:
 *   - `defaultEstimateMicrocredits` on the (sub)model - a precomputed, authoritative number
 *     already in microcredits. Verified against the live public catalog: gpt-image-2's
 *     sub-models report exactly 273,936, matching this repo's static default for that tool.
 *     BUT it is a single flat number (the minimum/default case) - for a tool whose real cost
 *     scales with the input (merge_videos: per-minute + per-extra-video), using it directly
 *     regardless of input size would under-estimate a large job and could let it slip under the
 *     approval threshold. Callers whose `pick(cost)` arithmetic is input-aware should pass
 *     `preferCostArithmetic: true` to try that FIRST.
 *   - `pick(cost)` - a best-effort interpretation of the loosely-specified `cost` field. `cost.
 *     value` and similar numeric fields are denominated in CREDITS, not microcredits (verified:
 *     crop_image's `cost.value` is 0.005, i.e. 5,000 microcredits) - `pick` is expected to return
 *     microcredits, so callers must multiply by 1_000_000 themselves.
 * Falls back to `staticDefault` if both are unavailable.
 */
export async function catalogCostFallback(args: {
  idOrNodeType: string;
  /** Selects which sub-model's defaultEstimateMicrocredits to prefer; omit for single-sub-model tools. */
  subModelId?: string;
  staticDefault: number;
  log: Logger;
  pick?: (cost: unknown) => number | undefined;
  /** True for tools whose cost scales with input (e.g. merge_videos' item count) - see doc comment above. */
  preferCostArithmetic?: boolean;
}): Promise<number> {
  try {
    const catalog = await getCatalog();
    const model = findCatalogModel(catalog, args.idOrNodeType);
    const subModel = args.subModelId ? model?.subModels?.find((s) => s.subModelId === args.subModelId) : model?.subModels?.[0];
    const fromDefaultEstimate = subModel?.defaultEstimateMicrocredits ?? model?.defaultEstimateMicrocredits;
    const picked = args.pick && model?.cost !== undefined ? args.pick(model.cost) : undefined;

    const candidates = args.preferCostArithmetic ? [picked, fromDefaultEstimate] : [fromDefaultEstimate, picked];
    for (const candidate of candidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
    }
  } catch (err) {
    args.log.warn({ err, idOrNodeType: args.idOrNodeType }, "Magica catalog cost lookup failed; using the static fallback estimate");
  }
  args.log.warn({ idOrNodeType: args.idOrNodeType, staticDefault: args.staticDefault }, "Using the static fallback credit estimate");
  return args.staticDefault;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function pickNumberField(cost: unknown, ...keys: string[]): number | undefined {
  if (typeof cost === "number") return cost;
  const rec = asRecord(cost);
  if (!rec) return undefined;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "number") return v;
  }
  return undefined;
}
