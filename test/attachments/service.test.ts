import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_LIMITS, FileMeta, type CreateAssemblyRequest } from "@agent-chat/contracts";

type FileMeta = z.infer<typeof FileMeta>;
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { createAssembly, markUploaded, applyNotification, listAttachments } from "@/services/attachments";
import { truncateAll, createTestUser } from "../db-helpers";

function file(overrides: Partial<FileMeta> = {}): FileMeta {
  return { clientId: "c1", filename: "photo.png", mimeType: "image/png", sizeBytes: 1024, position: 0, ...overrides };
}

/**
 * Seeds prior usage as several rows rather than one, because `Attachment.sizeBytes` is a
 * Postgres `Int` (max ~2.1GB) - a single row can't hold a value near the 5GB monthly quota. This
 * is a real constraint worth flagging: no individual upload can exceed maxFileBytes (500MB), so
 * it never bites in production, but it means the aggregate quota can only ever be reached by
 * summing many rows, never stored in one. See the final report.
 */
async function seedMonthlyUsage(userId: string, totalBytes: number, status: "READY" | "FAILED" = "READY"): Promise<void> {
  const chunk = 1_500_000_000;
  let remaining = totalBytes;
  let i = 0;
  while (remaining > 0) {
    const sizeBytes = Math.min(chunk, remaining);
    await prisma.attachment.create({
      data: { userId, kind: "IMAGE", source: "UPLOAD", status, filename: `seed${i}.png`, mimeType: "image/png", sizeBytes, position: 0 },
    });
    remaining -= sizeBytes;
    i += 1;
  }
}

