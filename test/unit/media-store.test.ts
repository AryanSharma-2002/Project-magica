import { afterEach, describe, expect, it, vi } from "vitest";
import { __setEnvForTests } from "@/lib/env";
import { __setMediaStoreForTests, createS3MediaStore, generatedAssetKey, getMediaStore } from "@/lib/storage/s3";

afterEach(() => {
  vi.unstubAllGlobals();
  __setMediaStoreForTests(undefined);
});

describe("generatedAssetKey", () => {
  it("uses the source URL's extension, then the MIME type, then bin", () => {
    expect(generatedAssetKey({ userId: "u1", invocationId: "inv1", index: 0, sourceUrl: "https://g.tlcdn.com/gen/abc.png", mimeType: "image/png" })).toBe("generated/u1/inv1/0.png");
    expect(generatedAssetKey({ userId: "u1", invocationId: "inv1", index: 1, sourceUrl: "https://cdn/x/noext", mimeType: "video/quicktime" })).toBe("generated/u1/inv1/1.mov");
    expect(generatedAssetKey({ userId: "u1", invocationId: "inv1", index: 2, sourceUrl: "not a url", mimeType: "weird" })).toBe("generated/u1/inv1/2.bin");
  });
});

describe("S3 media store", () => {
  it("downloads the source and PUTs it under the key, returning the public URL", async () => {
    const sent: unknown[] = [];
    const client = { send: vi.fn(async (cmd: unknown) => void sent.push(cmd)) };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from("png-bytes"), { status: 200, headers: { "content-type": "image/png", "content-length": "9" } })));
    const store = createS3MediaStore({ bucket: "agent-chat-media-test", region: "us-east-1", client: client as never });

    const out = await store.putFromUrl({ sourceUrl: "https://g.tlcdn.com/gen/a.png", key: "generated/u/i/0.png", contentType: "image/png" });

    expect(out).toEqual({ url: "https://agent-chat-media-test.s3.amazonaws.com/generated/u/i/0.png", sizeBytes: 9 });
    const input = (sent[0] as { input: Record<string, unknown> }).input;
    expect(input.Bucket).toBe("agent-chat-media-test");
    expect(input.Key).toBe("generated/u/i/0.png");
    expect(input.ContentType).toBe("image/png");
  });

  it("uses a regional host outside us-east-1 and S3_PUBLIC_BASE_URL when set", () => {
    __setEnvForTests({ S3_PUBLIC_BASE_URL: undefined });
    const eu = createS3MediaStore({ bucket: "b", region: "eu-west-1", client: { send: vi.fn() } as never });
    expect(eu.publicUrl("uploads/a b.png")).toBe("https://b.s3.eu-west-1.amazonaws.com/uploads/a%20b.png");
    __setEnvForTests({ S3_PUBLIC_BASE_URL: "https://media.example.com/" });
    const cdn = createS3MediaStore({ bucket: "b", region: "eu-west-1", client: { send: vi.fn() } as never });
    expect(cdn.publicUrl("uploads/a.png")).toBe("https://media.example.com/uploads/a.png");
    __setEnvForTests({ S3_PUBLIC_BASE_URL: undefined });
  });

  it("refuses a source that fails or exceeds the copy limit", async () => {
    const client = { send: vi.fn() };
    const store = createS3MediaStore({ bucket: "b", region: "us-east-1", client: client as never });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(store.putFromUrl({ sourceUrl: "https://x/y.png", key: "k", contentType: "image/png" })).rejects.toThrow(/404/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 200, headers: { "content-length": String(300 * 1024 * 1024) } })));
    await expect(store.putFromUrl({ sourceUrl: "https://x/y.png", key: "k", contentType: "image/png" })).rejects.toThrow(/copy limit/);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("getMediaStore is null without S3_BUCKET", () => {
    __setEnvForTests({ S3_BUCKET: undefined });
    expect(getMediaStore()).toBeNull();
  });
});
