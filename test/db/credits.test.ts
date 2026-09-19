import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createCreditPort } from "@/lib/credits";
import { AppError } from "@/lib/errors";
import { createChat, createUser, resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

async function makeRun(userId: string, chatId: string) {
  const userMsg = await prisma.message.create({ data: { chatId, userId, role: "USER", status: "COMPLETED", content: [], textContent: "" } });
  const assistantMsg = await prisma.message.create({ data: { chatId, userId, role: "ASSISTANT", status: "PENDING", content: [] } });
  return prisma.agentRun.create({
    data: {
      chatId,
      userId,
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsg.id,
      idempotencyKey: `run-${crypto.randomUUID()}`,
      requestedModel: "openrouter/free",
      status: "RUNNING",
    },
  });
}

/** CreditLedger.toolInvocationId is a real FK; the ledger tests need an actual ToolInvocation row. */
async function makeInvocation(userId: string, runId: string, toolCallId: string) {
  const invocation = await prisma.toolInvocation.create({
    data: { runId, userId, toolCallId, toolName: "crop_image", input: {}, status: "PENDING" },
  });
  return invocation.id;
}

describe("credit port", () => {
  it("settleInvocation is exactly-once under duplicate calls; balanceAfter chains correctly", async () => {
    const user = await createUser({ creditBalance: 1_000_000n });
    const chat = await createChat(user.id);
    const run = await makeRun(user.id, chat.id);
    const invocationId = await makeInvocation(user.id, run.id, "call_1");
    const credits = createCreditPort();

    await credits.reserveInvocation({ userId: user.id, runId: run.id, invocationId, microcredits: 50_000 });
    let balance = await credits.balance(user.id);
    expect(balance).toBe(950_000);

    await credits.settleInvocation({ userId: user.id, runId: run.id, invocationId, estimated: 50_000, charged: 30_000 });
    balance = await credits.balance(user.id);
    expect(balance).toBe(970_000); // 950_000 + 50_000 (release) - 30_000 (charge)

    // Duplicate settle: must be a no-op, not a double charge.
    await credits.settleInvocation({ userId: user.id, runId: run.id, invocationId, estimated: 50_000, charged: 30_000 });
    balance = await credits.balance(user.id);
    expect(balance).toBe(970_000);

    const ledger = await prisma.creditLedger.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    expect(ledger.map((l) => l.type)).toEqual(["RESERVE", "RELEASE", "CHARGE"]);
    // balanceAfter is a running, correct chain.
    expect(ledger[0]?.balanceAfter).toBe(950_000n);
    expect(ledger[1]?.balanceAfter).toBe(1_000_000n);
    expect(ledger[2]?.balanceAfter).toBe(970_000n);
  });

  it("reserveInvocation with insufficient credits throws and writes no ledger row", async () => {
    const user = await createUser({ creditBalance: 1_000n });
    const chat = await createChat(user.id);
    const run = await makeRun(user.id, chat.id);
    const credits = createCreditPort();

    await expect(credits.reserveInvocation({ userId: user.id, runId: run.id, invocationId: "inv-2", microcredits: 50_000 })).rejects.toBeInstanceOf(AppError);

    const ledgerCount = await prisma.creditLedger.count({ where: { userId: user.id } });
    expect(ledgerCount).toBe(0);
    const balance = await credits.balance(user.id);
    expect(balance).toBe(1_000);
  });
});
