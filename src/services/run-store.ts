import {
  AttachmentKind as AttachmentKindContract,
  JsonValue as JsonValueSchema,
  RunStatus as RunStatusContract,
  ToolInvocationStatus as ToolInvocationStatusContract,
  blocksToPlainText,
  type ContentBlock,
} from "@agent-chat/contracts";
import type {
  FinalizeInput,
  InvocationCreate,
  InvocationPatch,
  RunRecord,
  RunSnapshot,
  RunStore,
} from "@/agent/loop/ports";
import type { ToolEffect } from "@/agent/tools/types";
import { prisma, Prisma, mc } from "@/lib/db";
import { errors } from "@/lib/errors";
import { releaseAdmission } from "@/lib/credits";
import { parseContentBlocks, serializeAttachment, serializeMessage } from "@/services/serializers";
import type { AgentRun as DbAgentRun, RunStatus as RunStatusDb } from "@/generated/prisma/client";

/** Prisma RunStatus values considered "active" (mirrors contracts' ACTIVE_RUN_STATUSES, uppercased). */
const ACTIVE_DB: RunStatusDb[] = ["QUEUED", "RUNNING", "WAITING", "STOPPING"];

const RUN_TERMINAL_DB: Record<FinalizeInput["status"], "COMPLETED" | "FAILED" | "CANCELLED"> = {
  completed: "COMPLETED",
  failed: "FAILED",
  cancelled: "CANCELLED",
};

const MESSAGE_TERMINAL_DB: Record<FinalizeInput["status"], "COMPLETED" | "FAILED" | "CANCELLED"> = {
  completed: "COMPLETED",
  failed: "FAILED",
  cancelled: "CANCELLED",
};

const DEFAULT_MIME_BY_KIND: Record<string, string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/mpeg",
  file: "application/octet-stream",
};

/** Prisma 7 + @prisma/adapter-pg puts constraint info in the formatted message, not `meta.target`. */
function isUniqueViolationOn(err: unknown, constraintName: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  return typeof err.message === "string" && err.message.includes(constraintName);
}

function toRunRecord(run: DbAgentRun): RunRecord {
  return {
    id: run.id,
    chatId: run.chatId,
    userId: run.userId,
    userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId,
    status: RunStatusContract.parse(run.status.toLowerCase()),
    planMode: run.planMode,
    requestedModel: run.requestedModel,
    microcreditsReserved: mc(run.microcreditsReserved),
    cancelRequestedAt: run.cancelRequestedAt ? run.cancelRequestedAt.toISOString() : null,
  };
}

function deriveFilename(url: string, invocationId: string, index: number): string {
  try {
    const { pathname } = new URL(url);
    const base = pathname.split("/").filter(Boolean).pop();
    if (base) return decodeURIComponent(base).slice(0, 255);
  } catch {
    /* fall through to synthetic name */
  }
  return `generated-${invocationId}-${index}`;
}

