import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import type { ToolContext } from "@/agent/tools/types";
import { cropImageTool, normalizeOutput, toProviderInput } from "@/agent/tools/definitions/crop-image";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeCtx(): ToolContext {
  return { userId: "u1", runId: "r1", chatId: "c1", invocationId: "inv1", toolCallId: "call1", signal: new AbortController().signal, log: logger(), attachments: [] };
}

describe("crop_image toProviderInput", () => {
  it("maps the percent mode straight through", () => {
    expect(toProviderInput({ image_url: "https://x/y.png", x_percent: 10, y_percent: 20, width_percent: 30, height_percent: 40 })).toEqual({
      image_url: "https://x/y.png",
      x_percent: 10,
      y_percent: 20,
      width_percent: 30,
      height_percent: 40,
    });
  });

  it("maps crop{} to the percent fields", () => {
    expect(toProviderInput({ image_url: "https://x/y.png", crop: { x: 5, y: 6, width: 7, height: 8 } })).toEqual({
      image_url: "https://x/y.png",
      x_percent: 5,
      y_percent: 6,
      width_percent: 7,
      height_percent: 8,
    });
  });

  it("maps the pixel mode, omitting x_px/y_px when centered (not provided)", () => {
    expect(toProviderInput({ image_url: "https://x/y.png", width_px: 100, height_px: 200 })).toEqual({
      image_url: "https://x/y.png",
      width_px: 100,
      height_px: 200,
    });
  });

  it("includes x_px/y_px when an exact pixel position is given", () => {
    expect(toProviderInput({ image_url: "https://x/y.png", x_px: 1, y_px: 2, width_px: 100, height_px: 200 })).toEqual({
      image_url: "https://x/y.png",
      x_px: 1,
      y_px: 2,
      width_px: 100,
      height_px: 200,
    });
  });
});

describe("crop_image normalizeOutput", () => {
  it("accepts a raw array (provider shape) and takes the first URL", () => {
    expect(normalizeOutput({ image_url: ["https://cdn/a.png", "https://cdn/b.png"] })).toEqual({ image_url: "https://cdn/a.png" });
  });

  it("accepts a bare string too", () => {
    expect(normalizeOutput({ image_url: "https://cdn/a.png" })).toEqual({ image_url: "https://cdn/a.png" });
  });

  it("throws provider_error on an empty/missing result", () => {
    expect(() => normalizeOutput({ image_url: [] })).toThrow();
    expect(() => normalizeOutput({})).toThrow();
  });
});

describe("crop_image estimate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the live Magica estimate-credits result when available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { estimates: [{ microcredits: 9_999 }] })));
    const value = await cropImageTool.estimate({ image_url: "https://x/y.png", x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 }, makeCtx());
    expect(value).toBe(9_999);
  });

  it("falls back to the static per_item default when the provider estimate fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));
    const value = await cropImageTool.estimate({ image_url: "https://x/y.png", x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 }, makeCtx());
    expect(value).toBe(5_000);
  });
});
