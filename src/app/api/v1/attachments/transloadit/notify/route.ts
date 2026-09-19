import { z } from "zod";
import { route } from "@/lib/http";
import { errors } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { verifySignature } from "@/lib/transloadit/signature";
import { applyNotification } from "@/services/attachments";

export { OPTIONS } from "@/lib/http";
export const runtime = "nodejs";

const AckResponse = z.object({ ok: z.literal(true) });

/**
 * Transloadit's notify_url. Auth is the HMAC signature, not Clerk/apiKey - no `body` schema is
 * given to route() so it never calls req.text() for us; the body is read here as multipart/
 * urlencoded form data instead (Transloadit's docs describe multipart/form-data; `formData()`
 * also parses application/x-www-form-urlencoded, so either is accepted - see the final report).
 */
export const POST = route({ auth: "none", response: AckResponse }, async (ctx) => {
  const form = await ctx.req.formData();
  const raw = form.get("transloadit");
  const signatureHeader = form.get("signature");
  if (typeof raw !== "string" || typeof signatureHeader !== "string") {
    throw errors.validation("Missing Transloadit notification fields");
  }
  if (!verifySignature(raw, signatureHeader, getEnv().TRANSLOADIT_SECRET)) {
    throw errors.forbidden();
  }
  await applyNotification(raw);
  return { ok: true as const };
});
