import { z } from "zod";
import { AttachmentUploadedRequest } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { markUploaded } from "@/services/attachments";

export { OPTIONS } from "@/lib/http";
export const runtime = "nodejs";

const AckResponse = z.object({ ok: z.literal(true) });

export const POST = route({ auth: "clerk", body: AttachmentUploadedRequest, response: AckResponse }, async (ctx) => {
  await markUploaded({ userId: ctx.principal.userId, body: ctx.body });
  return { ok: true as const };
});
