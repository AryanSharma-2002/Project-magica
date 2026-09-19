import { describe, expect, it } from "vitest";
import { ContentBlock, CropImageInput, MergeVideosInput, SendMessageRequest, decodeCursor, encodeCursor } from "@agent-chat/contracts";

describe("contracts", () => {
  it("round-trips cursors", () => {
    const c = encodeCursor(new Date("2026-01-02T03:04:05.006Z"), "abc");
    expect(decodeCursor(c)).toEqual({ createdAt: new Date("2026-01-02T03:04:05.006Z"), id: "abc" });
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });
  it("rejects paid model ids at the boundary", () => {
    expect(SendMessageRequest.safeParse({ text: "hi", model: "openai/gpt-4o" }).success).toBe(false);
    expect(SendMessageRequest.parse({ text: "hi" }).model).toBe("openrouter/free");
  });
  it("crop_image requires exactly one complete rectangle", () => {
    const url = "https://example.com/a.png";
    expect(CropImageInput.safeParse({ image_url: url }).success).toBe(false);
    expect(CropImageInput.safeParse({ image_url: url, x_percent: 10, y_percent: 10, width_percent: 50, height_percent: 50 }).success).toBe(true);
    expect(CropImageInput.safeParse({ image_url: url, x_percent: 10, width_percent: 50 }).success).toBe(false);
    expect(CropImageInput.safeParse({ image_url: url, width_px: 100, height_px: 100 }).success).toBe(true);
    expect(CropImageInput.safeParse({ image_url: url, crop: { x: 60, y: 0, width: 50, height: 50 } }).success).toBe(false);
  });
  it("merge_videos preserves order and bounds", () => {
    const v = ["https://a/1.mp4", "https://a/2.mp4"];
    expect(MergeVideosInput.parse({ video_urls: v }).video_urls).toEqual(v);
    expect(MergeVideosInput.safeParse({ video_urls: v.slice(0, 1) }).success).toBe(false);
  });
  it("content blocks are a closed discriminated union", () => {
    expect(ContentBlock.safeParse({ type: "text", text: "x" }).success).toBe(true);
    expect(ContentBlock.safeParse({ type: "nope" }).success).toBe(false);
  });
});

import { ListChatsQuery } from "@agent-chat/contracts";
describe("ListChatsQuery", () => {
  it("parses pinned=false as false", () => {
    expect(ListChatsQuery.parse({ pinned: "false" }).pinned).toBe(false);
    expect(ListChatsQuery.parse({ pinned: "true" }).pinned).toBe(true);
    expect(ListChatsQuery.parse({}).pinned).toBeUndefined();
  });
});
