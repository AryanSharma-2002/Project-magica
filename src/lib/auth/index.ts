import type { Authenticator } from "../auth";

/** Placeholder until backend-core agent implements Clerk JWT + API key resolution. */
export const authenticator: Authenticator = async () => {
  throw new Error("authenticator not implemented");
};
