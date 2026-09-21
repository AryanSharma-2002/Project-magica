import { describe, expect, it } from "vitest";
import { matchAttachmentsToResults, pickResultFiles, type TransloaditAssemblyStatus } from "@/lib/transloadit/notify";

/**
 * Shape captured from a REAL completed Assembly on 2026-09-21 (Community plan, single
 * `:original` `/upload/handle` step, no storage step): `results` is `{}` and the received files are
 * listed under `uploads`. Before this fix every such upload was reconciled to FAILED.
 */
const liveShape: TransloaditAssemblyStatus = {
  ok: "ASSEMBLY_COMPLETED",
  message: "The Assembly was successfully completed.",
  assembly_id: "cb8dc290496648c8bb44d6d28ed034ce",
  fields: { userId: "user_1", chatId: "chat_1", nonce: "nonce-1" },
  results: {},
  uploads: [
    { id: "4505b44b", name: "acceptance-image.png", original_name: "acceptance-image.png", ext: "png", size: 85171, mime: "image/png", ssl_url: "https://pub-example.r2.dev/4505b44b/acceptance-image.png", meta: { width: 1024, height: 768 } },
  ],
};

describe("pickResultFiles", () => {
  it("falls back to `uploads` when the Assembly has no result steps (live no-storage shape)", () => {
    const files = pickResultFiles(liveShape);
    expect(files).toHaveLength(1);
    expect(files[0]?.ssl_url).toBe("https://pub-example.r2.dev/4505b44b/acceptance-image.png");
  });

  it("prefers a `store` step result over uploads", () => {
    const stored = { ...liveShape, results: { store: [{ name: "a.png", ssl_url: "https://bucket/a.png" }] } };
    expect(pickResultFiles(stored).map((f) => f.ssl_url)).toEqual(["https://bucket/a.png"]);
  });

  it("uses results[':original'] when present and non-empty", () => {
    const original = { ...liveShape, results: { ":original": [{ name: "a.png", ssl_url: "https://tl/a.png" }] } };
    expect(pickResultFiles(original).map((f) => f.ssl_url)).toEqual(["https://tl/a.png"]);
  });

  it("ignores an EMPTY results[':original'] array and still falls back to uploads", () => {
    const empty = { ...liveShape, results: { ":original": [] } };
    expect(pickResultFiles(empty)).toHaveLength(1);
  });

  it("matches the uploaded file to the pre-created row by original filename", () => {
    const rows = [{ position: 0, filename: "acceptance-image.png" }];
    const [match] = matchAttachmentsToResults(rows, pickResultFiles(liveShape));
    expect(match?.result?.meta?.width).toBe(1024);
  });
});
