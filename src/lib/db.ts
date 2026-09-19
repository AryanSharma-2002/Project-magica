import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "./env";

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

function create(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getEnv().DATABASE_URL });
  return new PrismaClient({ adapter, log: getEnv().NODE_ENV === "development" ? ["warn", "error"] : ["error"] });
}

/** Singleton per process (Next.js dev reloads, Trigger.dev workers). */
export const prisma: PrismaClient = globalForPrisma.__prisma ?? create();
if (getEnv().NODE_ENV !== "production") globalForPrisma.__prisma = prisma;

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
