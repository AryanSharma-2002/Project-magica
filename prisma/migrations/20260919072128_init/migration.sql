-- Extensions (pg_trgm for chat-title search)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'STREAMING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING', 'STOPPING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ToolInvocationStatus" AS ENUM ('PENDING', 'WAITING_APPROVAL', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WaitpointType" AS ENUM ('APPROVAL', 'OPTIONS', 'PLAN', 'CREDIT');

-- CreateEnum
CREATE TYPE "WaitpointStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'FILE');

-- CreateEnum
CREATE TYPE "AttachmentSource" AS ENUM ('UPLOAD', 'LIBRARY', 'GENERATED');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('GRANT', 'RESERVE', 'RELEASE', 'CHARGE', 'REFUND', 'ADJUST');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "email" TEXT,
    "creditBalance" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "lastMessageAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'COMPLETED',
    "content" JSONB NOT NULL DEFAULT '[]',
    "textContent" TEXT NOT NULL DEFAULT '',
    "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("textContent", ''))) STORED,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "messageId" TEXT,
    "toolInvocationId" TEXT,
    "kind" "AttachmentKind" NOT NULL,
    "source" "AttachmentSource" NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'UPLOADING',
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "url" TEXT,
    "previewUrl" TEXT,
    "storageKey" TEXT,
    "assemblyId" TEXT,
    "assemblyStatus" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userMessageId" TEXT NOT NULL,
    "assistantMessageId" TEXT NOT NULL,
    "triggerRunId" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "requestedModel" TEXT NOT NULL,
    "routedModel" TEXT,
    "planMode" BOOLEAN NOT NULL DEFAULT false,
    "currentStep" TEXT,
    "usage" JSONB,
    "microcreditsReserved" BIGINT NOT NULL DEFAULT 0,
    "microcreditsCharged" BIGINT NOT NULL DEFAULT 0,
    "error" JSONB,
    "cancelRequestedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolInvocation" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "userId" TEXT NOT NULL,
    "messageId" TEXT,
    "toolCallId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "status" "ToolInvocationStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" JSONB,
    "providerRunId" TEXT,
    "microcreditsEstimated" BIGINT NOT NULL DEFAULT 0,
    "microcreditsCharged" BIGINT NOT NULL DEFAULT 0,
    "blockIndex" INTEGER,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunSkill" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "assetPath" TEXT NOT NULL DEFAULT '',
    "contentHash" TEXT NOT NULL,
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Waitpoint" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolInvocationId" TEXT,
    "type" "WaitpointType" NOT NULL,
    "status" "WaitpointStatus" NOT NULL DEFAULT 'PENDING',
    "triggerTokenId" TEXT NOT NULL,
    "prompt" JSONB NOT NULL,
    "resolution" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Waitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT,
    "toolInvocationId" TEXT,
    "type" "LedgerEntryType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkUserId_key" ON "User"("clerkUserId");

-- CreateIndex
CREATE INDEX "Chat_userId_deletedAt_lastMessageAt_id_idx" ON "Chat"("userId", "deletedAt", "lastMessageAt" DESC, "id");

-- CreateIndex
CREATE INDEX "Chat_userId_deletedAt_pinned_lastMessageAt_idx" ON "Chat"("userId", "deletedAt", "pinned", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "Message_chatId_createdAt_id_idx" ON "Message"("chatId", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "Message_runId_idx" ON "Message"("runId");

-- CreateIndex
CREATE INDEX "Attachment_messageId_position_idx" ON "Attachment"("messageId", "position");

-- CreateIndex
CREATE INDEX "Attachment_userId_source_createdAt_id_idx" ON "Attachment"("userId", "source", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "Attachment_assemblyId_idx" ON "Attachment"("assemblyId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_userMessageId_key" ON "AgentRun"("userMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_assistantMessageId_key" ON "AgentRun"("assistantMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_triggerRunId_key" ON "AgentRun"("triggerRunId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_idempotencyKey_key" ON "AgentRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentRun_chatId_createdAt_idx" ON "AgentRun"("chatId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AgentRun_userId_createdAt_idx" ON "AgentRun"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AgentRun_status_heartbeatAt_idx" ON "AgentRun"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "ToolInvocation_runId_createdAt_idx" ON "ToolInvocation"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolInvocation_providerRunId_idx" ON "ToolInvocation"("providerRunId");

-- CreateIndex
CREATE INDEX "ToolInvocation_userId_createdAt_idx" ON "ToolInvocation"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ToolInvocation_runId_toolCallId_key" ON "ToolInvocation"("runId", "toolCallId");

-- CreateIndex
CREATE UNIQUE INDEX "RunSkill_runId_skillName_assetPath_key" ON "RunSkill"("runId", "skillName", "assetPath");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_toolInvocationId_key" ON "Waitpoint"("toolInvocationId");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_triggerTokenId_key" ON "Waitpoint"("triggerTokenId");

-- CreateIndex
CREATE INDEX "Waitpoint_runId_status_idx" ON "Waitpoint"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_idempotencyKey_key" ON "CreditLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_createdAt_id_idx" ON "CreditLedger"("userId", "createdAt" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_hashedKey_key" ON "ApiKey"("hashedKey");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_userId_idx" ON "WebhookEndpoint"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_idempotencyKey_key" ON "WebhookDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "ToolInvocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userMessageId_fkey" FOREIGN KEY ("userMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_assistantMessageId_fkey" FOREIGN KEY ("assistantMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunSkill" ADD CONSTRAINT "RunSkill_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "ToolInvocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "ToolInvocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints Prisma cannot express (see ARCHITECTURE.md §Data)
-- ---------------------------------------------------------------------------

-- One active AgentRun per Chat. Concurrent sends race on this index; the loser
-- gets a unique-violation which the send route maps to error code `run_active`.
CREATE UNIQUE INDEX "AgentRun_one_active_per_chat"
  ON "AgentRun" ("chatId")
  WHERE "status" IN ('QUEUED', 'RUNNING', 'WAITING', 'STOPPING');

-- Full-text search over message text (generated column above).
CREATE INDEX "Message_searchVector_idx" ON "Message" USING GIN ("searchVector");

-- Trigram search over chat titles.
CREATE INDEX "Chat_title_trgm_idx" ON "Chat" USING GIN ("title" gin_trgm_ops);

-- Rollback notes:
--   DROP INDEX "Chat_title_trgm_idx"; DROP INDEX "Message_searchVector_idx";
--   DROP INDEX "AgentRun_one_active_per_chat"; then drop tables in reverse FK order.
-- Compatibility: requires PostgreSQL >= 12 (generated columns) and pg_trgm.
