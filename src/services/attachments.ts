import {
  Attachment as AttachmentContract,
  DEFAULT_LIMITS,
  decodeCursor,
  encodeCursor,
  type AttachmentUploadedRequest,
  type CreateAssemblyRequest,
  type CreateAssemblyResponse,
  type ListAttachmentsQuery,
  type Page,
} from "@agent-chat/contracts";
import { getEnv } from "@/lib/env";
import { errors, AppError } from "@/lib/errors";
import { prisma } from "@/lib/db";
import type { Attachment as AttachmentRow } from "@/generated/prisma/client";
import { AttachmentKind, AttachmentSource, AttachmentStatus } from "@/generated/prisma/enums";
import { signParams } from "@/lib/transloadit/signature";
import { assemblyFailed, matchAttachmentsToResults, parseAssemblyStatus, pickResultFiles } from "@/lib/transloadit/notify";

/**
 * Attachments service: signed Transloadit assembly params + pre-created rows, upload
 * completion, the notify webhook's DB reconciliation, and the media-library listing.
 * See ARCHITECTURE.md §9 and the task brief's Transloadit section.
 */

const NOTIFY_PATH = "/api/v1/attachments/transloadit/notify";
const ASSEMBLY_EXPIRY_MS = 60 * 60 * 1000; // 1h, matches the signed `auth.expires`
const TEMP_URL_EXPIRY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES: AttachmentStatus[] = [AttachmentStatus.UPLOADING, AttachmentStatus.PROCESSING];

function kindFromMime(mimeType: string): AttachmentKind {
  if (mimeType.startsWith("image/")) return AttachmentKind.IMAGE;
  if (mimeType.startsWith("video/")) return AttachmentKind.VIDEO;
  if (mimeType.startsWith("audio/")) return AttachmentKind.AUDIO;
  return AttachmentKind.FILE;
}

function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function serializeAttachment(row: AttachmentRow): AttachmentContract {
  return AttachmentContract.parse({
    id: row.id,
    kind: row.kind.toLowerCase(),
    source: row.source.toLowerCase(),
    status: row.status.toLowerCase(),
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    url: row.url,
    previewUrl: row.previewUrl,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    position: row.position,
    assemblyId: row.assemblyId,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  });
}

type AssemblyParams = { paramsString: string; signature: string; expiresAt: Date };

/**
 * Builds and signs the Transloadit Assembly params (ARCHITECTURE.md §9 / task brief). The `store`
 * step (and its S3-style path templating) is only included when TRANSLOADIT_STORE_CREDENTIALS is
 * configured; otherwise uploads land as Transloadit's own temporary `:original` URLs (24h expiry,
 * handled in applyNotification below). `userId` and `nonce` are interpolated into the store path
 * at build time (they're known here); `${file.url_name}` is left as a literal template for
 * Transloadit to substitute per file - hence the escaped `\${file.url_name}` in the template
 * literal below.
 */
function buildAssemblyParams(args: { userId: string; chatId: string | undefined; nonce: string }): AssemblyParams {
  const env = getEnv();
  const expiresAt = new Date(Date.now() + ASSEMBLY_EXPIRY_MS);

  const steps: Record<string, unknown> = { ":original": { robot: "/upload/handle" } };
  if (env.TRANSLOADIT_STORE_CREDENTIALS) {
    steps.store = {
      use: ":original",
      robot: "/s3/store",
      credentials: env.TRANSLOADIT_STORE_CREDENTIALS,
      path: `uploads/${args.userId}/${args.nonce}/\${file.url_name}`,
    };
  }

  const params = {
    auth: { key: env.TRANSLOADIT_KEY, expires: expiresAt.toISOString(), nonce: args.nonce },
    steps,
    notify_url: `${env.PUBLIC_API_BASE_URL}${NOTIFY_PATH}`,
    // `nonce` beyond the request's own auth.nonce is intentionally echoed back into `fields` too:
    // it's how applyNotification() correlates pre-created rows to an inbound notification before
    // /attachments/uploaded has run and set `assemblyId` (see that function's doc comment).
    fields: { userId: args.userId, ...(args.chatId ? { chatId: args.chatId } : {}), nonce: args.nonce },
  };
  const paramsString = JSON.stringify(params);
  const signature = signParams(paramsString, env.TRANSLOADIT_SECRET);
  return { paramsString, signature, expiresAt };
}

