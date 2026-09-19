import { AppConfig } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { getConfig } from "@/services/config";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

export const GET = route({ auth: "any", response: AppConfig }, async () => getConfig());
