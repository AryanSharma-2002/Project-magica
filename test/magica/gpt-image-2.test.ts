import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import type { ToolContext } from "@/agent/tools/types";
import { GptImage2Input } from "@agent-chat/contracts";
import { gptImage2Tool, normalizeOutput, subModelIdFor, toProviderInput } from "@/agent/tools/definitions/gpt-image-2";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeCtx(): ToolContext {
  return { userId: "u1", runId: "r1", chatId: "c1", invocationId: "inv1", toolCallId: "call1", signal: new AbortController().signal, log: logger(), attachments: [] };
}

describe("gpt_image_2 sub-model selection", () => {
  it("picks gpt-image-2-text with no image_urls", () => {
    expect(subModelIdFor(GptImage2Input.parse({ prompt: "a cat" }))).toBe("gpt-image-2-text");
  });

  it("picks gpt-image-2-edit when image_urls is present", () => {
    expect(subModelIdFor(GptImage2Input.parse({ prompt: "add a hat", image_urls: ["https://x/a.png"] }))).toBe("gpt-image-2-edit");
  });
});

describe("gpt_image_2 toProviderInput", () => {
  it("omits width/height when size is not Custom, even if they were somehow set", () => {
    const input = GptImage2Input.parse({ prompt: "a cat", size: "Auto" });
    const providerInput = toProviderInput(input);
    expect(providerInput).not.toHaveProperty("width");
    expect(providerInput).not.toHaveProperty("height");
  });

  it("includes width/height for a Custom size", () => {
    const input = GptImage2Input.parse({ prompt: "a cat", size: "Custom", width: 1024, height: 2048 });
    expect(toProviderInput(input)).toMatchObject({ size: "Custom", width: 1024, height: 2048 });
  });

  it("maps image_urls to the provider's uploadedImages field", () => {
    const input = GptImage2Input.parse({ prompt: "edit", image_urls: ["https://x/a.png", "https://x/b.png"] });
    const providerInput = toProviderInput(input);
    expect(providerInput.uploadedImages).toEqual(["https://x/a.png", "https://x/b.png"]);
    expect(providerInput).not.toHaveProperty("image_urls");
  });

  it("omits uploadedImages entirely for a text-mode call", () => {
    const input = GptImage2Input.parse({ prompt: "a cat" });
    expect(toProviderInput(input)).not.toHaveProperty("uploadedImages");
  });
});

describe("gpt_image_2 normalizeOutput", () => {
  it("accepts { images: string[] }", () => {
    expect(normalizeOutput({ images: ["https://cdn/a.png", "https://cdn/b.png"] })).toEqual({ images: ["https://cdn/a.png", "https://cdn/b.png"] });
  });

  it("accepts { image_url: string } (singular)", () => {
    expect(normalizeOutput({ image_url: "https://cdn/a.png" })).toEqual({ images: ["https://cdn/a.png"] });
  });

  it("accepts a bare string", () => {
    expect(normalizeOutput("https://cdn/a.png")).toEqual({ images: ["https://cdn/a.png"] });
  });

  it("accepts a bare array", () => {
    expect(normalizeOutput(["https://cdn/a.png"])).toEqual({ images: ["https://cdn/a.png"] });
  });

  it("throws provider_error on an unrecognized shape", () => {
    expect(() => normalizeOutput({ nonsense: true })).toThrow();
  });
});

describe("gpt_image_2 estimate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the live estimate-credits result when available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { estimates: [{ microcredits: 500_000 }] })));
    expect(await gptImage2Tool.estimate(GptImage2Input.parse({ prompt: "a cat" }), makeCtx())).toBe(500_000);
  });

  it("falls back to the static tiered default when both the estimate call and the catalog fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));
    expect(await gptImage2Tool.estimate(GptImage2Input.parse({ prompt: "a cat" }), makeCtx())).toBe(273_936);
  });
});
