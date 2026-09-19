import { z } from "zod";
import { route } from "@/lib/http";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

const HealthResponse = z.object({ ok: z.literal(true), service: z.literal("agent-chat-backend"), time: z.string() });

export const GET = route({ auth: "none", response: HealthResponse }, async () => ({
  ok: true as const,
  service: "agent-chat-backend" as const,
  time: new Date().toISOString(),
}));
