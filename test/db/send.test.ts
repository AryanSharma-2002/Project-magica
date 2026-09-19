import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => {
  let counter = 0;
  return {
    tasks: { trigger: vi.fn(async () => ({ id: `trg_${++counter}_${crypto.randomUUID()}` })) },
    auth: { createPublicToken: vi.fn(async () => "test-public-token") },
    wait: { completeToken: vi.fn(async () => ({ success: true })) },
  };
});

import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { reserveAdmission } from "@/lib/credits";
import { sendMessage } from "@/services/send";
import { createChat, createUser, resetDb } from "../helpers/db";
import type { SendMessageRequest } from "@agent-chat/contracts";

function req(overrides: Partial<SendMessageRequest> = {}): SendMessageRequest {
  return { text: "hello there", attachmentIds: [], model: "openrouter/free", planMode: false, ...overrides };
}

beforeEach(async () => {
  await resetDb();
});

describe("sendMessage", () => {
  it("happy path: creates messages + QUEUED run + reservation, and dedupes on repeat Idempotency-Key", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);

    const first = await sendMessage(user.id, chat.id, req({ text: "hi agent" }), "idem-1");
    expect(first.deduplicated).toBe(false);
    expect(first.chatId).toBe(chat.id);
    expect(first.realtime.publicAccessToken).toBe("test-public-token");

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: first.runId } });
    expect(run.status).toBe("QUEUED");
    expect(run.triggerRunId).toBeTruthy();

    const messages = await prisma.message.findMany({ where: { chatId: chat.id } });
    expect(messages).toHaveLength(2);
    const userMsg = messages.find((m) => m.role === "USER");
    const assistantMsg = messages.find((m) => m.role === "ASSISTANT");
    expect(userMsg?.status).toBe("COMPLETED");
    expect(assistantMsg?.status).toBe("PENDING");

    const reservation = await prisma.creditLedger.findUnique({ where: { idempotencyKey: `reserve:${first.runId}` } });
    expect(reservation).not.toBeNull();
    expect(reservation?.amount).toBe(-10_000n);

    // Second send with the same Idempotency-Key: no new rows, same ids, deduplicated.
    const second = await sendMessage(user.id, chat.id, req({ text: "hi agent" }), "idem-1");
    expect(second.deduplicated).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(second.messageId).toBe(first.messageId);
    expect(second.assistantMessageId).toBe(first.assistantMessageId);

    const messagesAfter = await prisma.message.findMany({ where: { chatId: chat.id } });
    expect(messagesAfter).toHaveLength(2);
    const runsAfter = await prisma.agentRun.count({ where: { chatId: chat.id } });
    expect(runsAfter).toBe(1);
  });

  it("one active run per chat: exactly one of two concurrent sends succeeds, no leaked reservation", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);

    const results = await Promise.allSettled([
      sendMessage(user.id, chat.id, req({ text: "a" }), "concurrent-a"),
      sendMessage(user.id, chat.id, req({ text: "b" }), "concurrent-b"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(AppError);
    expect((rejected[0]?.reason as AppError).code).toBe("run_active");

    const runCount = await prisma.agentRun.count({ where: { chatId: chat.id } });
    expect(runCount).toBe(1);
    const reserveCount = await prisma.creditLedger.count({ where: { userId: user.id, type: "RESERVE" } });
    expect(reserveCount).toBe(1);
  });

  it("insufficient credits at send: throws insufficient_credits and persists no messages", async () => {
    const user = await createUser({ creditBalance: 0n });
    const chat = await createChat(user.id);

    await expect(sendMessage(user.id, chat.id, req(), "idem-poor")).rejects.toMatchObject({ code: "insufficient_credits" });

    const messages = await prisma.message.count({ where: { chatId: chat.id } });
    expect(messages).toBe(0);
    const runs = await prisma.agentRun.count({ where: { chatId: chat.id } });
    expect(runs).toBe(0);
  });

  it("stale lock recovery: an old run past its heartbeat is failed and released; the new send succeeds", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);

    const oldUserMsg = await prisma.message.create({
      data: { chatId: chat.id, userId: user.id, role: "USER", status: "COMPLETED", content: [{ type: "text", text: "old" }], textContent: "old" },
    });
    const oldAssistantMsg = await prisma.message.create({
      data: { chatId: chat.id, userId: user.id, role: "ASSISTANT", status: "PENDING", content: [] },
    });
    const staleHeartbeat = new Date(Date.now() - 6 * 60 * 1000);
    const oldRun = await prisma.agentRun.create({
      data: {
        chatId: chat.id,
        userId: user.id,
        userMessageId: oldUserMsg.id,
        assistantMessageId: oldAssistantMsg.id,
        idempotencyKey: "old-run-key",
        requestedModel: "openrouter/free",
        status: "RUNNING",
        startedAt: staleHeartbeat,
        heartbeatAt: staleHeartbeat,
        microcreditsReserved: 10_000n,
      },
    });
    await reserveAdmission({ userId: user.id, runId: oldRun.id, microcredits: 10_000 });

    const result = await sendMessage(user.id, chat.id, req({ text: "new message" }), "idem-new");
    expect(result.deduplicated).toBe(false);
    expect(result.runId).not.toBe(oldRun.id);

    const oldRunAfter = await prisma.agentRun.findUniqueOrThrow({ where: { id: oldRun.id } });
    expect(oldRunAfter.status).toBe("FAILED");
    expect((oldRunAfter.error as { code?: string } | null)?.code).toBe("stale_run_recovered");

    const release = await prisma.creditLedger.findUnique({ where: { idempotencyKey: `release:${oldRun.id}` } });
    expect(release).not.toBeNull();
    expect(release?.amount).toBe(10_000n);
  });

  it("does not leak a run across users who reuse the same Idempotency-Key value", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const chatA = await createChat(userA.id);
    const chatB = await createChat(userB.id);

    const resultA = await sendMessage(userA.id, chatA.id, req({ text: "from A" }), "shared-key");
    const resultB = await sendMessage(userB.id, chatB.id, req({ text: "from B" }), "shared-key");

    expect(resultB.deduplicated).toBe(false);
    expect(resultB.runId).not.toBe(resultA.runId);
    expect(resultB.chatId).toBe(chatB.id);
    expect(resultB.messageId).not.toBe(resultA.messageId);

    // B must never be able to read A's run through the "same key" path either.
    const bAgain = await sendMessage(userB.id, chatB.id, req({ text: "from B" }), "shared-key");
    expect(bAgain.runId).toBe(resultB.runId);
    expect(bAgain.deduplicated).toBe(true);
  });

  it("rate limit: the 21st send within a minute is rejected with retryAfterSeconds", async () => {
    const user = await createUser();
    for (let i = 0; i < 20; i++) {
      const chat = await createChat(user.id);
      const res = await sendMessage(user.id, chat.id, req({ text: `message ${i}` }), `idem-rl-${i}`);
      expect(res.deduplicated).toBe(false);
    }
    const chat21 = await createChat(user.id);
    const err = await sendMessage(user.id, chat21.id, req({ text: "one too many" }), "idem-rl-20").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("rate_limited");
    expect(typeof (err as AppError).details?.retryAfterSeconds).toBe("number");
  }, 30_000);
});
