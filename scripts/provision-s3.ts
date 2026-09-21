/**
 * Provisions the S3 media bucket used by Transloadit (/s3/store) and by the generated-asset copy step.
 * Idempotent. Reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION from the environment (.env);
 * S3_BUCKET selects an existing bucket, otherwise a new agent-chat-media-<hex> bucket is created.
 *   pnpm exec tsx scripts/provision-s3.ts
 * Result: ACLs blocked (owner-enforced objects), a bucket policy granting anonymous GET on uploads/* and
 * generated/* only, permissive read CORS, and a probe proving the policy (200 inside, 403 outside).
 */
import { randomBytes } from "node:crypto";
import { S3Client, CreateBucketCommand, HeadBucketCommand, PutPublicAccessBlockCommand, PutBucketPolicyCommand, PutBucketCorsCommand, PutObjectCommand, DeleteObjectCommand, GetBucketLocationCommand } from "@aws-sdk/client-s3";

const region = process.env.AWS_REGION ?? "us-east-1";
const s3 = new S3Client({ region });
const bucket = process.env.S3_BUCKET ?? `agent-chat-media-${randomBytes(4).toString("hex")}`;

async function main() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log("bucket exists:", bucket);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectOwnership: "BucketOwnerEnforced" }));
    console.log("bucket created:", bucket);
  }
  const loc = await s3.send(new GetBucketLocationCommand({ Bucket: bucket }));
  console.log("location:", loc.LocationConstraint ?? "us-east-1");
  // Keep ACLs blocked (objects are owner-enforced); allow a bucket policy that grants public READ on the media prefixes only.
  await s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false } }));
  const policy = {
    Version: "2012-10-17",
    Statement: [{ Sid: "PublicReadMedia", Effect: "Allow", Principal: "*", Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::${bucket}/uploads/*`, `arn:aws:s3:::${bucket}/generated/*`] }],
  };
  await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
  await s3.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: [{ AllowedMethods: ["GET", "HEAD"], AllowedOrigins: ["*"], AllowedHeaders: ["*"], MaxAgeSeconds: 86400 }] } }));
  console.log("public-read policy + CORS applied for uploads/* and generated/*");
  // Verify: write a tiny object under generated/ and read it back anonymously.
  const key = `generated/_probe/${Date.now()}.txt`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "ok", ContentType: "text/plain" }));
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  const res = await fetch(url);
  console.log("anonymous GET", url.replace(bucket, "<bucket>"), "->", res.status, await res.text());
  const privateKey = `_private/${Date.now()}.txt`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: privateKey, Body: "secret", ContentType: "text/plain" }));
  const res2 = await fetch(`https://${bucket}.s3.${region}.amazonaws.com/${privateKey}`);
  console.log("anonymous GET outside media prefixes ->", res2.status, "(403 expected)");
  // The probes have done their job; do not leave them in the bucket.
  await Promise.all([key, privateKey].map((Key) => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }))));
  console.log("S3_BUCKET=" + bucket);
}
main().catch((e) => { console.error("FAILED:", e.name, e.message); process.exit(1); });
