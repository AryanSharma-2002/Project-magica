# agent-chat-backend

Backend for the Agent Chat work trial: Next.js 16 route handlers (`/api/v1`), Prisma 7 + PostgreSQL, Trigger.dev v4 durable agent runs, OpenRouter Free (`openrouter/free`) agent loop with typed tools and on-demand skills, Magica media tools (crop_image, gpt_image_2, merge_videos), credits ledger, public REST API + webhooks, Mintlify docs.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** (canonical design, shared with the frontend repo) and **[PLAN.md](./PLAN.md)**.

## Setup

```bash
corepack enable pnpm            # pnpm 12
pnpm install
cp .env.example .env            # fill in credentials (see ARCHITECTURE.md §env)
pnpm db:deploy                  # prisma migrate deploy
pnpm db:generate
pnpm dev                        # API on http://localhost:3001
pnpm trigger:dev                # Trigger.dev dev worker (separate terminal)
pnpm test && pnpm typecheck && pnpm lint
```

Local Postgres: `createdb agent_chat agent_chat_test`. Tests run against `agent_chat_test`.

## Contracts

`packages/contracts` is the single source of truth for every request, response, content block, tool and realtime shape. The frontend vendors it (`pnpm contracts:sync` in the frontend repo) and never redefines types.

## Deploy

- API: Vercel (root of this repo). Set all variables from `.env.example`.
- Tasks: `pnpm trigger:deploy` (project ref in `trigger.config.ts` via `TRIGGER_PROJECT_REF`).
- Docs: `docs/` → Mintlify.
