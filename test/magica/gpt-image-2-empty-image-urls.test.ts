import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GptImage2Input } from "@agent-chat/contracts";
import { __resetMagicaCatalogCacheForTests, __setMagicaCatalogForTests, type MagicaCatalog } from "@/agent/providers/magica/catalog";
import { gptImage2Tool, subModelIdFor } from "@/agent/tools/definitions/gpt-image-2";

/**
 * Regression for the 2026-09-20 live failure: free OpenRouter models send `image_urls: []` for a
 * text-mode call, and the live catalog schema defaults the field to `[]` itself. With `.min(1)`
 * on the array, the parent loop's parsed input (now carrying a materialized `[]`) failed
 * re-validation inside the magica-tool child task AFTER the user had approved the credits.
 */
const liveCatalog = JSON.parse(readFileSync(path.join(__dirname, "fixtures/catalog.json"), "utf8")) as MagicaCatalog;

describe("gpt_image_2 accepts an empty image_urls array as text mode", () => {
  afterEach(() => __resetMagicaCatalogCacheForTests());

  it("baseline contract: image_urls: [] parses and selects the text sub-model", () => {
    const parsed = GptImage2Input.safeParse({ prompt: "a red square", image_urls: [] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(subModelIdFor(parsed.data)).toBe("gpt-image-2-text");
  });

  it("baseline contract: still rejects more than 10 image_urls", () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://cdn.example/${i}.png`);
    expect(GptImage2Input.safeParse({ prompt: "edit", image_urls: urls }).success).toBe(false);
  });

  it("live catalog schema: a parsed text-mode input re-parses cleanly (child-task re-validation)", async () => {
    __setMagicaCatalogForTests(liveCatalog);
    const schema = await gptImage2Tool.resolveInputSchema?.();
    expect(schema).toBeDefined();
    const first = schema!.parse({ prompt: "a red square" });
    // The catalog's `default: []` for uploadedImages is materialized by the first parse...
    expect(first.image_urls ?? []).toEqual([]);
    // ...and must not be rejected by the second one.
    expect(schema!.safeParse(first).success).toBe(true);
    expect(schema!.safeParse({ prompt: "a red square", image_urls: [] }).success).toBe(true);
    expect(subModelIdFor(first)).toBe("gpt-image-2-text");
  });

  it("live catalog schema: a non-empty image_urls still selects edit mode and keeps the max bound", async () => {
    __setMagicaCatalogForTests(liveCatalog);
    const schema = await gptImage2Tool.resolveInputSchema?.();
    const edit = schema!.parse({ prompt: "make it blue", image_urls: ["https://cdn.example/a.png"] });
    expect(subModelIdFor(edit)).toBe("gpt-image-2-edit");
    const urls = Array.from({ length: 11 }, (_, i) => `https://cdn.example/${i}.png`);
    expect(schema!.safeParse({ prompt: "edit", image_urls: urls }).success).toBe(false);
  });
});