function assertWithinLimits(files: CreateAssemblyRequest["files"]): void {
  if (files.length > DEFAULT_LIMITS.maxAttachmentsPerMessage) {
    throw errors.validation("Too many attachments in one request", { reason: "too_many_attachments", max: DEFAULT_LIMITS.maxAttachmentsPerMessage });
  }
  for (const file of files) {
    if (!DEFAULT_LIMITS.allowedMimeTypes.includes(file.mimeType)) {
      throw new AppError("unsupported_media_type", `Unsupported file type: ${file.mimeType}`, { details: { filename: file.filename, mimeType: file.mimeType } });
    }
    if (file.sizeBytes > DEFAULT_LIMITS.maxFileBytes) {
      throw new AppError("payload_too_large", `File too large: ${file.filename}`, { details: { filename: file.filename, maxBytes: DEFAULT_LIMITS.maxFileBytes } });
    }
  }
}

/**
 * Monthly upload quota: sums this user's UPLOAD-source Attachment bytes created since the start
 * of the current calendar month. FAILED/EXPIRED rows are excluded - an upload that never actually
 * completed didn't consume real storage/bandwidth, so it shouldn't count against the allowance.
 */
async function assertWithinMonthlyQuota(userId: string, requestedBytes: number): Promise<void> {
  const agg = await prisma.attachment.aggregate({
    _sum: { sizeBytes: true },
    where: {
      userId,
      source: AttachmentSource.UPLOAD,
      createdAt: { gte: startOfMonth(new Date()) },
      status: { notIn: [AttachmentStatus.FAILED, AttachmentStatus.EXPIRED] },
    },
  });
  const usedThisMonth = agg._sum.sizeBytes ?? 0;
  if (usedThisMonth + requestedBytes > DEFAULT_LIMITS.monthlyUploadBytes) {
    throw errors.validation("Monthly upload allowance reached", { reason: "monthly_quota" });
  }
}

export async function createAssembly(args: { userId: string; body: CreateAssemblyRequest }): Promise<CreateAssemblyResponse> {
  assertWithinLimits(args.body.files);
  const requestedBytes = args.body.files.reduce((sum, f) => sum + f.sizeBytes, 0);
  await assertWithinMonthlyQuota(args.userId, requestedBytes);

  const nonce = crypto.randomUUID();
  const { paramsString, signature, expiresAt } = buildAssemblyParams({ userId: args.userId, chatId: args.body.chatId, nonce });

  const created = await prisma.$transaction(
    args.body.files.map((file) =>
      prisma.attachment.create({
        data: {
          userId: args.userId,
          chatId: args.body.chatId ?? null,
          kind: kindFromMime(file.mimeType),
          source: AttachmentSource.UPLOAD,
          status: AttachmentStatus.UPLOADING,
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          position: file.position,
          meta: { nonce, clientId: file.clientId },
        },
      }),
    ),
  );

  return {
    assemblyOptions: { params: paramsString, signature },
    expiresAt: expiresAt.toISOString(),
    attachments: created.map((row, i) => ({ ...serializeAttachment(row), clientId: args.body.files[i]?.clientId ?? "" })),
  };
}

/** Idempotent by construction: the `status: UPLOADING` guard means a repeat call is a no-op. */
export async function markUploaded(args: { userId: string; body: AttachmentUploadedRequest }): Promise<void> {
  await prisma.$transaction(
    args.body.files.map((file) =>
      prisma.attachment.updateMany({
        where: { id: file.attachmentId, userId: args.userId, status: AttachmentStatus.UPLOADING },
        data: { status: AttachmentStatus.PROCESSING, assemblyId: args.body.assemblyId },
      }),
    ),
  );
}

