import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: vi.fn(async () => ({ id: `trg_${crypto.randomUUID()}` })) },
  auth: { createPublicToken: vi.fn(async () => "test-public-token") },
  wait: { completeToken: vi.fn(async () => ({ success: true })) },
}));

import { wait } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { completeWaitpoint } from "@/services/runs";
import { createChat, createUser, resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
  vi.mocked(wait.completeToken).mockClear();
});

async function makeWaitingRun(userId: string, chatId: string) {
  const userMsg = await prisma.message.create({ data: { chatId, userId, role: "USER", status: "COMPLETED", content: [], textContent: "" } });
  const assistantMsg = await prisma.message.create({ data: { chatId, userId, role: "ASSISTANT", status: "PENDING", content: [] } });
  const run = await prisma.agentRun.create({
    data: {
      chatId,
      userId,
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsg.id,
      idempotencyKey: `run-${crypto.randomUUID()}`,
      requestedModel: "openrouter/free",
      status: "WAITING",
    },
  });
  const waitpoint = await prisma.waitpoint.create({
    data: {
      runId: run.id,
      type: "APPROVAL",
      triggerTokenId: `wpt_${crypto.randomUUID()}`,
      prompt: { type: "approval", title: "Proceed?", toolName: "gpt_image_2", toolCallId: "call_1", input: {}, microcreditsEstimated: 1000 },
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  return { run, waitpoint };
}

describe("completeWaitpoint", () => {
  it("first call transitions PENDING -> COMPLETED and calls completeToken once; the second call is an idempotent no-op", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);
    const { waitpoint } = await makeWaitingRun(user.id, chat.id);

    const first = await completeWaitpoint(user.id, waitpoint.id, { type: "approval", approved: true });
    expect(first.status).toBe("completed");
    expect(first.resolution).toEqual({ type: "approval", approved: true });
    expect(wait.completeToken).toHaveBeenCalledTimes(1);
    expect(wait.completeToken).toHaveBeenCalledWith(waitpoint.triggerTokenId, { resolution: { type: "approval", approved: true } });

    const second = await completeWaitpoint(user.id, waitpoint.id, { type: "approval", approved: false });
    expect(second.status).toBe("completed");
    expect(second.resolution).toEqual({ type: "approval", approved: true }); // unchanged: DB transition is the source of truth
    expect(wait.completeToken).toHaveBeenCalledTimes(1); // not called again
  });

  it("rejects a resolution whose type does not match the waitpoint's type", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);
    const { waitpoint } = await makeWaitingRun(user.id, chat.id);

    const err = await completeWaitpoint(user.id, waitpoint.id, { type: "options", selected: ["a"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("validation_error");
    expect(wait.completeToken).not.toHaveBeenCalled();

    const row = await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } });
    expect(row.status).toBe("PENDING");
  });
});
