import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { reserveAdmission } from "@/lib/credits";
import { createRunStore } from "@/services/run-store";
import { createChat, createUser, resetDb } from "../helpers/db";
import type { RunUsage } from "@agent-chat/contracts";

beforeEach(async () => {
  await resetDb();
});

const ZERO_USAGE: RunUsage = { model: null, promptTokens: 0, completionTokens: 0, totalTokens: 0, llmCalls: 0 };

async function makeRun(userId: string, chatId: string, microcreditsReserved = 10_000) {
  const userMsg = await prisma.message.create({ data: { chatId, userId, role: "USER", status: "COMPLETED", content: [{ type: "text", text: "hi" }], textContent: "hi" } });
  const assistantMsg = await prisma.message.create({ data: { chatId, userId, role: "ASSISTANT", status: "PENDING", content: [] } });
  const run = await prisma.agentRun.create({
    data: {
      chatId,
      userId,
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsg.id,
      idempotencyKey: `run-${crypto.randomUUID()}`,
      requestedModel: "openrouter/free",
      status: "RUNNING",
      microcreditsReserved: BigInt(microcreditsReserved),
    },
  });
  if (microcreditsReserved > 0) await reserveAdmission({ userId, runId: run.id, microcredits: microcreditsReserved });
  return { run, userMsg, assistantMsg };
}

describe("run store", () => {
  it("createInvocation is idempotent on (runId, toolCallId)", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);
    const { run, assistantMsg } = await makeRun(user.id, chat.id);
    const store = createRunStore();

    const first = await store.createInvocation({
      runId: run.id,
      messageId: assistantMsg.id,
      toolCallId: "call_1",
      toolName: "crop_image",
      input: { image_url: "https://example.com/a.png", width_px: 10, height_px: 10 },
      blockIndex: 0,
      microcreditsEstimated: 1000,
    });
    expect(first.existing).toBe(false);

    const second = await store.createInvocation({
      runId: run.id,
      messageId: assistantMsg.id,
      toolCallId: "call_1",
      toolName: "crop_image",
      input: { image_url: "https://example.com/a.png", width_px: 10, height_px: 10 },
      blockIndex: 0,
      microcreditsEstimated: 1000,
    });
    expect(second.existing).toBe(true);
    expect(second.invocationId).toBe(first.invocationId);

    const count = await prisma.toolInvocation.count({ where: { runId: run.id } });
    expect(count).toBe(1);
  });

  it("updateInvocation accepts null for the nullable JSON columns (output, error)", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);
    const { run, assistantMsg } = await makeRun(user.id, chat.id);
    const store = createRunStore();

    const created = await store.createInvocation({
      runId: run.id,
      messageId: assistantMsg.id,
      toolCallId: "call_null",
      toolName: "crop_image",
      input: {},
      blockIndex: 0,
      microcreditsEstimated: 100,
    });

    await store.updateInvocation(created.invocationId, {
      status: "failed",
      output: null,
      error: { code: "provider_error", message: "boom", retryable: false },
    });
    let row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: created.invocationId } });
    expect(row.status).toBe("FAILED");
    expect(row.output).toBeNull();
    expect(row.error).toEqual({ code: "provider_error", message: "boom", retryable: false });

    await store.updateInvocation(created.invocationId, { error: null });
    row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: created.invocationId } });
    expect(row.error).toBeNull();
  });

  it("finalize is idempotent: a second call does not overwrite the persisted result or double-release admission", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);
    const { run } = await makeRun(user.id, chat.id, 10_000);
    const store = createRunStore();

    await store.finalize(run.id, {
      status: "completed",
      blocks: [{ type: "text", text: "final answer" }],
      usage: ZERO_USAGE,
      routedModel: "some/model",
    });

    const afterFirst = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterFirst.status).toBe("COMPLETED");
    const assistantAfterFirst = await prisma.message.findUniqueOrThrow({ where: { id: afterFirst.assistantMessageId } });
    expect(assistantAfterFirst.content).toEqual([{ type: "text", text: "final answer" }]);
    const releaseCountAfterFirst = await prisma.creditLedger.count({ where: { idempotencyKey: `release:${run.id}` } });
    expect(releaseCountAfterFirst).toBe(1);

    // Second finalize with DIFFERENT content must be a full no-op (guarded by the status updateMany).
    await store.finalize(run.id, {
      status: "failed",
      blocks: [{ type: "text", text: "should not be persisted" }],
      usage: ZERO_USAGE,
      routedModel: null,
      error: { code: "internal", message: "should not apply", retryable: false },
    });

    const afterSecond = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterSecond.status).toBe("COMPLETED"); // unchanged
    const assistantAfterSecond = await prisma.message.findUniqueOrThrow({ where: { id: afterSecond.assistantMessageId } });
    expect(assistantAfterSecond.content).toEqual([{ type: "text", text: "final answer" }]); // unchanged
    const releaseCountAfterSecond = await prisma.creditLedger.count({ where: { idempotencyKey: `release:${run.id}` } });
    expect(releaseCountAfterSecond).toBe(1); // not released twice
  });

  it("loadSnapshot returns history oldest -> newest with READY attachments on the current user message", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);

    // Two earlier turns already in the chat, oldest first.
    await prisma.message.create({ data: { chatId: chat.id, userId: user.id, role: "USER", status: "COMPLETED", content: [{ type: "text", text: "first" }], textContent: "first" } });
    await prisma.message.create({ data: { chatId: chat.id, userId: user.id, role: "ASSISTANT", status: "COMPLETED", content: [{ type: "text", text: "first reply" }], textContent: "first reply" } });

    const { run, userMsg } = await makeRun(user.id, chat.id);
    await prisma.attachment.create({
      data: {
        userId: user.id,
        chatId: chat.id,
        messageId: userMsg.id,
        kind: "IMAGE",
        source: "UPLOAD",
        status: "READY",
        filename: "photo.png",
        mimeType: "image/png",
        url: "https://example.com/photo.png",
        position: 0,
      },
    });
    // A not-yet-ready attachment on the same message must be excluded from `snapshot.attachments`.
    await prisma.attachment.create({
      data: {
        userId: user.id,
        chatId: chat.id,
        messageId: userMsg.id,
        kind: "IMAGE",
        source: "UPLOAD",
        status: "UPLOADING",
        filename: "still-uploading.png",
        mimeType: "image/png",
        position: 1,
      },
    });

    const store = createRunStore();
    const snapshot = await store.loadSnapshot(run.id);

    // Oldest -> newest, excluding the run's own assistant placeholder.
    expect(snapshot.history.map((m) => m.content)).toEqual([
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "first reply" }],
      [{ type: "text", text: "hi" }], // the current user message
    ]);
    expect(snapshot.history.every((m) => m.id !== run.assistantMessageId)).toBe(true);

    expect(snapshot.attachments).toHaveLength(1);
    expect(snapshot.attachments[0]?.filename).toBe("photo.png");
  });
});
