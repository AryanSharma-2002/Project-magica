import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "./env";

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient | undefined };

function create(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getEnv().DATABASE_URL });
  return new PrismaClient({ adapter, log: getEnv().NODE_ENV === "development" ? ["warn", "error"] : ["error"] });
}

/**
 * Lazy singleton per process (Next.js dev reloads, Trigger.dev workers).
 * Lazy so `next build` can import route modules without DATABASE_URL.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (!globalForPrisma.__prisma) globalForPrisma.__prisma = create();
    return Reflect.get(globalForPrisma.__prisma, prop, receiver);
  },
});

/** Test-only: swap the underlying client (e.g. per-worker database). */
export function __setPrismaForTests(client: PrismaClient | undefined): void {
  globalForPrisma.__prisma = client;
}

export type Db = PrismaClient | Prisma.TransactionClient;
export { Prisma };

/** Postgres unique-violation helper (P2002). `target` may be an index name for raw constraints. */
export function isUniqueViolation(err: unknown, target?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  if (!target) return true;
  const meta = err.meta as { target?: string | string[] } | undefined;
  const t = meta?.target;
  return Array.isArray(t) ? t.includes(target) : typeof t === "string" ? t.includes(target) : false;
}

/** Serialize BigInt microcredits for contracts (safe: balances are far below 2^53). */
export function mc(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}
