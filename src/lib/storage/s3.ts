import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * S3-compatible object storage for media (brief: "Transloadit Community plan + S3-compatible object
 * storage"). Two producers write here:
 *   - uploads: Transloadit's /s3/store step, configured through TRANSLOADIT_STORE_CREDENTIALS
 *     (a Template Credentials entry that points at the same bucket), keys `uploads/<userId>/<nonce>/…`;
 *   - generated assets: this module copies a provider result (Magica URLs expire) to
 *     `generated/<userId>/<invocationId>/<n>.<ext>` when a run persists it (run-store.ts).
 * Reads are anonymous: the bucket policy grants GET on `uploads/*` and `generated/*` only
 * (scripts/provision-s3.ts). Everything is optional: with S3_BUCKET unset the app keeps provider
 * URLs with their expiry, exactly as before.
 *
 * The SDK reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION from the environment itself.
 */

export type MediaStore = {
  /** Downloads `sourceUrl` and stores it under `key`; returns the public URL of the stored copy. */
  putFromUrl(args: { sourceUrl: string; key: string; contentType: string; signal?: AbortSignal }): Promise<{ url: string; sizeBytes: number }>;
  publicUrl(key: string): string;
};

/** Largest provider result we copy inline (a generated video from merge_videos stays well below). */
export const MAX_COPY_BYTES = 200 * 1024 * 1024;

function publicBase(bucket: string, region: string): string {
  const configured = getEnv().S3_PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  return region === "us-east-1" ? `https://${bucket}.s3.amazonaws.com` : `https://${bucket}.s3.${region}.amazonaws.com`;
}

export function createS3MediaStore(opts: { bucket: string; region: string; client?: S3Client }): MediaStore {
  const client = opts.client ?? new S3Client({ region: opts.region });
  const base = publicBase(opts.bucket, opts.region);
  return {
    publicUrl: (key) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`,
    async putFromUrl({ sourceUrl, key, contentType, signal }) {
      const res = await fetch(sourceUrl, signal ? { signal } : {});
      if (!res.ok) throw new Error(`source fetch failed with ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_COPY_BYTES) throw new Error(`source is ${declared} bytes; the copy limit is ${MAX_COPY_BYTES}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.byteLength > MAX_COPY_BYTES) throw new Error(`source is ${body.byteLength} bytes; the copy limit is ${MAX_COPY_BYTES}`);
      await client.send(new PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: body, ContentType: res.headers.get("content-type") ?? contentType, CacheControl: "public, max-age=31536000, immutable" }));
      return { url: `${base}/${key.split("/").map(encodeURIComponent).join("/")}`, sizeBytes: body.byteLength };
    },
  };
}

let cached: MediaStore | null | undefined;

/** The configured store, or null when S3_BUCKET is unset. Cached per process. */
export function getMediaStore(): MediaStore | null {
  if (cached !== undefined) return cached;
  const env = getEnv();
  if (!env.S3_BUCKET) {
    cached = null;
    return cached;
  }
  cached = createS3MediaStore({ bucket: env.S3_BUCKET, region: env.AWS_REGION });
  logger().info({ bucket: env.S3_BUCKET, region: env.AWS_REGION }, "media store: S3 configured");
  return cached;
}

/** Test-only: inject a fake store (or null to disable). */
export function __setMediaStoreForTests(store: MediaStore | null | undefined): void {
  cached = store;
}

/** `generated/<userId>/<invocationId>/<index>.<ext>`; the extension comes from the source URL or the MIME type. */
export function generatedAssetKey(args: { userId: string; invocationId: string; index: number; sourceUrl: string; mimeType: string }): string {
  const fromUrl = (() => {
    try {
      const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(args.sourceUrl).pathname);
      return m?.[1]?.toLowerCase();
    } catch {
      return undefined;
    }
  })();
  const fromMime = args.mimeType.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg").replace("quicktime", "mov");
  const ext = fromUrl ?? fromMime ?? "bin";
  return `generated/${args.userId}/${args.invocationId}/${args.index}.${ext}`;
}
