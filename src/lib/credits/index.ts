import type { CreditPort } from "@/agent/loop/ports";

/**
 * Credit ledger (backend-core slice). Exposes CreditPort for the loop plus admission helpers for the send route:
 *   grantSignup(userId), reserveAdmission({userId, runId, microcredits}), releaseAdmission({userId, runId}), balance(userId), listLedger(...)
 */
export function createCreditPort(): CreditPort {
  throw new Error("createCreditPort not implemented");
}
