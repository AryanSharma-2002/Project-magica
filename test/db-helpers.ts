import { prisma } from "@/lib/db";

/** Truncates every app table. Call in beforeEach for DB-backed tests. */
export async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Waitpoint","ToolInvocation","CreditLedger","RunSkill","AgentRun","Attachment","Message","Chat","ApiKey","WebhookDelivery","WebhookEndpoint","User","RateLimitBucket" RESTART IDENTITY CASCADE`,
  );
}

export async function createTestUser(overrides: Partial<{ clerkUserId: string; email: string }> = {}) {
  return prisma.user.create({
    data: { clerkUserId: overrides.clerkUserId ?? `clerk_${crypto.randomUUID()}`, email: overrides.email ?? null },
  });
}

/** User -> Chat -> user/assistant Message pair -> AgentRun, satisfying every required FK. */
export async function createTestRun(overrides: Partial<{ userId: string; status: "QUEUED" | "RUNNING" | "WAITING" | "STOPPING" }> = {}) {
  const user = overrides.userId ? { id: overrides.userId } : await createTestUser();
  const chat = await prisma.chat.create({ data: { userId: user.id, title: "Test chat" } });
  const userMessage = await prisma.message.create({ data: { chatId: chat.id, userId: user.id, role: "USER", status: "COMPLETED", content: [] } });
  const assistantMessage = await prisma.message.create({ data: { chatId: chat.id, userId: user.id, role: "ASSISTANT", status: "PENDING", content: [] } });
  const run = await prisma.agentRun.create({
    data: {
      chatId: chat.id,
      userId: user.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      idempotencyKey: `idem_${crypto.randomUUID()}`,
      requestedModel: "openrouter/free",
      status: overrides.status ?? "RUNNING",
    },
  });
  return { user, chat, userMessage, assistantMessage, run };
}

export async function createTestToolInvocation(args: { runId: string; userId: string; toolName?: string; toolCallId?: string }) {
  return prisma.toolInvocation.create({
    data: {
      runId: args.runId,
      userId: args.userId,
      toolCallId: args.toolCallId ?? `call_${crypto.randomUUID()}`,
      toolName: args.toolName ?? "crop_image",
      input: {},
    },
  });
}