describe("attachments service", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  describe("createAssembly limits", () => {
    it("rejects more files than maxAttachmentsPerMessage", async () => {
      const user = await createTestUser();
      const files = Array.from({ length: DEFAULT_LIMITS.maxAttachmentsPerMessage + 1 }, (_, i) => file({ clientId: `c${i}`, position: i }));
      const body = { files } as CreateAssemblyRequest;
      await expect(createAssembly({ userId: user.id, body })).rejects.toMatchObject({ code: "validation_error" });
    });

    it("rejects a disallowed mime type", async () => {
      const user = await createTestUser();
      const body: CreateAssemblyRequest = { files: [file({ mimeType: "application/x-msdownload" })] };
      const err = await createAssembly({ userId: user.id, body }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("unsupported_media_type");
    });

    it("rejects a file over maxFileBytes", async () => {
      const user = await createTestUser();
      const body: CreateAssemblyRequest = { files: [file({ sizeBytes: DEFAULT_LIMITS.maxFileBytes + 1 })] };
      const err = await createAssembly({ userId: user.id, body }).catch((e: unknown) => e);
      expect((err as AppError).code).toBe("payload_too_large");
    });

    it("rejects when the monthly upload allowance would be exceeded", async () => {
      const user = await createTestUser();
      await seedMonthlyUsage(user.id, DEFAULT_LIMITS.monthlyUploadBytes - 100);
      const body: CreateAssemblyRequest = { files: [file({ sizeBytes: 200 })] };
      const err = await createAssembly({ userId: user.id, body }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("validation_error");
      expect((err as AppError).details).toMatchObject({ reason: "monthly_quota" });
    });

    it("excludes FAILED/EXPIRED rows from the monthly quota sum", async () => {
      const user = await createTestUser();
      await seedMonthlyUsage(user.id, DEFAULT_LIMITS.monthlyUploadBytes, "FAILED");
      const body: CreateAssemblyRequest = { files: [file({ sizeBytes: 200 })] };
      await expect(createAssembly({ userId: user.id, body })).resolves.toBeDefined();
    });
  });

  describe("createAssembly happy path", () => {
    it("signs the assembly params and pre-creates UPLOADING rows carrying the clientId", async () => {
      const user = await createTestUser();
      const body: CreateAssemblyRequest = { files: [file({ clientId: "abc", filename: "cat.png" })] };
      const response = await createAssembly({ userId: user.id, body });

      expect(response.assemblyOptions.params).toContain('"robot":"/upload/handle"');
      expect(response.assemblyOptions.signature).toMatch(/^sha384:[0-9a-f]+$/);
      expect(response.attachments).toHaveLength(1);
      expect(response.attachments[0]).toMatchObject({ clientId: "abc", status: "uploading", filename: "cat.png" });

      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: response.attachments[0]!.id } });
      expect(row.status).toBe("UPLOADING");
      expect((row.meta as { nonce?: string } | null)?.nonce).toEqual(expect.any(String));
    });
  });

  describe("markUploaded", () => {
    it("transitions UPLOADING -> PROCESSING and sets assemblyId, idempotently", async () => {
      const user = await createTestUser();
      const response = await createAssembly({ userId: user.id, body: { files: [file()] } });
      const attachmentId = response.attachments[0]!.id;

      await markUploaded({ userId: user.id, body: { assemblyId: "asm_123", files: [{ attachmentId }] } });
      let row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      expect(row).toMatchObject({ status: "PROCESSING", assemblyId: "asm_123" });

      // Repeat call: the status guard makes it a no-op, not an error.
      await expect(markUploaded({ userId: user.id, body: { assemblyId: "asm_123", files: [{ attachmentId }] } })).resolves.toBeUndefined();
      row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      expect(row.status).toBe("PROCESSING");
    });
  });

  describe("applyNotification", () => {
    it("reconciles a successful assembly to READY with url/dimensions, correlated by the nonce echoed through fields", async () => {
      const user = await createTestUser();
      const response = await createAssembly({ userId: user.id, body: { files: [file({ filename: "cat.png" })] } });
      const attachmentId = response.attachments[0]!.id;
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      const nonce = (row.meta as { nonce: string }).nonce;

      const payload = JSON.stringify({
        ok: "ASSEMBLY_COMPLETED",
        assembly_id: "asm_success_1",
        fields: { userId: user.id, nonce },
        results: { ":original": [{ original_name: "cat.png", ssl_url: "https://tmp.transloadit.com/cat.png", mime: "image/png", size: 2048, meta: { width: 100, height: 200 } }] },
      });

      await applyNotification(payload);
      const updated = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      expect(updated).toMatchObject({ status: "READY", url: "https://tmp.transloadit.com/cat.png", width: 100, height: 200, sizeBytes: 2048, assemblyId: "asm_success_1" });
      expect(updated.expiresAt).not.toBeNull(); // temp URL (no store credentials configured in test env)

      // Duplicate delivery of the same notification: the status guard makes it a no-op.
      await applyNotification(payload);
      const stillUpdated = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      expect(stillUpdated.status).toBe("READY");
      expect(stillUpdated.updatedAt.getTime()).toBe(updated.updatedAt.getTime());
    });

    it("reconciles a failed assembly to FAILED", async () => {
      const user = await createTestUser();
      const response = await createAssembly({ userId: user.id, body: { files: [file({ filename: "bad.png" })] } });
      const attachmentId = response.attachments[0]!.id;
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      const nonce = (row.meta as { nonce: string }).nonce;

      await applyNotification(JSON.stringify({ error: "ASSEMBLY_EXECUTION_FAILED", assembly_id: "asm_fail_1", fields: { userId: user.id, nonce } }));
      const updated = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      expect(updated.status).toBe("FAILED");
    });

    it("is a no-op when no attachment correlates to the notification (unknown user/nonce)", async () => {
      await expect(applyNotification(JSON.stringify({ ok: "ASSEMBLY_COMPLETED", assembly_id: "asm_x", fields: { userId: "nonexistent", nonce: "n" } }))).resolves.toBeUndefined();
    });
  });

  describe("listAttachments pagination", () => {
    it("pages newest-first with a keyset cursor", async () => {
      const user = await createTestUser();
      const base = Date.parse("2026-01-01T00:00:00.000Z");
      for (let i = 0; i < 3; i++) {
        await prisma.attachment.create({
          data: {
            userId: user.id,
            kind: "IMAGE",
            source: "GENERATED",
            status: "READY",
            filename: `f${i}.png`,
            mimeType: "image/png",
            sizeBytes: 10,
            position: 0,
            createdAt: new Date(base + i * 1000),
          },
        });
      }

      const page1 = await listAttachments({ userId: user.id, query: { limit: 2 } });
      expect(page1.items.map((a) => a.filename)).toEqual(["f2.png", "f1.png"]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listAttachments({ userId: user.id, query: { limit: 2, cursor: page1.nextCursor! } });
      expect(page2.items.map((a) => a.filename)).toEqual(["f0.png"]);
      expect(page2.nextCursor).toBeNull();
    });

    it("filters by kind and source", async () => {
      const user = await createTestUser();
      await prisma.attachment.create({ data: { userId: user.id, kind: "IMAGE", source: "GENERATED", status: "READY", filename: "a.png", mimeType: "image/png", sizeBytes: 1, position: 0 } });
      await prisma.attachment.create({ data: { userId: user.id, kind: "VIDEO", source: "UPLOAD", status: "READY", filename: "b.mp4", mimeType: "video/mp4", sizeBytes: 1, position: 0 } });

      const images = await listAttachments({ userId: user.id, query: { limit: 10, kind: "image" } });
      expect(images.items.map((a) => a.filename)).toEqual(["a.png"]);

      const uploads = await listAttachments({ userId: user.id, query: { limit: 10, source: "upload" } });
      expect(uploads.items.map((a) => a.filename)).toEqual(["b.mp4"]);
    });
  });
});
