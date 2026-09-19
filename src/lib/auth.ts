import type { NextRequest } from "next/server";
import { errors } from "./errors";

/**
 * Principal resolution. Implemented in src/lib/auth/*.ts by the backend-core agent:
 *  - "clerk":  Authorization: Bearer <Clerk session JWT>  -> verifyToken (@clerk/backend) -> upsert User + signup grant
 *  - "apiKey": Authorization: Bearer ak_live_...           -> sha256 lookup in ApiKey
 *  - "any":    either of the above
 *  - "none":   public endpoints (health, config)
 */
export type AuthMode = "clerk" | "apiKey" | "any" | "none";

export type Principal =
  | { kind: "user"; userId: string; clerkUserId: string }
  | { kind: "apiKey"; userId: string; apiKeyId: string }
  | { kind: "anonymous"; userId: "" };

export type Authenticator = (req: NextRequest, mode: AuthMode) => Promise<Principal>;

let impl: Authenticator | undefined;

/** Wired at module init by src/lib/auth/index.ts (kept indirect so route tests can stub it). */
export function setAuthenticator(fn: Authenticator): void {
  impl = fn;
}

export async function authenticate(req: NextRequest, mode: AuthMode): Promise<Principal> {
  if (mode === "none") return { kind: "anonymous", userId: "" };
  if (!impl) {
    // Lazy import avoids a cycle: http.ts -> auth.ts -> auth/index.ts -> db.ts
    const mod = await import("./auth/index");
    impl = mod.authenticator;
  }
  const p = await impl(req, mode);
  if (p.kind === "anonymous") throw errors.unauthorized();
  return p;
}
