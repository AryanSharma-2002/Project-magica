import { z } from "zod";

/**
 * All secrets/config enter through here. Parsed lazily so `next build` does not need secrets,
 * but every request/task fails loudly on first access if something is missing.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
  PUBLIC_API_BASE_URL: z.string().url().default("http://localhost:3001"),

  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  /** Optional PEM for networkless JWT verification. */
  CLERK_JWT_KEY: z.string().optional(),

  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  /** Only the free router is allowed. Any other value is rejected here, at the boundary. */
  OPENROUTER_MODEL: z.literal("openrouter/free").default("openrouter/free"),

  MAGICA_API_KEY: z.string().min(1),
  MAGICA_BASE_URL: z.string().url().default("https://inference.magica.com"),
  MAGICA_WEBHOOK_SECRET: z.string().optional(),

  TRIGGER_SECRET_KEY: z.string().min(1),
  TRIGGER_PROJECT_REF: z.string().optional(),

  TRANSLOADIT_KEY: z.string().min(1),
  TRANSLOADIT_SECRET: z.string().min(1),
  TRANSLOADIT_TEMPLATE_ID: z.string().optional(),
  /** Name of Transloadit "Template Credentials" for /s3/store (e.g. Cloudflare R2). Unset => temp URLs with expiry. */
  TRANSLOADIT_STORE_CREDENTIALS: z.string().optional(),

  SIGNUP_GRANT_MICROCREDITS: z.coerce.number().int().nonnegative().default(100_000_000),
  ADMISSION_MICROCREDITS: z.coerce.number().int().nonnegative().default(10_000),
  APPROVAL_THRESHOLD_MICROCREDITS: z.coerce.number().int().nonnegative().default(50_000),

  /** HMAC secret for outbound webhook signatures when an endpoint has none. */
  WEBHOOK_SIGNING_SECRET: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
});
export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: replace env (vitest setup). */
export function __setEnvForTests(overrides: Partial<Env>): void {
  cached = EnvSchema.parse({ ...process.env, ...overrides });
}
