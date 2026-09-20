# Runbook: running Agent Chat locally

Covers both repositories: **agent-chat-backend** (this repo: API, database, Trigger.dev tasks) and **agent-chat-frontend** (sibling folder `../agent-chat-frontend`). Every command below runs from the root of the repo named in its heading. No secrets live in this file; variables are listed in each repo's `.env.example`.

## 1. Prerequisites

- Node 22 or newer and pnpm 12: `corepack enable pnpm`
- PostgreSQL 14 or newer running on `localhost:5432`
- Free-tier accounts: Clerk, Trigger.dev, OpenRouter, Transloadit, Magica
- GitHub CLI (`gh`) only if you push the repos

## 2. Databases (once)

```bash
createdb agent_chat
createdb agent_chat_test
```

## 3. Environment files

```bash
# backend
cp .env.example .env
# frontend
cd ../agent-chat-frontend && cp .env.example .env.local
```

Where each value comes from:

| Variable | Repo | Source |
|---|---|---|
| `DATABASE_URL` | backend | `postgresql://<user>@localhost:5432/agent_chat` |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | backend | Clerk dashboard, your application, Configure, API keys |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | frontend | same Clerk instance as the backend |
| `OPENROUTER_API_KEY` | backend | openrouter.ai, workspace, API Keys, New Key. `OPENROUTER_MODEL` must stay `openrouter/free`; the env schema rejects anything else |
| `MAGICA_API_KEY` | backend | magica.com, Settings (bottom of the left sidebar), API Keys, Manage, Create key. Requires an email code; the key is shown once |
| `TRIGGER_SECRET_KEY` | backend | cloud.trigger.dev, your project, Development environment, API keys, New API key (`tr_dev_...`) |
| `TRIGGER_PROJECT_REF` | backend | Trigger.dev project settings, Project ref (`proj_...`) |
| `TRANSLOADIT_KEY`, `TRANSLOADIT_SECRET` | backend | transloadit.com, workspace, Credentials, New Auth Key. Choose SHA-384 and the scopes `assemblies:read`, `assemblies:write`, `assembly_notifications:write`. The key auto-created during onboarding cannot reveal its secret, so create a new one; the secret is shown once |
| `NEXT_PUBLIC_API_URL` | frontend | `http://localhost:3001` locally |
| `FRONTEND_ORIGIN` | backend | `http://localhost:3000` locally; must equal the frontend origin (CORS) |

Both env files are gitignored. Keep them readable by your user only: `chmod 600 .env`.

## 4. One-time interactive logins

```bash
# backend: device auth in the browser; required before trigger:dev and trigger:deploy
pnpm exec trigger login

# only if you push the repositories
gh auth login
```

## 5. Backend: first run

```bash
pnpm install
pnpm db:generate     # Prisma client; there is no postinstall hook, so run this before dev, test or typecheck
pnpm db:deploy       # applies prisma/migrations to DATABASE_URL
DATABASE_URL="postgresql://<user>@localhost:5432/agent_chat_test" pnpm db:deploy   # same for the test database
```

`pnpm db:migrate` runs `prisma migrate dev`, which is interactive. Use it only when authoring a new migration.

## 6. Run everything locally (three terminals)

Terminal 1, backend API:

```bash
pnpm dev                                        # http://localhost:3001
curl -i http://localhost:3001/api/v1/config     # 401 "Authentication required" means boot and env are fine
```

Terminal 2, Trigger.dev dev worker:

```bash
pnpm trigger:dev                                # reads .env; the Trigger dashboard flips to "Dev server connected"
pnpm exec trigger dev -p <proj_ref>             # fallback if the CLI cannot resolve the project ref from .env
```

Terminal 3, frontend:

```bash
cd ../agent-chat-frontend
pnpm install
pnpm contracts:sync ../agent-chat-backend       # vendors packages/contracts/src into src/contracts, pins contracts.lock.json
pnpm contracts:check                            # verifies the vendored copy matches the lock
pnpm dev                                        # http://localhost:3000
```

Dev and build both stop at the environment check if `NEXT_PUBLIC_API_URL` or `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is missing. Sign in through Clerk, then start a conversation; the run should appear under Runs in the Trigger dashboard.

Re-run `pnpm contracts:sync ../agent-chat-backend` in the frontend after any change under `packages/contracts` in the backend.

## 7. Check chain (run in both repos before committing)

Backend:

```bash
pnpm typecheck && pnpm lint && pnpm test
TEST_DATABASE_URL="postgresql://<user>@localhost:5432/agent_chat_test" pnpm test   # DB tests default to agent_chat_test
pnpm test:watch
```

Frontend:

```bash
pnpm typecheck && pnpm lint && pnpm test        # typecheck runs `next typegen` first
pnpm test:watch
```

## 8. API docs

```bash
pnpm docs:openapi     # regenerates docs/openapi.json from the Zod contracts; lists only implemented routes
pnpm docs:dev         # runs `mintlify dev` inside docs/; needs the Mintlify CLI installed globally
```

## 9. Deploy

- Backend API: Vercel, root of this repo, every variable from `.env.example` set in the project.
- Tasks: `pnpm db:generate && pnpm trigger:deploy` (the generated Prisma client is gitignored; `agent-skills/` is bundled through `additionalFiles`).
- Frontend: Vercel with `NEXT_PUBLIC_API_URL` and the Clerk keys. Set the backend's `FRONTEND_ORIGIN` to the deployed frontend URL.
- Docs: `docs/` to Mintlify.

## 10. Not wired yet

- `pnpm test:e2e` (frontend): no Playwright config exists; `e2e/README.md` holds the plan only.
- Public API routes and outbound webhooks: schema and doc stubs only.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid environment: X` at startup or in a task | `X` is missing or empty in `.env` |
| Frontend build fails at the environment step | set `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` |
| `prisma migrate dev` hangs | use `pnpm db:deploy` |
| Trigger CLI says you are not logged in | `pnpm exec trigger login` |
| `next dev` rewrites `AGENTS.md` | expected; Next 16 appends its agent block. Commit it once or set `agentRules: false` in `next.config.ts` |
| Port 3001 or 3000 already in use | `lsof -ti :3001 \| xargs kill` (same for 3000) |
| CORS error in the browser | `FRONTEND_ORIGIN` in the backend must equal the frontend origin exactly |
