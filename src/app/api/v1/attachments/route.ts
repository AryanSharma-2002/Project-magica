import { Attachment, ListAttachmentsQuery, Page } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { listAttachments } from "@/services/attachments";

export { OPTIONS } from "@/lib/http";
export const runtime = "nodejs";

export const GET = route({ auth: "clerk", query: ListAttachmentsQuery, response: Page(Attachment) }, async (ctx) =>
  listAttachments({ userId: ctx.principal.userId, query: ctx.query }),
);
