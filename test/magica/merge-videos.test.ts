import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import type { ToolContext } from "@/agent/tools/types";
import { mergeVideosTool, normalizeOutput, toProviderInput } from "@/agent/tools/definitions/merge-videos";
import { MergeVideosInput } from "@agent-chat/contracts";
import { __resetMagicaCatalogCacheForTests, __setMagicaCatalogForTests, type MagicaCatalog } from "@/agent/providers/magica/catalog";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeCtx(): ToolContext {
  return { userId: "u1", runId: "r1", chatId: "c1", invocationId: "inv1", toolCallId: "call1", signal: new AbortController().signal, log: logger(), attachments: [] };
}

describe("merge_videos order and transitions", () => {
  it("preserves array order end-to-end into the provider input", () => {
    const urls = ["https://a/1.mp4", "https://a/2.mp4", "https://a/3.mp4"];
    const input = MergeVideosInput.parse({ video_urls: urls, transition: "fade" });
    expect(toProviderInput(input)).toEqual({ video_urls: urls, transition: "fade" });
  });

  it("rejects an invalid transition at the contract boundary", () => {
    expect(MergeVideosInput.safeParse({ video_urls: ["https://a/1.mp4", "https://a/2.mp4"], transition: "spin" }).success).toBe(false);
  });

  it("defaults transition to none", () => {
    expect(MergeVideosInput.parse({ video_urls: ["https://a/1.mp4", "https://a/2.mp4"] }).transition).toBe("none");
  });
});

describe("merge_videos normalizeOutput", () => {
  it("takes the first URL from the provider's video_url array", () => {
    expect(normalizeOutput({ video_url: ["https://cdn/merged.mp4"] })).toEqual({ video_url: "https://cdn/merged.mp4" });
  });

  it("throws on a missing result", () => {
    expect(() => normalizeOutput({ video_url: [] })).toThrow();
  });
});

describe("merge_videos estimate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetMagicaCatalogCacheForTests();
  });

  it("uses the live estimate when available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { estimates: [{ microcredits: 77_000 }] })));
    const input = MergeVideosInput.parse({ video_urls: ["https://a/1.mp4", "https://a/2.mp4"] });
    expect(await mergeVideosTool.estimate(input, makeCtx())).toBe(77_000);
  });

  it("falls back to per_minute + extraPerItem arithmetic for 3 videos when the provider estimate fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));
    const input = MergeVideosInput.parse({ video_urls: ["https://a/1.mp4", "https://a/2.mp4", "https://a/3.mp4"] });
    // base 40_000 + extraPerItem 10_000 * (3-1) = 60_000
    expect(await mergeVideosTool.estimate(input, makeCtx())).toBe(60_000);
  });

  it("scales the catalog fallback with item count instead of using the flat defaultEstimateMicrocredits (preferCostArithmetic)", async () => {
    // A flat defaultEstimateMicrocredits (the catalog's minimum/2-video case) would badly
    // under-estimate a large merge and could let it slip under the approval threshold - the
    // cost-arithmetic path must be tried first for this tool. See catalogCostFallback's doc
    // comment and the "preferCostArithmetic" fix.
    __setMagicaCatalogForTests({
      version: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      models: {
        merge_videos: {
          nodeType: "merge_videos",
          name: "Merge Videos",
          cost: { type: "per_minute", baseValue: 0.04, extraPerVideo: 0.01 },
          subModels: [{ subModelId: "merge_videos", label: "Merge Videos", inputFieldOptions: [], defaultEstimateMicrocredits: 50_000 }],
        },
      },
    } satisfies MagicaCatalog);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {}))); // provider estimate-credits fails
    const input = MergeVideosInput.parse({ video_urls: Array.from({ length: 5 }, (_, i) => `https://a/${i}.mp4`) });
    // 40_000 + 10_000 * (5-1) = 80_000, NOT the flat 50_000 default.
    expect(await mergeVideosTool.estimate(input, makeCtx())).toBe(80_000);
  });
});