/** Prisma implementation of RunStore (agent loop persistence port). */
export function createRunStore(): RunStore {
  return {
    async loadSnapshot(runId: string): Promise<RunSnapshot> {
      const run = await prisma.agentRun.findUnique({ where: { id: runId } });
      if (!run) throw errors.notFound("AgentRun");

      const [historyRows, userAttachments, skillRows, assistantMessage] = await Promise.all([
        prisma.message.findMany({
          where: { chatId: run.chatId, id: { not: run.assistantMessageId } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 40,
          include: { attachments: { where: { status: "READY" }, orderBy: { position: "asc" } } },
        }),
        prisma.attachment.findMany({ where: { messageId: run.userMessageId, status: "READY" }, orderBy: { position: "asc" } }),
        prisma.runSkill.findMany({ where: { runId } }),
        prisma.message.findUnique({ where: { id: run.assistantMessageId } }),
      ]);
      if (!assistantMessage) throw errors.notFound("Assistant message");

      const history = historyRows
        .slice()
        .reverse()
        .map((m) => serializeMessage(m, m.attachments));

      return {
        run: toRunRecord(run),
        history,
        attachments: userAttachments.map(serializeAttachment),
        loadedSkills: skillRows.map((s) => ({ skillName: s.skillName, assetPath: s.assetPath, contentHash: s.contentHash })),
        persistedBlocks: parseContentBlocks(assistantMessage.content),
      };
    },

    async markRunning(runId: string): Promise<boolean> {
      const now = new Date();
      const result = await prisma.agentRun.updateMany({
        where: { id: runId, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "RUNNING", startedAt: now, heartbeatAt: now },
      });
      return result.count > 0;
    },

    async heartbeat(runId: string, patch?: { currentStep?: string | null; routedModel?: string | null }): Promise<void> {
      const data: Prisma.AgentRunUpdateManyMutationInput = { heartbeatAt: new Date() };
      if (patch && "currentStep" in patch) data.currentStep = patch.currentStep ?? null;
      if (patch && "routedModel" in patch) data.routedModel = patch.routedModel ?? null;
      await prisma.agentRun.updateMany({ where: { id: runId, status: { in: ACTIVE_DB } }, data });
    },

    async isCancelRequested(runId: string): Promise<boolean> {
      const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { cancelRequestedAt: true } });
      return run?.cancelRequestedAt != null;
    },

    async setStatus(runId: string, status: "running" | "waiting"): Promise<void> {
      await prisma.agentRun.updateMany({
        where: { id: runId, status: { in: ACTIVE_DB } },
        data: { status: status === "running" ? "RUNNING" : "WAITING" },
      });
    },

    async checkpoint(runId: string, blocks: ContentBlock[]): Promise<void> {
      await prisma.$transaction(async (tx) => {
        const run = await tx.agentRun.findUnique({ where: { id: runId }, select: { assistantMessageId: true, status: true } });
        if (!run || !ACTIVE_DB.includes(run.status)) return;
        await tx.message.update({
          where: { id: run.assistantMessageId },
          data: { content: blocks as unknown as Prisma.InputJsonValue, status: "STREAMING", textContent: blocksToPlainText(blocks) },
        });
      });
    },

    async createInvocation(input: InvocationCreate) {
      try {
        const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: input.runId }, select: { userId: true } });
        const created = await prisma.toolInvocation.create({
          data: {
            runId: input.runId,
            userId: run.userId,
            messageId: input.messageId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            input: input.input as Prisma.InputJsonValue,
            blockIndex: input.blockIndex,
            microcreditsEstimated: BigInt(input.microcreditsEstimated),
            status: "PENDING",
          },
        });
        return { invocationId: created.id, existing: false, status: "pending" as const, output: null, microcreditsCharged: 0 };
      } catch (err) {
        if (isUniqueViolationOn(err, "ToolInvocation_runId_toolCallId_key")) {
          const existing = await prisma.toolInvocation.findUniqueOrThrow({
            where: { runId_toolCallId: { runId: input.runId, toolCallId: input.toolCallId } },
          });
          return {
            invocationId: existing.id,
            existing: true,
            status: ToolInvocationStatusContract.parse(existing.status.toLowerCase()),
            output: JsonValueSchema.nullable().parse(existing.output),
            microcreditsCharged: mc(existing.microcreditsCharged),
          };
        }
        throw err;
      }
    },

    async updateInvocation(invocationId: string, patch: InvocationPatch): Promise<void> {
      const data: Record<string, unknown> = {};
      if (patch.status !== undefined) data.status = patch.status.toUpperCase();
      if (patch.output !== undefined) data.output = patch.output;
      if (patch.error !== undefined) data.error = patch.error;
      if (patch.providerRunId !== undefined) data.providerRunId = patch.providerRunId;
      if (patch.startedAt !== undefined) data.startedAt = patch.startedAt;
      if (patch.finishedAt !== undefined) data.finishedAt = patch.finishedAt;
      if (patch.durationMs !== undefined) data.durationMs = patch.durationMs;
      if (patch.microcreditsCharged !== undefined) data.microcreditsCharged = BigInt(patch.microcreditsCharged);
      if (Object.keys(data).length === 0) return;
      await prisma.toolInvocation.update({ where: { id: invocationId }, data: data as Prisma.ToolInvocationUpdateInput });
    },

    async recordSkill(runId: string, skillName: string, assetPath: string, contentHash: string): Promise<{ deduplicated: boolean }> {
      try {
        await prisma.runSkill.create({ data: { runId, skillName, assetPath, contentHash } });
        return { deduplicated: false };
      } catch (err) {
        if (isUniqueViolationOn(err, "RunSkill_runId_skillName_assetPath_key")) {
          const existing = await prisma.runSkill.findUniqueOrThrow({
            where: { runId_skillName_assetPath: { runId, skillName, assetPath } },
          });
          if (existing.contentHash === contentHash) return { deduplicated: true };
          await prisma.runSkill.update({ where: { id: existing.id }, data: { contentHash } });
          return { deduplicated: false };
        }
        throw err;
      }
    },

    async saveGeneratedAssets(args: {
      runId: string;
      userId: string;
      chatId: string;
      messageId: string;
      invocationId: string;
      assets: Array<Extract<ToolEffect, { type: "asset" }>["asset"]>;
    }): Promise<ContentBlock[]> {
      const blocks: ContentBlock[] = [];
      for (let i = 0; i < args.assets.length; i++) {
        const asset = args.assets[i];
        if (!asset) continue;
        const mimeType = asset.mimeType ?? DEFAULT_MIME_BY_KIND[asset.kind] ?? "application/octet-stream";
        const filename = deriveFilename(asset.url, args.invocationId, i);
        const kindDb = AttachmentKindContract.parse(asset.kind).toUpperCase() as "IMAGE" | "VIDEO" | "AUDIO" | "FILE";
        const created = await prisma.attachment.create({
          data: {
            userId: args.userId,
            chatId: args.chatId,
            messageId: args.messageId,
            toolInvocationId: args.invocationId,
            kind: kindDb,
            source: "GENERATED",
            status: "READY",
            filename,
            mimeType,
            url: asset.url,
            width: asset.width ?? null,
            height: asset.height ?? null,
            durationMs: asset.durationMs ?? null,
            expiresAt: asset.expiresAt ? new Date(asset.expiresAt) : null,
          },
        });
        blocks.push({
          type: "asset",
          kind: asset.kind,
          url: asset.url,
          attachmentId: created.id,
          mimeType,
          ...(asset.toolCallId !== undefined ? { toolCallId: asset.toolCallId } : {}),
          ...(asset.width !== undefined ? { width: asset.width } : {}),
          ...(asset.height !== undefined ? { height: asset.height } : {}),
          ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}),
          ...(asset.expiresAt !== undefined ? { expiresAt: asset.expiresAt } : {}),
        });
      }
      return blocks;
    },

    async finalize(runId: string, input: FinalizeInput): Promise<void> {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.agentRun.updateMany({
          where: { id: runId, status: { in: ACTIVE_DB } },
          data: {
            status: RUN_TERMINAL_DB[input.status],
            usage: input.usage as unknown as Prisma.InputJsonValue,
            routedModel: input.routedModel,
            error: input.error ? (input.error as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            finishedAt: new Date(),
          },
        });
        if (updated.count === 0) return; // already finalized: idempotent no-op

        const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
        await tx.message.update({
          where: { id: run.assistantMessageId },
          data: {
            content: input.blocks as unknown as Prisma.InputJsonValue,
            status: MESSAGE_TERMINAL_DB[input.status],
            textContent: blocksToPlainText(input.blocks),
          },
        });
        if (run.microcreditsReserved > 0n) {
          await releaseAdmission({ userId: run.userId, runId, microcredits: mc(run.microcreditsReserved) }, tx);
        }
      });
    },
  };
}
