import { prisma } from "@/lib/db";
import type { User } from "@/generated/prisma/client";

/** Truncates every table this slice owns. Called in `beforeEach` so tests never see leftover rows. */
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "User", "Chat", "Message", "Attachment", "AgentRun", "ToolInvocation",
      "RunSkill", "Waitpoint", "CreditLedger", "ApiKey", "WebhookEndpoint",
      "WebhookDelivery", "RateLimitBucket"
    CASCADE
  `);
}

export async function createUser(overrides: Partial<{ clerkUserId: string; email: string; creditBalance: bigint }> = {}): Promise<User> {
  return prisma.user.create({
    data: {
      clerkUserId: overrides.clerkUserId ?? `clerk_${crypto.randomUUID()}`,
      ...(overrides.email !== undefined ? { email: overrides.email } : {}),
      creditBalance: overrides.creditBalance ?? 1_000_000_000n,
    },
  });
}

export async function createChat(userId: string, overrides: Partial<{ title: string; pinned: boolean }> = {}) {
  return prisma.chat.create({ data: { userId, title: overrides.title ?? "New chat", pinned: overrides.pinned ?? false } });
}
