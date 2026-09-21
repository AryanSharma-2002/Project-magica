import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { __setMediaStoreForTests, type MediaStore } from "@/lib/storage/s3";
import { createRunStore } from "@/services/run-store";
import { createTestRun, createTestToolInvocation, truncateAll } from "../db-helpers";

const providerUrl = "https://g.tlcdn.com/gen/abc123.png";

function fakeStore(impl?: Partial<MediaStore>): MediaStore {
  return {
    publicUrl: (key) => `https://media.test/${key}`,
    putFromUrl: vi.fn(async ({ key }) => ({ url: `https://media.test/${key}`, sizeBytes: 4321 })),
    ...impl,
  };
}

async function seed() {
  const { run, user } = await createTestRun();
  const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "gpt_image_2" });
  return { run, user, invocation };
}

beforeEach(async () => {
  await truncateAll();
});
afterEach(() => {
  __setMediaStoreForTests(undefined);
});

/** Brief stack table: "Transloadit Community plan + S3-compatible object storage". Provider URLs expire; stored copies do not. */
describe("saveGeneratedAssets with S3 storage", () => {
  it("copies the asset to the bucket, stores the durable URL, clears the expiry and keeps the source", async () => {
    const store = fakeStore();
    __setMediaStoreForTests(store);
    const { run, user, invocation } = await seed();

    const blocks = await createRunStore().saveGeneratedAssets({
      runId: run.id,
      userId: user.id,
      chatId: run.chatId,
      messageId: run.assistantMessageId,
      invocationId: invocation.id,
      assets: [{ kind: "image", url: providerUrl, mimeType: "image/png", toolCallId: invocation.toolCallId, expiresAt: new Date(Date.now() + 3600_000).toISOString() }],
    });

    const expectedKey = `generated/${user.id}/${invocation.id}/0.png`;
    expect(store.putFromUrl).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: providerUrl, key: expectedKey, contentType: "image/png" }));
    expect(blocks[0]).toMatchObject({ type: "asset", url: `https://media.test/${expectedKey}` });
    expect(blocks[0]).not.toHaveProperty("expiresAt");
    const row = await prisma.attachment.findFirstOrThrow({ where: { toolInvocationId: invocation.id } });
    expect(row.url).toBe(`https://media.test/${expectedKey}`);
    expect(row.expiresAt).toBeNull();
    expect(row.sizeBytes).toBe(4321);
    expect(row.meta).toEqual({ sourceUrl: providerUrl });
  });

  it("keeps the provider URL and its expiry when the copy fails, without failing the run", async () => {
    __setMediaStoreForTests(fakeStore({ putFromUrl: vi.fn(async () => { throw new Error("bucket unreachable"); }) }));
    const { run, user, invocation } = await seed();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();

    const blocks = await createRunStore().saveGeneratedAssets({
      runId: run.id,
      userId: user.id,
      chatId: run.chatId,
      messageId: run.assistantMessageId,
      invocationId: invocation.id,
      assets: [{ kind: "image", url: providerUrl, mimeType: "image/png", toolCallId: invocation.toolCallId, expiresAt }],
    });

    expect(blocks[0]).toMatchObject({ type: "asset", url: providerUrl, expiresAt });
    const row = await prisma.attachment.findFirstOrThrow({ where: { toolInvocationId: invocation.id } });
    expect(row.url).toBe(providerUrl);
    expect(row.expiresAt?.toISOString()).toBe(expiresAt);
  });

  it("is a pass-through when no store is configured", async () => {
    __setMediaStoreForTests(null);
    const { run, user, invocation } = await seed();
    const blocks = await createRunStore().saveGeneratedAssets({
      runId: run.id, userId: user.id, chatId: run.chatId, messageId: run.assistantMessageId, invocationId: invocation.id,
      assets: [{ kind: "video", url: "https://g.tlcdn.com/gen/v.mp4", mimeType: "video/mp4", toolCallId: invocation.toolCallId }],
    });
    expect(blocks[0]).toMatchObject({ type: "asset", url: "https://g.tlcdn.com/gen/v.mp4" });
  });
});
