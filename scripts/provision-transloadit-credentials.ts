/**
 * Registers the S3 media bucket with Transloadit as "Template Credentials" so the upload Assembly's
 * /s3/store step can write to it (services/attachments.ts, gated on TRANSLOADIT_STORE_CREDENTIALS).
 * Reads TRANSLOADIT_KEY / TRANSLOADIT_SECRET / S3_BUCKET / AWS_REGION / AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY from the environment (.env). Idempotent by name.
 *   pnpm exec tsx scripts/provision-transloadit-credentials.ts [name]   # default agent-chat-s3
 * Afterwards set TRANSLOADIT_STORE_CREDENTIALS=<name> everywhere the API runs.
 */
import { createHmac } from "node:crypto";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

const name = process.argv[2] ?? "agent-chat-s3";
const key = need("TRANSLOADIT_KEY");
const secret = need("TRANSLOADIT_SECRET");

async function call(method: "GET" | "POST" | "PUT", path: string, extra: Record<string, unknown> = {}) {
  const params = JSON.stringify({ auth: { key, expires: new Date(Date.now() + 5 * 60_000).toISOString() }, ...extra });
  const signature = `sha384:${createHmac("sha384", secret).update(params, "utf8").digest("hex")}`;
  const body = new URLSearchParams({ params, signature });
  const url = `https://api2.transloadit.com${path}${method === "GET" ? `?${body.toString()}` : ""}`;
  const res = await fetch(url, method === "GET" ? { method } : { method, body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function main() {
  const content = { key: need("AWS_ACCESS_KEY_ID"), secret: need("AWS_SECRET_ACCESS_KEY"), bucket: need("S3_BUCKET"), bucket_region: process.env.AWS_REGION ?? "us-east-1" };
  const list = await call("GET", "/template_credentials");
  const existing = ((list.json.credentials as Array<{ id: string; name: string }> | undefined) ?? []).find((c) => c.name === name);
  const res = existing
    ? await call("PUT", `/template_credentials/${existing.id}`, { name, type: "s3", content })
    : await call("POST", "/template_credentials", { name, type: "s3", content });
  const summary = { status: res.status, ok: res.json.ok, error: res.json.error, message: res.json.message, id: (res.json.credential as { id?: string } | undefined)?.id ?? existing?.id };
  console.log(JSON.stringify(summary));
  if (res.status >= 300) process.exit(1);
  console.log(`TRANSLOADIT_STORE_CREDENTIALS=${name}`);
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