/**
 * Reconciles the (already signature-verified) Transloadit notify payload with our pre-created
 * rows. Correlation race: the notify webhook can arrive before the client's own
 * POST /attachments/uploaded call sets `assemblyId`, so rows are looked up by `userId` + the
 * `nonce` echoed back in `fields` (see buildAssemblyParams) as well as by `assemblyId`, whichever
 * matches. Every write is gated on `status IN (UPLOADING, PROCESSING)`, so a duplicate/retried
 * notification for an already-settled row is a no-op.
 */
export async function applyNotification(rawTransloaditField: string): Promise<void> {
  const assembly = parseAssemblyStatus(rawTransloaditField);
  const fields = assembly.fields ?? {};
  const userId = typeof fields.userId === "string" ? fields.userId : undefined;
  const nonce = typeof fields.nonce === "string" ? fields.nonce : undefined;
  if (!userId) return; // cannot safely correlate to any user's rows

  const candidates = await prisma.attachment.findMany({ where: { userId, status: { in: ACTIVE_STATUSES } } });
  const scoped = candidates.filter((row) => {
    if (row.assemblyId === assembly.assembly_id) return true;
    const meta = row.meta as { nonce?: unknown } | null;
    return nonce !== undefined && meta !== null && meta.nonce === nonce;
  });
  if (scoped.length === 0) return;

  if (assemblyFailed(assembly)) {
    await prisma.$transaction(
      scoped.map((row) =>
        prisma.attachment.updateMany({
          where: { id: row.id, status: { in: ACTIVE_STATUSES } },
          data: {
            status: AttachmentStatus.FAILED,
            assemblyId: assembly.assembly_id,
            meta: { ...(typeof row.meta === "object" && row.meta !== null ? row.meta : {}), error: assembly.error ?? "unknown_error" },
          },
        }),
      ),
    );
    return;
  }

  const results = pickResultFiles(assembly);
  const matches = matchAttachmentsToResults(scoped, results);
  const storedPermanently = Boolean(getEnv().TRANSLOADIT_STORE_CREDENTIALS) && Object.prototype.hasOwnProperty.call(assembly.results ?? {}, "store");

  await prisma.$transaction(
    matches.map(({ attachment, result }) => {
      const url = result?.ssl_url ?? result?.url ?? null;
      return prisma.attachment.updateMany({
        where: { id: attachment.id, status: { in: ACTIVE_STATUSES } },
        data: {
          status: url ? AttachmentStatus.READY : AttachmentStatus.FAILED,
          assemblyId: assembly.assembly_id,
          url,
          previewUrl: url,
          mimeType: result?.mime ?? attachment.mimeType,
          sizeBytes: result?.size ?? attachment.sizeBytes,
          width: result?.meta?.width ?? null,
          height: result?.meta?.height ?? null,
          durationMs: result?.meta?.duration !== undefined ? Math.round(result.meta.duration * 1000) : null,
          expiresAt: url && !storedPermanently ? new Date(Date.now() + TEMP_URL_EXPIRY_MS) : null,
        },
      });
    }),
  );
}

export async function listAttachments(args: { userId: string; query: ListAttachmentsQuery }): Promise<Page<AttachmentContract>> {
  const cursor = args.query.cursor ? decodeCursor(args.query.cursor) : null;
  if (args.query.cursor && !cursor) throw errors.validation("Invalid cursor");

  const rows = await prisma.attachment.findMany({
    where: {
      userId: args.userId,
      ...(args.query.kind ? { kind: args.query.kind.toUpperCase() as AttachmentKind } : {}),
      ...(args.query.source ? { source: args.query.source.toUpperCase() as AttachmentSource } : {}),
      ...(cursor
        ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: args.query.limit + 1,
  });

  const page = rows.slice(0, args.query.limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > args.query.limit && last ? encodeCursor(last.createdAt, last.id) : null;
  return { items: page.map(serializeAttachment), nextCursor };
}
