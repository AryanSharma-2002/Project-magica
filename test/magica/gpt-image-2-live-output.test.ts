import { describe, expect, it } from "vitest";
import { normalizeOutput } from "@/agent/tools/definitions/gpt-image-2";

/**
 * Captured from a REAL completed Magica run on 2026-09-21 (run cmuaw742r0013l304egohpdlm, sub-model
 * gpt-image-2-text, quality Low). gpt_image_2 does NOT return `image_url`/`images` like crop_image:
 * the URLs are under `result`, with per-image `resultMetadata`. Before this fix the tool threw
 * provider_error on a successful job, and Magica's 7,644 µc charge was never settled on our side.
 */
const liveOutput = {
  result: ["https://g.tlcdn.com/gen/0d0904832a99469d9efb5187933260da.png"],
  provider: "fal",
  creditUsed: 7644,
  resultMetadata: [{ size: 762203, width: 1024, height: 1024, modelId: "gpt-image-2", mimeType: "image/png", mediaType: "image" }],
};

describe("gpt_image_2 normalizeOutput against the live Magica shape", () => {
  it("reads image URLs from `result`", () => {
    expect(normalizeOutput(liveOutput)).toEqual({ images: ["https://g.tlcdn.com/gen/0d0904832a99469d9efb5187933260da.png"] });
  });

  it("keeps every URL and their order for n > 1", () => {
    const two = { ...liveOutput, result: ["https://g.tlcdn.com/gen/a.png", "https://g.tlcdn.com/gen/b.png"] };
    expect(normalizeOutput(two).images).toEqual(["https://g.tlcdn.com/gen/a.png", "https://g.tlcdn.com/gen/b.png"]);
  });

  it("still throws provider_error when `result` is empty", () => {
    expect(() => normalizeOutput({ ...liveOutput, result: [] })).toThrowError(/unexpected result/);
  });
});
