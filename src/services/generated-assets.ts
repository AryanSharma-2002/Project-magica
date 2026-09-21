import { AttachmentKind as AttachmentKindContract, type JsonValue } from "@agent-chat/contracts";
import type { AnyToolDefinition, ToolContext, ToolEffect } from "@/agent/tools/types";
import { prisma } from "@/lib/db";
import type { Logger } from "@/lib/logger";
import { generatedAssetKey, getMediaStore } from "@/lib/storage/s3";

/**
 * Generated-asset persistence shared by the two places a Magica tool's output becomes durable:
 *   - in-chat runs: the agent loop applies the tool's asset effects through
 *     RunStore.saveGeneratedAssets (src/services/run-store.ts), which attaches the asset to the
 *     assistant message;
 *   - standalone public-API runs (`POST /tools/:name/run`, ToolInvocation.runId = null): there is
 *     no loop, chat or message, so the magica-tool child task calls persistStandaloneToolAssets.
 * Both copy the provider's expiring URL into the S3 bucket when storage is configured
 * (src/lib/storage/s3.ts) and keep the provider URL otherwise. Storage trouble never fails a run.
 */

export type GeneratedAsset = Extract<ToolEffect, { type: "asset" }>["asset"];

export const DEFAULT_MIME_BY_KIND: Record<string, string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/mpeg",
  file: "application/octet-stream",
};

export function deriveFilename(url: string, invocationId: string, index: number): string {
  try {
    const { pathname } = new URL(url);
    const base = pathname.split("/").filter(Boolean).pop();
    if (base) return decodeURIComponent(base).slice(0, 255);
  } catch {
    /* fall through to synthetic name */
  }
  return `generated-${invocationId}-${index}`;
}

export function attachmentKindDb(kind: string): "IMAGE" | "VIDEO" | "AUDIO" | "FILE" {
  return AttachmentKindContract.parse(kind).toUpperCase() as "IMAGE" | "VIDEO" | "AUDIO" | "FILE";
}

export type StoredGeneratedAsset = {
  url: string;
  sizeBytes: number;
  expiresAt: Date | null;
  /** Present only when the asset was copied into the bucket: where it came from. */
  meta?: { sourceUrl: string };
};

/**
 * Copies one provider asset into the bucket when storage is configured and returns what the
 * Attachment row should record. On any storage problem (or no store) the provider URL and its
 * expiry are kept, so callers never have to handle a failure.
 */
export async function storeGeneratedAsset(args: {
  userId: string;
  invocationId: string;
  index: number;
  asset: GeneratedAsset;
  mimeType: string;
  log: Logger;
  signal?: AbortSignal;
}): Promise<StoredGeneratedAsset> {
  const fallback: StoredGeneratedAsset = {
    url: args.asset.url,
    sizeBytes: 0,
    expiresAt: args.asset.expiresAt ? new Date(args.asset.expiresAt) : null,
  };
  const store = getMediaStore();
  if (!store) return fallback;
  try {
    const key = generatedAssetKey({ userId: args.userId, invocationId: args.invocationId, index: args.index, sourceUrl: args.asset.url, mimeType: args.mimeType });
    const stored = await store.putFromUrl({ sourceUrl: args.asset.url, key, contentType: args.mimeType, ...(args.signal ? { signal: args.signal } : {}) });
    return { url: stored.url, sizeBytes: stored.sizeBytes, expiresAt: null, meta: { sourceUrl: args.asset.url } };
  } catch (err) {
    args.log.warn({ err, index: args.index }, "generated asset copy to S3 failed; keeping the provider URL");
    return fallback;
  }
}

/** Replaces every string leaf that exactly equals a key of `map` with its value. */
function replaceUrls(value: JsonValue, map: ReadonlyMap<string, string>): JsonValue {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => replaceUrls(v, map));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceUrls(v as JsonValue, map)]));
  }
  return value;
}

/**
 * Standalone public-API tool run: derives the tool's asset effects from its parsed output (the
 * same `effects` the agent loop uses), stores each asset, records an Attachment row per asset
 * (chatId/messageId null, linked by toolInvocationId) and returns `output` with every provider
 * URL that was copied replaced by its durable URL. Never throws: on failure the provider output
 * is returned unchanged.
 */
export async function persistStandaloneToolAssets(args: { tool: AnyToolDefinition; output: JsonValue; ctx: ToolContext; log: Logger }): Promise<JsonValue> {
  try {
    const assets = (args.tool.effects?.(args.output, args.ctx) ?? []).flatMap((effect) => (effect.type === "asset" ? [effect.asset] : []));
    const replacements = new Map<string, string>();
    for (const [index, asset] of assets.entries()) {
      const mimeType = asset.mimeType ?? DEFAULT_MIME_BY_KIND[asset.kind] ?? "application/octet-stream";
      const stored = await storeGeneratedAsset({ userId: args.ctx.userId, invocationId: args.ctx.invocationId, index, asset, mimeType, log: args.log, signal: args.ctx.signal });
      await prisma.attachment.create({
        data: {
          userId: args.ctx.userId,
          chatId: null,
          messageId: null,
          toolInvocationId: args.ctx.invocationId,
          kind: attachmentKindDb(asset.kind),
          source: "GENERATED",
          status: "READY",
          filename: deriveFilename(asset.url, args.ctx.invocationId, index),
          mimeType,
          sizeBytes: stored.sizeBytes,
          url: stored.url,
          previewUrl: stored.url,
          width: asset.width ?? null,
          height: asset.height ?? null,
          durationMs: asset.durationMs ?? null,
          expiresAt: stored.expiresAt,
          ...(stored.meta ? { meta: stored.meta } : {}),
        },
      });
      if (stored.url !== asset.url) replacements.set(asset.url, stored.url);
    }
    return replacements.size === 0 ? args.output : replaceUrls(args.output, replacements);
  } catch (err) {
    args.log.warn({ err }, "standalone tool run: persisting generated assets failed; keeping the provider output");
    return args.output;
  }
}
