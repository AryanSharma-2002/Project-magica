import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: vi.fn(async () => ({ id: `trg_${crypto.randomUUID()}` })) },
  auth: { createPublicToken: vi.fn(async () => "test-public-token") },
  wait: { completeToken: vi.fn(async () => ({ success: true })) },
}));

import { wait } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { cancelRun } from "@/services/runs";
import { createChat, createUser, resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
  vi.mocked(wait.completeToken).mockClear();
});

async function makeRun(userId: string, chatId: string, status: "QUEUED" | "RUNNING" | "WAITING", opts: { started?: boolean } = {}) {
  const userMsg = await prisma.message.create({ data: { chatId, userId, role: "USER", status: "COMPLETED", content: [], textContent: "" } });
  const assistantMsg = await prisma.message.create({ data: { chatId, userId, role: "ASSISTANT", status: "PENDING", content: [] } });
  const started = opts.started ?? status !== "QUEUED";
  return prisma.agentRun.create({
    data: {
      chatId,
      userId,
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsg.id,
      idempotencyKey: `run-${crypto.randomUUID()}`,
      requestedModel: "openrouter/free",
      status,
      startedAt: started ? new Date() : null,
      heartbeatAt: started ? new Date() : null,
    },
  });
}

describe("cancelRun", () => {
  it("RUNNING -> STOPPING with cancelRequestedAt set; assistant message untouched (task loop finalizes later)", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);
    const run = await makeRun(user.id, chat.id, "RUNNING");

    const result = await cancelRun(user.id, run.id);
    expect(result.status).toBe("stopping");

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("STOPPING");
    expect(row.cancelRequestedAt).not.toBeNull();
  });

  it("QUEUED run that never started is finalized CANCELLED immediately, assistant message CANCELLED", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);
    const run = await makeRun(user.id, chat.id, "QUEUED", { started: false });

    const result = await cancelRun(user.id, run.id);
    expect(result.status).toBe("cancelled");

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("CANCELLED");
    expect(row.finishedAt).not.toBeNull();

    const assistantMessage = await prisma.message.findUniqueOrThrow({ where: { id: row.assistantMessageId } });
    expect(assistantMessage.status).toBe("CANCELLED");
  });

  it("WAITING run: pending waitpoint is cancelled and completeToken({cancelled:true}) is called", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);
    const run = await makeRun(user.id, chat.id, "WAITING");
    const waitpoint = await prisma.waitpoint.create({
      data: {
        runId: run.id,
        type: "APPROVAL",
        triggerTokenId: `wpt_${crypto.randomUUID()}`,
        prompt: { type: "approval", title: "Proceed?", toolName: "gpt_image_2", toolCallId: "call_1", input: {}, microcreditsEstimated: 1000 },
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await cancelRun(user.id, run.id);
    expect(result.status).toBe("stopping");

    const row = await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } });
    expect(row.status).toBe("CANCELLED");
    expect(row.resolvedAt).not.toBeNull();
    expect(wait.completeToken).toHaveBeenCalledWith(waitpoint.triggerTokenId, { cancelled: true });
  });
});
