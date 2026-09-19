import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogFieldsToZod, type CatalogField } from "@/agent/providers/magica/schema-from-catalog";
import { __resetMagicaCatalogCacheForTests, __setMagicaCatalogForTests, findCatalogModel, type MagicaCatalog } from "@/agent/providers/magica/catalog";
import { gptImage2Tool } from "@/agent/tools/definitions/gpt-image-2";

/**
 * Catalog fixture. `catalog.json` was fetched ONCE from the live, public
 * https://inference.magica.com/v1/models/catalog (September 2026, no auth required, per the task
 * brief) - network access happened to work in this environment. `crop_image.json` /
 * `merge_videos.json` style fixtures aren't needed separately: this file reads the same live
 * dump and asserts against its `crop_image`, `merge_videos`, and `gpt-image-2` entries directly.
 */
const liveCatalog = JSON.parse(readFileSync(path.join(__dirname, "fixtures/catalog.json"), "utf8")) as MagicaCatalog;

describe("catalogFieldsToZod against hand-written fixture field descriptions", () => {
  it("textarea/text -> string, required stays required", () => {
    const fields: CatalogField[] = [{ zodExpectedName: "prompt", type: "textarea", dataType: "string", required: true }];
    const schema = catalogFieldsToZod(fields);
    expect(schema.safeParse({ prompt: "a cat" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("select (string) -> enum of option values", () => {
    const fields: CatalogField[] = [
      { zodExpectedName: "transition", type: "select", dataType: "string", default: "none", options: [{ value: "none", label: "None" }, { value: "fade", label: "Fade" }] },
    ];
    const schema = catalogFieldsToZod(fields);
    expect(schema.parse({}).transition).toBe("none"); // default applied
    expect(schema.safeParse({ transition: "fade" }).success).toBe(true);
    expect(schema.safeParse({ transition: "nope" }).success).toBe(false);
  });

  it("select (number dataType) -> numeric literal union, not stringified", () => {
    const fields: CatalogField[] = [{ zodExpectedName: "n", type: "select", dataType: "number", default: 1, options: [{ value: 1, label: "1" }, { value: 4, label: "4" }] }];
    const schema = catalogFieldsToZod(fields);
    expect(schema.safeParse({ n: 4 }).success).toBe(true);
    expect(schema.safeParse({ n: "4" }).success).toBe(false);
    expect(schema.safeParse({ n: 2 }).success).toBe(false);
  });

  it("composite-select flattens customFields as sibling optional numbers with min/max/step", () => {
    const fields: CatalogField[] = [
      {
        zodExpectedName: "size",
        type: "composite-select",
        dataType: "string",
        default: "Auto",
        customValue: true,
        options: [{ value: "Auto", label: "Auto" }, { value: "Custom", label: "Custom" }],
        customFields: [
          { zodExpectedName: "width", type: "number", dataType: "number", min: 1024, max: 3840, step: 16 },
          { zodExpectedName: "height", type: "number", dataType: "number", min: 1024, max: 3840, step: 16 },
        ],
      },
    ];
    const schema = catalogFieldsToZod(fields);
    expect(schema.safeParse({ size: "Custom", width: 1024, height: 2048 }).success).toBe(true);
    expect(schema.safeParse({ size: "Custom", width: 1025 }).success).toBe(false); // not a multiple of 16
    expect(schema.safeParse({}).success).toBe(true); // size defaults to Auto, width/height optional
  });

  it("slider/number -> bounded number", () => {
    const fields: CatalogField[] = [{ zodExpectedName: "x_percent", type: "slider", dataType: "number", default: 0, min: 0, max: 100, step: 1 }];
    const schema = catalogFieldsToZod(fields);
    expect(schema.safeParse({ x_percent: 50 }).success).toBe(true);
    expect(schema.safeParse({ x_percent: 150 }).success).toBe(false);
  });

  it("image/video with dataType string[] -> bounded URL array", () => {
    const fields: CatalogField[] = [{ zodExpectedName: "video_urls", type: "video", dataType: "string[]", required: true, maxItems: 2 }];
    const schema = catalogFieldsToZod(fields);
    expect(schema.safeParse({ video_urls: ["https://a/1.mp4", "https://a/2.mp4"] }).success).toBe(true);
    expect(schema.safeParse({ video_urls: ["https://a/1.mp4", "https://a/2.mp4", "https://a/3.mp4"] }).success).toBe(false);
  });
});

describe("catalogFieldsToZod against the REAL live catalog shapes", () => {
  it("builds a working schema from crop_image's real inputFieldOptions", () => {
    const model = findCatalogModel(liveCatalog, "crop_image");
    expect(model).toBeDefined();
    const schema = catalogFieldsToZod(model?.inputFieldOptions ?? []);
    expect(schema.safeParse({ image_url: "https://x/y.png", x_percent: 10, y_percent: 10, width_percent: 50, height_percent: 50 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false); // image_url is required
    // The real catalog reports crop_image's default estimate directly, in microcredits.
    expect(model?.subModels?.[0]?.defaultEstimateMicrocredits).toBe(5000);
  });

  it("builds a working schema from merge_videos's real inputFieldOptions", () => {
    const model = findCatalogModel(liveCatalog, "merge_videos");
    const schema = catalogFieldsToZod(model?.inputFieldOptions ?? []);
    expect(schema.parse({ video_urls: ["https://a/1.mp4", "https://a/2.mp4"] }).transition).toBe("none");
    expect(model?.cost).toMatchObject({ type: "per_minute" });
  });

  it("gpt_image_2's live edit sub-model exposes uploadedImages (string[], maxImages 10, required)", () => {
    const model = findCatalogModel(liveCatalog, "gpt-image-2");
    const edit = model?.subModels?.find((s) => s.subModelId === "gpt-image-2-edit");
    const uploaded = edit?.inputFieldOptions.find((f) => f.zodExpectedName === "uploadedImages");
    expect(uploaded).toMatchObject({ type: "image", dataType: "string[]", maxImages: 10, required: true });
    expect(edit?.defaultEstimateMicrocredits).toBe(273_936);
  });
});

describe("gpt_image_2 resolveInputSchema built from the real catalog", () => {
  afterEach(() => __resetMagicaCatalogCacheForTests());

  it("renames uploadedImages to image_urls and makes it optional (edit-only field)", async () => {
    __setMagicaCatalogForTests(liveCatalog);
    const schema = await gptImage2Tool.resolveInputSchema?.();
    expect(schema).toBeInstanceOf(z.ZodType);
    // text-mode call: no image_urls needed even though the field is `required: true` on the edit sub-model.
    const textResult = schema?.safeParse({ prompt: "a cat", size: "Auto", quality: "High", background: "Auto", n: 1, output_format: "PNG" });
    expect(textResult?.success).toBe(true);
    // edit-mode call: image_urls accepted.
    const editResult = schema?.safeParse({ prompt: "add a hat", image_urls: ["https://x/a.png"], size: "Auto", quality: "High", background: "Auto", n: 1, output_format: "PNG" });
    expect(editResult?.success).toBe(true);
    // prompt is required in both sub-models, so it stays required in the merged schema.
    expect(schema?.safeParse({ size: "Auto" }).success).toBe(false);
  });

  it("falls back to the baseline contract schema when the catalog is unavailable", async () => {
    __resetMagicaCatalogCacheForTests();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    try {
      const schema = await gptImage2Tool.resolveInputSchema?.();
      // Falls back to the static GptImage2Input contract, which still validates a normal call.
      expect(schema?.safeParse({ prompt: "a cat" }).success).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
