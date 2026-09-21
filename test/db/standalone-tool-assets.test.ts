import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { __setMediaStoreForTests, type MediaStore } from "@/lib/storage/s3";
import { createTestRun, createTestToolInvocation, createTestUser, truncateAll } from "../db-helpers";
import type { MagicaToolPayload, MagicaToolResult } from "@/trigger/magica-tool.task";

vi.mock("@trigger.dev/sdk", () => ({
  task: vi.fn((opts: unknown) => opts),
  metadata: { set: vi.fn(), flush: vi.fn(), parent: { set: vi.fn() } },
}));

const { magicaToolTask: magicaToolTaskExport } = await import("@/trigger/magica-tool.task");

type FakeTaskParams = { ctx: { run: { id: string } }; signal: AbortSignal };
const magicaToolTask = magicaToolTaskExport as unknown as { run: (payload: MagicaToolPayload, params: FakeTaskParams) => Promise<MagicaToolResult> };

const providerUrl = "https://g.tlcdn.com/gen/cropped.png";
const cropInput = { image_url: "https://x/y.png", x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 100 };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeParams(): FakeTaskParams {
  return { ctx: { run: { id: "trun_standalone" } }, signal: new AbortController().signal };
}

function fakeStore(impl?: Partial<MediaStore>): MediaStore {
  return {
    publicUrl: (key) => `https://media.test/${key}`,
    putFromUrl: vi.fn(async ({ key }) => ({ url: `https://media.test/${key}`, sizeBytes: 4321 })),
    ...impl,
  };
}

/** Magica: POST /nodes/crop_image/run -> 202 {runId}, then GET run -> COMPLETED with the provider URL. */
function stubMagicaSuccess(): void {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(202, { runId: "prov_standalone" }))
    .mockResolvedValueOnce(jsonResponse(200, { id: "prov_standalone", status: "COMPLETED", output: { image_url: [providerUrl] }, error: null, userMessage: null, creditUsed: 5000, createdAt: "x" }));
  vi.stubGlobal("fetch", fetchMock);
}

/** `POST /tools/:name/run` rows: no run, no message (ARCHITECTURE.md §9). */
async function createStandaloneInvocation() {
  const user = await createTestUser();
  const invocation = await prisma.toolInvocation.create({
    data: { userId: user.id, runId: null, toolCallId: `pub_${crypto.randomUUID()}`, toolName: "crop_image", input: cropInput, microcreditsEstimated: 5000n },
  });
  return { user, invocation };
}

beforeEach(async () => {
  await truncateAll();
  vi.unstubAllGlobals();
});
afterEach(() => {
  __setMediaStoreForTests(undefined);
});

describe("standalone tool run: generated assets are stored durably", () => {
  it("copies the output asset to the bucket, rewrites the persisted output and records an Attachment (no chat/message)", async () => {
    const store = fakeStore();
    __setMediaStoreForTests(store);
    const { user, invocation } = await createStandaloneInvocation();
    stubMagicaSuccess();

    const result = await magicaToolTask.run({ invocationId: invocation.id, input: cropInput }, fakeParams());

    const expectedKey = `generated/${user.id}/${invocation.id}/0.png`;
    const storedUrl = `https://media.test/${expectedKey}`;
    expect(store.putFromUrl).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: providerUrl, key: expectedKey, contentType: "image/png" }));
    expect(result).toMatchObject({ ok: true, output: { image_url: storedUrl } });

    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("COMPLETED");
    expect(row.output).toEqual({ image_url: storedUrl }); // what GET /tools/runs/:id serves
    expect(row.microcreditsCharged).toBe(5000n);

    const attachment = await prisma.attachment.findFirstOrThrow({ where: { toolInvocationId: invocation.id } });
    expect(attachment).toMatchObject({ userId: user.id, chatId: null, messageId: null, kind: "IMAGE", source: "GENERATED", status: "READY", url: storedUrl, sizeBytes: 4321, expiresAt: null });
    expect(attachment.meta).toEqual({ sourceUrl: providerUrl });
  });

  it("keeps the provider output when the copy fails, and the invocation still completes", async () => {
    __setMediaStoreForTests(fakeStore({ putFromUrl: vi.fn(async () => { throw new Error("bucket unreachable"); }) }));
    const { invocation } = await createStandaloneInvocation();
    stubMagicaSuccess();

    const result = await magicaToolTask.run({ invocationId: invocation.id, input: cropInput }, fakeParams());

    expect(result).toMatchObject({ ok: true, output: { image_url: providerUrl } });
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("COMPLETED");
    expect(row.output).toEqual({ image_url: providerUrl });
    const attachment = await prisma.attachment.findFirstOrThrow({ where: { toolInvocationId: invocation.id } });
    expect(attachment.url).toBe(providerUrl);
    expect(attachment.meta).toBeNull();
  });

  it("is a pass-through when no store is configured (Attachment still records the provider URL)", async () => {
    __setMediaStoreForTests(null);
    const { invocation } = await createStandaloneInvocation();
    stubMagicaSuccess();

    const result = await magicaToolTask.run({ invocationId: invocation.id, input: cropInput }, fakeParams());

    expect(result).toMatchObject({ ok: true, output: { image_url: providerUrl } });
    expect(await prisma.attachment.count({ where: { toolInvocationId: invocation.id } })).toBe(1);
  });

  it("does nothing for an in-chat invocation: the agent loop owns those assets (no duplicate rows)", async () => {
    const store = fakeStore();
    __setMediaStoreForTests(store);
    const { run, user } = await createTestRun();
    const invocation = await createTestToolInvocation({ runId: run.id, userId: user.id, toolName: "crop_image" });
    await prisma.toolInvocation.update({ where: { id: invocation.id }, data: { input: cropInput } });
    stubMagicaSuccess();

    const result = await magicaToolTask.run({ invocationId: invocation.id, input: cropInput }, fakeParams());

    expect(result).toMatchObject({ ok: true, output: { image_url: providerUrl } });
    expect(store.putFromUrl).not.toHaveBeenCalled();
    expect(await prisma.attachment.count({ where: { toolInvocationId: invocation.id } })).toBe(0);
  });
});
