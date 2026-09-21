# agent-chat-backend

Backend for the Agent Chat work trial: Next.js 16 route handlers (`/api/v1`), Prisma 7 + PostgreSQL, Trigger.dev v4 durable agent runs, OpenRouter Free (`openrouter/free`) agent loop with typed tools and on-demand skills, Magica media tools (crop_image, gpt_image_2, merge_videos), credits ledger, public REST API + webhooks, Mintlify docs.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** (canonical design, shared with the frontend repo) and **[PLAN.md](./PLAN.md)**.

## Setup

Full step-by-step guide for both repos, including accounts, env variables and the run order: **[RUNBOOK.md](./RUNBOOK.md)**.

```bash
corepack enable pnpm            # pnpm 12
pnpm install
cp .env.example .env            # fill in credentials (see ARCHITECTURE.md §env)
pnpm db:deploy                  # prisma migrate deploy
pnpm db:generate
pnpm dev                        # API on http://localhost:3001
pnpm trigger:dev                # Trigger.dev dev worker (separate terminal)
pnpm test && pnpm typecheck && pnpm lint
pnpm acceptance                 # live conversations, one per tool + chained (RUNBOOK.md §12); latest report: ACCEPTANCE.md
```

Local Postgres: `createdb agent_chat` and `createdb agent_chat_test`. Tests run against `agent_chat_test`.

## Contracts

`packages/contracts` is the single source of truth for every request, response, content block, tool and realtime shape. The frontend vendors it (`pnpm contracts:sync` in the frontend repo) and never redefines types.

## Deploy

- API: Vercel (root of this repo). Set all variables from `.env.example`.
- Tasks: `pnpm db:generate && pnpm trigger:deploy` (the generated Prisma client is gitignored; `agent-skills/` is bundled via `additionalFiles`; project ref via `TRIGGER_PROJECT_REF`).
- Docs: `docs/` → Mintlify.

## Architecture overview

See [ARCHITECTURE.md](./ARCHITECTURE.md). In one paragraph: a REST request validates, reserves a small refundable credit admission, persists the user turn and an assistant placeholder, and dispatches one durable Trigger.dev run (idempotent by key, one active run per chat enforced by a partial unique index). The run restores the session, streams an OpenRouter Free completion through a provider-neutral loop, loads skills on demand through typed loader tools, executes Magica tools as idempotent child tasks, pauses at human waitpoints with Trigger wait tokens, and checkpoints content blocks to PostgreSQL after every step. Realtime (run metadata + a typed text stream) is transport only; every fact is reconstructible from the database.

## Design decisions and trade-offs

- **Content blocks inside the assistant message, not separate tool messages.** One ordered JSONB array per turn keeps rendering, replay and persistence identical (block index is the shared key). Trade-off: a very long turn rewrites a larger row on each checkpoint; capped at 2,000 blocks.
- **Partial unique index for "one active run per chat"** instead of an application lock. The database arbitrates concurrent sends; the loser gets `run_active`. Stale runs are recovered lazily on the next send from the heartbeat, so there is no separate sweeper to operate.
- **Append-only credit ledger with deterministic idempotency keys** (`reserve:`, `release:`, `charge:` per invocation). Exactly-once settlement under retries without distributed transactions. Trade-off: two rows per settlement instead of one.
- **Cooperative cancellation** rather than killing the Trigger run, so the finalization path always runs and partial output is preserved.
- **Vendored contracts** in the frontend with a hash lock instead of a published package: zero install-time coupling on Vercel and for evaluators; one command to bump.
- **Integer microcredits as `BigInt`** in the database and `number` in contracts (safe below 2^53). Matches Magica's unit; avoids floating point.
- **Generic tool contract with declarative effects.** Tools return data plus effects (`asset`, `record_skill`); orchestration applies them. Adding a tool touches one file and the registry list.
- **DB token bucket for rate limiting** instead of Redis: one fewer service on a free stack; adequate for per-user limits at this scale.
- **Replay-from-zero for reload recovery** plus per-step checkpoints: least code, and the persisted partial content covers the realtime-unavailable case.

## What I'd improve with more time

- Publish contracts as a versioned package with semantic-version compatibility checks between deployed frontend and backend.
- Move the stale-run sweep to a scheduled task and add run-level metrics (queue latency, tokens/turn, tool p95) to a dashboard.
- Pre-compute credit estimates with Magica per (quality, size) tier and cache them; show live estimates in the composer before sending.
- Persist skill bodies per content hash so a retired skill version still resolves for old runs.
- Store generated assets in object storage (Cloudflare R2 via Transloadit `/s3/store`) by default rather than relying on provider URLs with expiry.
- Playwright coverage of reconnect, duplicate-submit and cancellation races against a seeded backend.
