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

Live deployment (2026-09-21): API `https://agent-chat-backend-tan.vercel.app`, Vercel team `aryan-325d`, projects `agent-chat-backend` and `agent-chat-frontend`, Trigger.dev project `Test` (prod environment).

Order matters: database, then Trigger tasks, then the API, then the frontend, then the API again with the frontend origin.

```bash
npx vercel login                                         # GitHub account that owns the repos
npx vercel link --yes --project agent-chat-backend       # in this repo; .vercel/ is gitignored
npx vercel integration add neon -n agent-chat-db         # managed Postgres; accept the marketplace terms once in the browser
npx vercel env pull .env.production.local                # gets DATABASE_URL from the integration
printf '%s' "$VALUE" | npx vercel env add NAME production --force   # every variable from .env.example
printf '%s' 1 | npx vercel env add ENABLE_EXPERIMENTAL_COREPACK production --force   # pnpm 12 via corepack
DATABASE_URL=<neon url> pnpm db:deploy                   # migrations against the hosted database
pnpm exec trigger env set --env prod NAME VALUE          # same variables for the tasks (TRIGGER_SECRET_KEY is injected by the platform)
pnpm db:generate && pnpm trigger:deploy                  # tasks; agent-skills/ ships through additionalFiles
npx vercel deploy --prod --yes                           # API; vercel.json pins the Next.js preset, build runs prisma generate first
```

Frontend (in `../agent-chat-frontend`): `npx vercel link --yes --project agent-chat-frontend`, set `NEXT_PUBLIC_API_URL` (the API alias above), the Clerk keys, `NEXT_PUBLIC_CLERK_SIGN_IN_URL`/`SIGN_UP_URL`, `NEXT_PUBLIC_TRIGGER_API_URL`, `ENABLE_EXPERIMENTAL_COREPACK=1`, then `npx vercel deploy --prod --yes`. Then set the backend's `FRONTEND_ORIGIN` to the frontend alias and redeploy the API (env changes need a redeploy). The backend's `TRIGGER_SECRET_KEY` on Vercel must be the **prod** key from the Trigger dashboard, not the dev one.

Docs: `OPENAPI_BASE_URL=https://agent-chat-backend-tan.vercel.app pnpm docs:openapi`, then `docs/` to Mintlify.

## 10. Not wired yet

- `pnpm test:e2e` (frontend): no Playwright config exists; `e2e/README.md` holds the plan only.
- Transloadit Community (free) plan: uploads are re-encoded and watermarked with a "Created with Transloadit" badge, even the `:original` files (verified 2026-09-21: a 1024x768 PNG came back palettised with the badge top-left). Every uploaded image the chat shows or hands to a Magica tool carries it until the account is on a paid plan or uploads bypass Transloadit.
- Transloadit `notify_url` on localhost: Transloadit cannot call `http://localhost:3001/...`, so a file uploaded through the browser stays `processing` locally. Either expose the API (for example `cloudflared tunnel --url http://localhost:3001`, then set `PUBLIC_API_BASE_URL` to the tunnel URL and restart) or use `pnpm acceptance`, which replays the signed Assembly Status to the notify route itself (section 12).

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid environment: X` at startup or in a task | `X` is missing or empty in `.env` |
| Frontend build fails at the environment step | set `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` |
| `prisma migrate dev` hangs | use `pnpm db:deploy` |
| Trigger CLI says you are not logged in | `pnpm exec trigger login` |
| `next dev` rewrites `AGENTS.md` | expected; Next 16 appends its agent block. Commit it once or set `agentRules: false` in `next.config.ts` |
| Upload chip stays "processing" forever | the Transloadit notification never reached the API (localhost, see section 10). The Assembly in the Transloadit dashboard shows `notify_status: error` |
| Every run fails with `provider_unavailable` "The model provider is rate limiting requests" | OpenRouter free tier: **50 requests per day** per account without credits (`free-models-per-day`, resets at 00:00 UTC). A full `pnpm acceptance` run uses roughly 30. Adding 10 USD of credits to the OpenRouter account raises the free-model limit to 1,000 per day without changing `OPENROUTER_MODEL` |
| A turn with an image attachment fails immediately with `provider_error` (400) and no `routedModel` | `openrouter/free` routed a multimodal message to a text-only model. Send again (a different model is routed); the attachment URLs are also in the system prompt as text, so a retry without image parts would be a safe fallback (not implemented) |
| A Magica tool fails with `malformed_tool_call` right after approval | fixed 2026-09-21: an optional media array defaulted to `[]` by the catalog was rejected on re-validation. If it recurs, compare `ToolInvocation.input` with the tool's live input schema |
| Port 3001 or 3000 already in use | `lsof -ti :3001 \| xargs kill` (same for 3000) |
| CORS error in the browser | `FRONTEND_ORIGIN` in the backend must equal the frontend origin exactly |

## 12. Live acceptance conversations

`pnpm acceptance` (scripts/acceptance.ts) drives one conversation per tool plus a chained one against the running local stack (sections 6 and 7 must be up), using the real credentials from `.env`:

| Scenario | What it proves |
|---|---|
| `text` | a plain turn completes with no tool calls |
| `skill` | `load_skill` runs and the skill is recorded on the run |
| `crop` | a real Transloadit upload becomes READY, then `crop_image` runs on it and the reply carries an asset block |
| `merge` | two uploaded clips go through `merge_videos` |
| `gen` | `gpt_image_2` text-to-image, including the approval waitpoint above the credit threshold |
| `chain` | `gpt_image_2` followed by `crop_image` on the generated URL, in one turn |
| `deny` | a denied approval cancels the invocation and the run still completes |
| `apikey` | a Clerk session mints an API key; the key drives `POST /completions` and is rejected once revoked; a key cannot mint keys |
| `tool_api` | `POST /tools/crop_image/run` on an uploaded image completes and settles credits; non-Magica tools and malformed input are rejected |
| `webhook` | a local receiver registered through `POST /webhooks` gets signed `agent.started` and `agent.completed` deliveries (the dev worker can reach `127.0.0.1`; a link-local endpoint is rejected) |

```bash
pnpm acceptance                                  # all scenarios, report on stdout
pnpm acceptance --only crop,merge --attempts 3   # subset; retries only model-quality failures
pnpm acceptance --out ACCEPTANCE.md              # markdown report plus ACCEPTANCE.json
pnpm acceptance --only apikey,tool_api,webhook   # public API + webhooks only (cheap: one crop)
pnpm acceptance --only deny --out ACCEPTANCE.md --append   # re-run failed scenarios and merge them into the existing report
```

OpenRouter's free tier allows 50 requests per day without credits; a full run needs about 30, so at most one full run per day fits (see section 11).  (`CLERK_SECRET_KEY`) for `ACCEPTANCE_CLERK_USER_ID`, or the most recently signed-in user. Fixture media is generated with ffmpeg on first use. It spends real Magica credits: about 5,000 µc per crop and up to a few hundred thousand µc per generated image. `openrouter/free` routes to a different model on every run, so a scenario can fail because the model ignored the instruction; such failures are retried once in a fresh chat, and every attempt is listed in the report with its routed model.
