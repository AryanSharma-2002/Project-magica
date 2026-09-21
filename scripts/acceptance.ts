/**
 * Live acceptance conversations (PLAN.md Phase 2) against a RUNNING local stack:
 * backend API on PUBLIC_API_BASE_URL (default http://localhost:3001), the Trigger.dev dev worker,
 * and the real Clerk / OpenRouter / Magica / Transloadit credentials from `.env`.
 *
 *   pnpm acceptance                                   # all scenarios
 *   pnpm acceptance --only crop,merge --attempts 3    # subset, more retries
 *   pnpm acceptance --out ACCEPTANCE.md               # markdown + JSON sidecar
 *   pnpm acceptance --only deny --out ACCEPTANCE.md --append   # re-run some scenarios and merge them into the existing report
 *   pnpm acceptance ... --note "OpenRouter daily cap hit at 08:12 UTC"   # free-text line kept in the report header
 *
 * Auth: a Clerk session JWT is minted through the Clerk Backend API (CLERK_SECRET_KEY) for
 * ACCEPTANCE_CLERK_USER_ID, or the most recently signed-in user of the instance. One fresh JWT per
 * scenario, since a Magica job plus an approval can take minutes.
 *
 * Uploads use a REAL Transloadit Assembly (signed params from POST /attachments/assembly). Transloadit
 * cannot reach a localhost `notify_url`, so once the Assembly completes the script replays its final
 * Assembly Status to our own notify route with a valid HMAC - byte for byte what Transloadit would
 * have delivered. Nothing about the backend is bypassed.
 *
 * Fixture media (a 1024x768 PNG, two 2-second MP4 clips) is generated with ffmpeg when missing.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type {
  Attachment,
  ContentBlock,
  CreateAssemblyResponse,
  GetRunResponse,
  Message,
  Page,
  RunStatus,
  SendMessageResponse,
  ToolInvocation,
  ToolInvocationStatus,
  Waitpoint,
  WaitpointResolution,
  WebhookEvent,
} from "@agent-chat/contracts";

// ---------------------------------------------------------------------------
// env / args / logging
// ---------------------------------------------------------------------------

function loadDotenv(file = path.resolve(process.cwd(), ".env")): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} (set it in .env or the environment)`);
  return v;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function log(line: string): void {
  console.log(`${stamp()} ${line}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Clerk (Backend API) - mint a session JWT for API calls
// ---------------------------------------------------------------------------

async function clerk<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.clerk.com/v1${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${need("CLERK_SECRET_KEY")}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) throw new Error(`Clerk ${pathname} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

async function mintJwt(): Promise<{ jwt: string; clerkUserId: string }> {
  let clerkUserId = process.env.ACCEPTANCE_CLERK_USER_ID;
  if (!clerkUserId) {
    const users = await clerk<Array<{ id: string }>>("/users?limit=1&order_by=-last_sign_in_at");
    clerkUserId = users[0]?.id;
    if (!clerkUserId) throw new Error("The Clerk instance has no users; sign in once through the frontend first");
  }
  const session = await clerk<{ id: string }>("/sessions", { method: "POST", body: JSON.stringify({ user_id: clerkUserId }) });
  const token = await clerk<{ jwt: string }>(`/sessions/${session.id}/tokens`, { method: "POST", body: JSON.stringify({ expires_in_seconds: 3600 }) });
  return { jwt: token.jwt, clerkUserId };
}

// ---------------------------------------------------------------------------
// Backend API client
// ---------------------------------------------------------------------------

class Api {
  constructor(
    readonly base: string,
    private readonly jwt: string,
  ) {}

  async call<T>(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${this.base}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${this.jwt}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

// ---------------------------------------------------------------------------
// Fixture media
// ---------------------------------------------------------------------------

type MediaFile = { file: string; filename: string; mimeType: string };

function ensureMedia(dir: string): { image: MediaFile; clips: MediaFile[] } {
  mkdirSync(dir, { recursive: true });
  const image = path.join(dir, "acceptance-image.png");
  const red = path.join(dir, "acceptance-clip-red.mp4");
  const blue = path.join(dir, "acceptance-clip-blue.mp4");
  const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  const clip = (color: string, hz: number, out: string) =>
    ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:size=640x360:rate=25`, "-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=44100`, "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", out]);
  if (!existsSync(image)) ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1024x768:rate=1", "-frames:v", "1", image]);
  if (!existsSync(red)) clip("red", 440, red);
  if (!existsSync(blue)) clip("blue", 880, blue);
  return {
    image: { file: image, filename: path.basename(image), mimeType: "image/png" },
    clips: [
      { file: red, filename: path.basename(red), mimeType: "video/mp4" },
      { file: blue, filename: path.basename(blue), mimeType: "video/mp4" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Upload through Transloadit + notify replay
// ---------------------------------------------------------------------------

type AssemblyStatus = { ok?: string; error?: string; message?: string; assembly_id: string; assembly_ssl_url: string };

async function uploadFiles(api: Api, chatId: string | undefined, files: MediaFile[]): Promise<Attachment[]> {
  const metas = files.map((f, i) => ({ clientId: `acc-${i}-${randomUUID().slice(0, 8)}`, filename: f.filename, mimeType: f.mimeType, sizeBytes: statSync(f.file).size, position: i }));
  const created = await api.call<CreateAssemblyResponse>("POST", "/attachments/assembly", { ...(chatId ? { chatId } : {}), files: metas });
  log(`  assembly params signed; ${created.attachments.length} attachment row(s) pre-created`);

  const form = new FormData();
  form.set("params", created.assemblyOptions.params);
  form.set("signature", created.assemblyOptions.signature);
  files.forEach((f, i) => form.append(`file_${i}`, new Blob([readFileSync(f.file)], { type: f.mimeType }), f.filename));
  const createRes = await fetch("https://api2.transloadit.com/assemblies", { method: "POST", body: form });
  const assembly = (await createRes.json()) as AssemblyStatus;
  if (!createRes.ok || assembly.error) throw new Error(`Transloadit assembly creation failed: ${createRes.status} ${assembly.error ?? ""} ${assembly.message ?? ""}`);
  log(`  transloadit assembly ${assembly.assembly_id} ${assembly.ok ?? ""}`);

  await api.call("POST", "/attachments/uploaded", { assemblyId: assembly.assembly_id, files: created.attachments.map((a) => ({ attachmentId: a.id })) });

  let status = assembly;
  const deadline = Date.now() + 180_000;
  while (status.ok !== "ASSEMBLY_COMPLETED") {
    if (status.error) throw new Error(`Transloadit assembly failed: ${status.error} ${status.message ?? ""}`);
    if (Date.now() > deadline) throw new Error("Transloadit assembly did not complete within 3 minutes");
    await sleep(2_000);
    status = (await (await fetch(assembly.assembly_ssl_url)).json()) as AssemblyStatus;
  }

  // Transloadit cannot reach a localhost notify_url: replay the final status ourselves, signed the
  // way Transloadit signs notifications (sha1 HMAC over the exact `transloadit` field string).
  const raw = JSON.stringify(status);
  const signature = `sha1:${createHmac("sha1", need("TRANSLOADIT_SECRET")).update(raw, "utf8").digest("hex")}`;
  const notify = await fetch(`${api.base}/attachments/transloadit/notify`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transloadit: raw, signature }),
  });
  if (!notify.ok) throw new Error(`notify replay -> ${notify.status} ${(await notify.text()).slice(0, 300)}`);

  const ids = new Set(created.attachments.map((a) => a.id));
  for (let i = 0; i < 15; i++) {
    const page = await api.call<Page<Attachment>>("GET", "/attachments?limit=50&source=upload");
    const rows = page.items.filter((a) => ids.has(a.id));
    if (rows.some((a) => a.status === "failed" || a.status === "expired")) throw new Error(`attachment processing failed: ${JSON.stringify(rows.map((a) => [a.id, a.status]))}`);
    if (rows.length === ids.size && rows.every((a) => a.status === "ready")) {
      log(`  ${rows.length} attachment(s) READY`);
      return rows.sort((a, b) => a.position - b.position);
    }
    await sleep(1_000);
  }
  throw new Error("attachments never reached READY after the notify replay");
}

// ---------------------------------------------------------------------------
// Send a message, drive waitpoints, wait for a terminal run
// ---------------------------------------------------------------------------

type WaitEvent = { waitpointId: string; type: string; action: "approved" | "denied"; microcreditsEstimated: number | null; at: string };

type TurnResult = {
  send: SendMessageResponse;
  run: GetRunResponse;
  assistant: Message | undefined;
  waits: WaitEvent[];
  realtimeSeen: boolean;
  elapsedMs: number;
  cancelledByScript: boolean;
};

function resolutionFor(wp: Waitpoint, approve: boolean): WaitpointResolution {
  switch (wp.type) {
    case "approval":
      return { type: "approval", approved: approve };
    case "plan":
      return { type: "plan", approved: approve };
    case "credit":
      return { type: "credit", proceed: approve };
    case "options": {
      const options = (wp.prompt as { options?: Array<{ id: string }> }).options ?? [];
      return { type: "options", selected: [options[0]?.id ?? "unknown"] };
    }
  }
}

function estimatedOf(wp: Waitpoint): number | null {
  const v = (wp.prompt as { microcreditsEstimated?: unknown }).microcreditsEstimated;
  return typeof v === "number" ? v : null;
}

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "failed", "cancelled"]);

async function sendAndWait(api: Api, chatId: string, text: string, attachmentIds: string[], opts: { approve: boolean; maxDenials: number; timeoutMs: number }): Promise<TurnResult> {
  const started = Date.now();
  const send = await api.call<SendMessageResponse>("POST", `/chats/${chatId}/messages`, { text, attachmentIds }, { "idempotency-key": `acceptance-${randomUUID()}` });
  log(`  run ${send.runId} dispatched (trigger ${send.realtime.triggerRunId})`);

  const waits: WaitEvent[] = [];
  const handled = new Set<string>();
  let realtimeSeen = false;
  let cancelledByScript = false;
  let lastStatus = "";
  let run: GetRunResponse;
  for (;;) {
    run = await api.call<GetRunResponse>("GET", `/runs/${send.runId}`);
    if (run.realtime) realtimeSeen = true;
    if (run.status !== lastStatus) {
      log(`  status ${run.status}${run.routedModel ? ` (model ${run.routedModel})` : ""}`);
      lastStatus = run.status;
    }
    const wp = run.waitpoint;
    if (wp && wp.status === "pending" && !handled.has(wp.id)) {
      handled.add(wp.id);
      const denials = waits.filter((w) => w.action === "denied").length;
      if (!opts.approve && denials >= opts.maxDenials) {
        log(`  ${denials} denial(s) already issued and the model asked again; cancelling the run`);
        await api.call("POST", `/runs/${send.runId}/cancel`);
        cancelledByScript = true;
      } else {
        await api.call<Waitpoint>("POST", `/waitpoints/${wp.id}/complete`, { resolution: resolutionFor(wp, opts.approve) });
        const event: WaitEvent = { waitpointId: wp.id, type: wp.type, action: opts.approve ? "approved" : "denied", microcreditsEstimated: estimatedOf(wp), at: new Date().toISOString() };
        waits.push(event);
        log(`  waitpoint ${wp.type} ${event.action}${event.microcreditsEstimated !== null ? ` (estimate ${event.microcreditsEstimated} µc)` : ""}`);
      }
    }
    if (TERMINAL.has(run.status)) break;
    if (Date.now() - started > opts.timeoutMs) {
      log(`  timeout after ${Math.round(opts.timeoutMs / 1000)}s; cancelling`);
      await api.call("POST", `/runs/${send.runId}/cancel`).catch(() => undefined);
      cancelledByScript = true;
      await sleep(3_000);
      run = await api.call<GetRunResponse>("GET", `/runs/${send.runId}`);
      break;
    }
    await sleep(2_000);
  }

  const page = await api.call<Page<Message>>("GET", `/chats/${chatId}/messages?limit=10`);
  const assistant = page.items.find((m) => m.id === send.assistantMessageId);
  return { send, run, assistant, waits, realtimeSeen, elapsedMs: Date.now() - started, cancelledByScript };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type Scenario = {
  key: string;
  title: string;
  prompt: string;
  expectTools: string[];
  expectToolStatus?: ToolInvocationStatus;
  expectRunStatus?: RunStatus;
  approve?: boolean;
  /** The scenario must have driven at least one waitpoint of this type (approved or denied per `approve`). */
  expectWaitpoint?: Waitpoint["type"];
  needs?: "image" | "clips";
  timeoutMs?: number;
};

// quality "High" on purpose: its estimate (~274,000 µc live) is above the 50,000 µc approval threshold,
// so `gen` and `deny` exercise the approval waitpoint. `chain` uses "Low" (~8,000 µc, no approval).
const GEN_PROMPT =
  'Use the gpt_image_2 tool exactly once to generate an image with prompt "a solid red square centered on a white background", size "1024x1024", quality "High", n 1. Do not pass image_urls. When the tool returns, reply with one short sentence.';

const SCENARIOS: Scenario[] = [
  { key: "text", title: "Plain text turn, no tools", prompt: "Reply with exactly one word: pong", expectTools: [], timeoutMs: 3 * 60_000 },
  {
    key: "skill",
    title: "Skill loading (load_skill)",
    prompt: 'Call the load_skill tool with name "image-cropping". Then summarize its rules in two sentences. Do not call any other tool.',
    expectTools: ["load_skill"],
    timeoutMs: 4 * 60_000,
  },
  {
    key: "crop",
    title: "crop_image on an uploaded image",
    needs: "image",
    prompt:
      "Use the crop_image tool on the attached image (its URL is listed in your instructions) with x_percent 25, y_percent 25, width_percent 50, height_percent 50, which is the centre of the image. When the tool returns, reply with one short sentence.",
    expectTools: ["crop_image"],
    timeoutMs: 8 * 60_000,
  },
  {
    key: "merge",
    title: "merge_videos on two uploaded clips",
    needs: "clips",
    prompt:
      'Use the merge_videos tool to concatenate the two attached videos in the order they are listed in your instructions, with transition "none". When the tool returns, reply with one short sentence.',
    expectTools: ["merge_videos"],
    timeoutMs: 12 * 60_000,
  },
  { key: "gen", title: "gpt_image_2 text-to-image (approval flow)", prompt: GEN_PROMPT, expectTools: ["gpt_image_2"], expectWaitpoint: "approval", timeoutMs: 12 * 60_000 },
  {
    key: "chain",
    title: "Chained: gpt_image_2 then crop_image",
    prompt:
      'Do two steps in order. Step 1: call gpt_image_2 with prompt "a blue circle on a white background", size "1024x1024", quality "Low", n 1 (no image_urls). Step 2: call crop_image on the image URL that step 1 returned, with x_percent 0, y_percent 0, width_percent 50, height_percent 100. Then reply with one short sentence.',
    expectTools: ["gpt_image_2", "crop_image"],
    timeoutMs: 15 * 60_000,
  },
  {
    key: "deny",
    title: "Approval denied (gpt_image_2 is cancelled, run still completes)",
    prompt: GEN_PROMPT,
    expectTools: ["gpt_image_2"],
    expectToolStatus: "cancelled",
    expectWaitpoint: "approval",
    approve: false,
    timeoutMs: 8 * 60_000,
  },
];

// ---------------------------------------------------------------------------
// Public API scenarios (API keys, /completions, standalone tool runs, webhooks)
// ---------------------------------------------------------------------------

export const PUBLIC_SCENARIO_KEYS = ["apikey", "tool_api", "webhook"] as const;
type PublicScenarioKey = (typeof PUBLIC_SCENARIO_KEYS)[number];

const PUBLIC_TITLES: Record<PublicScenarioKey, string> = {
  apikey: "Public API: mint a key, POST /completions, list, revoke",
  tool_api: "Public API: standalone crop_image run on an uploaded image",
  webhook: "Webhooks: local receiver gets signed agent.started/agent.completed",
};

async function mintApiKey(clerkApi: Api, name: string): Promise<{ id: string; key: string; prefix: string }> {
  const created = await clerkApi.call<{ id: string; key?: string; prefix: string }>("POST", "/api-keys", { name });
  if (!created.key) throw new Error("POST /api-keys returned no plaintext key");
  return { id: created.id, key: created.key, prefix: created.prefix };
}

async function waitForTerminalRun(api: Api, runId: string, timeoutMs: number): Promise<GetRunResponse> {
  const started = Date.now();
  let last = "";
  for (;;) {
    const run = await api.call<GetRunResponse>("GET", `/runs/${runId}`);
    if (run.status !== last) {
      log(`  status ${run.status}${run.routedModel ? ` (model ${run.routedModel})` : ""}`);
      last = run.status;
    }
    if (TERMINAL.has(run.status)) return run;
    if (Date.now() - started > timeoutMs) throw new Error(`run ${runId} did not finish within ${Math.round(timeoutMs / 1000)}s`);
    await sleep(2_000);
  }
}

/** Mirrors docs/webhooks.mdx: v1 = HMAC_SHA256(secret, `${t}.${rawBody}`), 300 s tolerance, constant-time compare. */
function verifyWebhookSignature(secret: string, rawBody: string, header: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > 300 || !parts.v1) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return expected.length === parts.v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

function baseRecord(overrides: Partial<AttemptRecord> & Pick<AttemptRecord, "scenario" | "title">): AttemptRecord {
  return {
    attempt: 1,
    chatId: "-",
    runId: "-",
    triggerRunId: "-",
    routedModel: null,
    runStatus: "-",
    runError: null,
    tools: [],
    waits: [],
    assets: [],
    assistantText: "",
    realtimeSeen: false,
    elapsedMs: 0,
    pass: false,
    retryable: false,
    notes: [],
    ...overrides,
  };
}

function statusIs(err: unknown, status: number): boolean {
  return String(err).includes(`-> ${status}`);
}

async function scenarioApiKey(apiBase: string, jwt: string): Promise<AttemptRecord> {
  const started = Date.now();
  const notes: string[] = [];
  let pass = true;
  const clerkApi = new Api(apiBase, jwt);
  const key = await mintApiKey(clerkApi, `acceptance ${new Date().toISOString()}`);
  log(`  api key ${key.prefix}… minted`);
  const keyApi = new Api(apiBase, key.key);

  try {
    await keyApi.call("POST", "/api-keys", { name: "escalation attempt" });
    pass = false;
    notes.push("an API key was allowed to mint another key");
  } catch (err) {
    if (!statusIs(err, 401)) {
      pass = false;
      notes.push(`key minting a key: expected 401, got ${String(err).slice(0, 80)}`);
    }
  }

  const completion = await keyApi.call<{ chatId: string; runId: string; statusUrl: string }>(
    "POST",
    "/completions",
    { message: "Reply with exactly one word: pong" },
    { "idempotency-key": `acceptance-${randomUUID()}` },
  );
  log(`  POST /completions -> run ${completion.runId} in chat ${completion.chatId}`);
  if (!completion.statusUrl.endsWith(`/api/v1/runs/${completion.runId}`)) {
    pass = false;
    notes.push(`unexpected statusUrl ${completion.statusUrl}`);
  }
  const run = await waitForTerminalRun(keyApi, completion.runId, 3 * 60_000);
  if (run.status !== "completed") {
    pass = false;
    notes.push(`run ${run.status}${run.error ? ` (${run.error.code})` : ""}`);
  }

  const listed = await clerkApi.call<{ items: Array<{ id: string; prefix: string; key?: string; lastUsedAt: string | null }> }>("GET", "/api-keys");
  const mine = listed.items.find((k) => k.id === key.id);
  if (!mine) {
    pass = false;
    notes.push("key missing from GET /api-keys");
  } else {
    if (mine.key) {
      pass = false;
      notes.push("GET /api-keys leaked a plaintext key");
    }
    if (!mine.lastUsedAt) notes.push("lastUsedAt not set after use");
  }

  await clerkApi.call("DELETE", `/api-keys/${key.id}`);
  try {
    await keyApi.call("GET", `/runs/${completion.runId}`);
    pass = false;
    notes.push("revoked key still accepted");
  } catch (err) {
    if (statusIs(err, 401)) notes.push("revoked key rejected with 401");
    else {
      pass = false;
      notes.push(`revoked key: expected 401, got ${String(err).slice(0, 80)}`);
    }
  }

  const messages = await clerkApi.call<Page<Message>>("GET", `/chats/${completion.chatId}/messages?limit=5`);
  const assistant = messages.items.find((m) => m.role === "assistant");
  const assistantText = (assistant?.content ?? [])
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join(" ")
    .trim()
    .slice(0, 300);
  return baseRecord({
    scenario: "apikey",
    title: PUBLIC_TITLES.apikey,
    chatId: completion.chatId,
    runId: run.id,
    triggerRunId: run.triggerRunId ?? "-",
    routedModel: run.routedModel,
    runStatus: run.status,
    runError: run.error ? `${run.error.code}: ${run.error.message}` : null,
    assistantText,
    elapsedMs: Date.now() - started,
    pass,
    notes,
  });
}

async function scenarioToolApi(apiBase: string, jwt: string, media: { image: MediaFile }): Promise<AttemptRecord> {
  const started = Date.now();
  const notes: string[] = [];
  let pass = true;
  const clerkApi = new Api(apiBase, jwt);
  const key = await mintApiKey(clerkApi, `acceptance tool ${new Date().toISOString()}`);
  const keyApi = new Api(apiBase, key.key);

  const [attachment] = await uploadFiles(clerkApi, undefined, [media.image]);
  const imageUrl = attachment?.url;
  if (!imageUrl) throw new Error("uploaded attachment has no URL");

  try {
    await keyApi.call("POST", "/tools/load_skill/run", { input: { name: "image-cropping" } });
    pass = false;
    notes.push("load_skill was accepted via the public API");
  } catch (err) {
    if (statusIs(err, 404)) notes.push("non-Magica tool rejected with 404");
    else {
      pass = false;
      notes.push(`non-Magica tool: expected 404, got ${String(err).slice(0, 80)}`);
    }
  }
  try {
    await keyApi.call("POST", "/tools/crop_image/run", { input: { image_url: imageUrl } });
    pass = false;
    notes.push("an incomplete crop rectangle was accepted");
  } catch (err) {
    if (statusIs(err, 400)) notes.push("malformed input rejected with 400");
    else {
      pass = false;
      notes.push(`malformed input: expected 400, got ${String(err).slice(0, 80)}`);
    }
  }

  const accepted = await keyApi.call<{ invocationId: string; status: string; statusUrl: string }>("POST", "/tools/crop_image/run", {
    input: { image_url: imageUrl, x_percent: 25, y_percent: 25, width_percent: 50, height_percent: 50 },
  });
  log(`  POST /tools/crop_image/run -> invocation ${accepted.invocationId} (${accepted.status})`);
  if (!accepted.statusUrl.endsWith(`/api/v1/tools/runs/${accepted.invocationId}`)) {
    pass = false;
    notes.push(`unexpected statusUrl ${accepted.statusUrl}`);
  }

  const deadline = Date.now() + 8 * 60_000;
  let invocation: ToolInvocation;
  let last = "";
  for (;;) {
    invocation = await keyApi.call<ToolInvocation>("GET", `/tools/runs/${accepted.invocationId}`);
    if (invocation.status !== last) {
      log(`  invocation ${invocation.status}`);
      last = invocation.status;
    }
    if (invocation.status === "completed" || invocation.status === "failed" || invocation.status === "cancelled") break;
    if (Date.now() > deadline) throw new Error(`tool run ${accepted.invocationId} did not finish in time`);
    await sleep(2_000);
  }
  const outputUrl = firstHttpsUrl(invocation.output);
  if (invocation.status !== "completed" || !outputUrl) {
    pass = false;
    notes.push(`invocation ${invocation.status}${invocation.error ? ` (${invocation.error.code}: ${invocation.error.message})` : ""}`);
  }
  if (invocation.status === "completed" && invocation.microcreditsCharged <= 0) {
    pass = false;
    notes.push("completed but microcreditsCharged is 0");
  }

  await clerkApi.call("DELETE", `/api-keys/${key.id}`);
  return baseRecord({
    scenario: "tool_api",
    title: PUBLIC_TITLES.tool_api,
    runId: accepted.invocationId,
    runStatus: invocation.status,
    tools: [
      {
        toolName: invocation.toolName,
        status: invocation.status,
        estimated: invocation.microcreditsEstimated,
        charged: invocation.microcreditsCharged,
        providerRunId: invocation.providerRunId,
        error: invocation.error ? `${invocation.error.code}: ${invocation.error.message}` : null,
        outputUrl,
      },
    ],
    assets: outputUrl ? [outputUrl] : [],
    elapsedMs: Date.now() - started,
    pass,
    notes,
  });
}

async function scenarioWebhook(apiBase: string, jwt: string): Promise<AttemptRecord> {
  const started = Date.now();
  const notes: string[] = [];
  let pass = true;
  const received: Array<{ headers: Record<string, string>; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => (body += chunk.toString()));
    req.on("end", () => {
      received.push({ headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")])), body });
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  try {
    const clerkApi = new Api(apiBase, jwt);
    // http + loopback is only accepted by a development backend (NODE_ENV=development); the guard
    // rejects it everywhere else, which is what the SSRF rules in ARCHITECTURE.md §9 require.
    const endpoint = await clerkApi.call<{ id: string; url: string; secret?: string }>("POST", "/webhooks", {
      url: `http://127.0.0.1:${port}/hook`,
      events: ["agent.started", "agent.completed", "agent.failed", "tool.completed"],
    });
    if (!endpoint.secret) throw new Error("POST /webhooks returned no secret");
    log(`  endpoint ${endpoint.id} registered for ${endpoint.url}`);
    const listed = await clerkApi.call<{ items: Array<{ id: string; secret?: string }> }>("GET", "/webhooks");
    if (listed.items.some((e) => e.secret)) {
      pass = false;
      notes.push("GET /webhooks leaked a secret");
    }
    try {
      await clerkApi.call("POST", "/webhooks", { url: "https://169.254.169.254/latest/meta-data", events: ["agent.completed"] });
      pass = false;
      notes.push("metadata-address endpoint was accepted");
    } catch (err) {
      if (statusIs(err, 400)) notes.push("link-local endpoint rejected with 400");
      else notes.push(`link-local endpoint: ${String(err).slice(0, 80)}`);
    }

    const chat = await clerkApi.call<{ id: string }>("POST", "/chats", { title: `acceptance webhook ${new Date().toISOString().slice(0, 16)}` });
    const turn = await sendAndWait(clerkApi, chat.id, "Reply with exactly one word: pong", [], { approve: true, maxDenials: 0, timeoutMs: 3 * 60_000 });

    const wanted = ["agent.started", "agent.completed"];
    const deadline = Date.now() + 90_000;
    const seenTypes = () => new Set(received.map((r) => r.headers["x-agentchat-event"]));
    while (Date.now() < deadline && !wanted.every((w) => seenTypes().has(w))) await sleep(2_000);

    const events = received.map((r) => {
      const parsed = JSON.parse(r.body) as WebhookEvent;
      return { id: parsed.id, type: parsed.type, runId: parsed.data.runId, status: parsed.data.status, signatureValid: verifyWebhookSignature(endpoint.secret!, r.body, r.headers["x-agentchat-signature"] ?? ""), deliveryHeader: r.headers["x-agentchat-delivery"] };
    });
    for (const w of wanted) {
      if (!events.some((e) => e.type === w && e.runId === turn.run.id)) {
        pass = false;
        notes.push(`no ${w} event received for run ${turn.run.id}`);
      }
    }
    if (events.some((e) => !e.signatureValid)) {
      pass = false;
      notes.push("a delivery carried an invalid signature");
    }
    if (events.some((e) => !e.deliveryHeader)) notes.push("a delivery lacked X-AgentChat-Delivery");
    notes.push(`received ${events.length} event(s): ${events.map((e) => `${e.type}(${e.status})`).join(", ") || "none"}`);

    await clerkApi.call("DELETE", `/webhooks/${endpoint.id}`);
    return baseRecord({
      scenario: "webhook",
      title: PUBLIC_TITLES.webhook,
      chatId: chat.id,
      runId: turn.run.id,
      triggerRunId: turn.run.triggerRunId ?? turn.send.realtime.triggerRunId,
      routedModel: turn.run.routedModel,
      runStatus: turn.run.status,
      elapsedMs: Date.now() - started,
      pass,
      notes,
    });
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Evaluation + report
// ---------------------------------------------------------------------------

type ToolSummary = { toolName: string; status: string; estimated: number; charged: number; providerRunId: string | null; error: string | null; outputUrl: string | null };

type AttemptRecord = {
  scenario: string;
  title: string;
  attempt: number;
  chatId: string;
  runId: string;
  triggerRunId: string;
  routedModel: string | null;
  runStatus: string;
  runError: string | null;
  tools: ToolSummary[];
  waits: WaitEvent[];
  assets: string[];
  assistantText: string;
  realtimeSeen: boolean;
  elapsedMs: number;
  pass: boolean;
  retryable: boolean;
  notes: string[];
};

function firstHttpsUrl(v: unknown): string | null {
  if (typeof v === "string") return v.startsWith("https://") ? v : null;
  if (Array.isArray(v)) for (const x of v) {
    const u = firstHttpsUrl(x);
    if (u) return u;
  }
  if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) {
    const u = firstHttpsUrl(x);
    if (u) return u;
  }
  return null;
}

function evaluate(s: Scenario, t: TurnResult, chatId: string, attempt: number): AttemptRecord {
  const notes: string[] = [];
  let pass = true;
  let retryable = false;

  const expectedRun = s.expectRunStatus ?? "completed";
  if (t.run.status !== expectedRun) {
    pass = false;
    notes.push(`run ${t.run.status}, expected ${expectedRun}${t.run.error ? ` (${t.run.error.code}: ${t.run.error.message})` : ""}`);
    if (t.run.error?.code === "malformed_tool_call") retryable = true;
  }

  const wantStatus = s.expectToolStatus ?? "completed";
  for (const name of s.expectTools) {
    const calls = t.run.toolInvocations.filter((i) => i.toolName === name);
    if (calls.length === 0) {
      pass = false;
      retryable = true;
      notes.push(`${name} was never called (model ignored the instruction)`);
      continue;
    }
    if (!calls.some((i) => i.status === wantStatus)) {
      pass = false;
      notes.push(`${name}: ${calls.map((i) => `${i.status}${i.error ? ` [${i.error.code}]` : ""}`).join(", ")}, expected one ${wantStatus}`);
      if (calls.every((i) => i.error?.code === "malformed_tool_call")) retryable = true;
    }
  }
  if (s.expectWaitpoint) {
    const wantAction = (s.approve ?? true) ? "approved" : "denied";
    if (!t.waits.some((w) => w.type === s.expectWaitpoint && w.action === wantAction)) {
      pass = false;
      notes.push(`no ${s.expectWaitpoint} waitpoint was ${wantAction} (estimate below the threshold, or the tool was never proposed)`);
    }
  }
  const unexpected = t.run.toolInvocations.filter((i) => !s.expectTools.includes(i.toolName));
  if (unexpected.length > 0) notes.push(`also called: ${unexpected.map((i) => `${i.toolName}:${i.status}`).join(", ")}`);

  const blocks: ContentBlock[] = t.assistant?.content ?? [];
  const assets = blocks.flatMap((b) => (b.type === "asset" ? [b.url] : []));
  const assistantText = blocks
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const completedMedia = t.run.toolInvocations.filter((i) => i.status === "completed" && ["crop_image", "gpt_image_2", "merge_videos"].includes(i.toolName));
  if (completedMedia.length > 0 && assets.length === 0) {
    pass = false;
    notes.push("media tool completed but the assistant message has no asset block");
  }
  if (t.cancelledByScript) notes.push("cancelled by the script");
  if (!t.realtimeSeen) notes.push("GET /runs/:id never returned a realtime token while active");

  return {
    scenario: s.key,
    title: s.title,
    attempt,
    chatId,
    runId: t.run.id,
    triggerRunId: t.run.triggerRunId ?? t.send.realtime.triggerRunId,
    routedModel: t.run.routedModel,
    runStatus: t.run.status,
    runError: t.run.error ? `${t.run.error.code}: ${t.run.error.message}` : null,
    tools: t.run.toolInvocations.map((i) => ({
      toolName: i.toolName,
      status: i.status,
      estimated: i.microcreditsEstimated,
      charged: i.microcreditsCharged,
      providerRunId: i.providerRunId,
      error: i.error ? `${i.error.code}: ${i.error.message}` : null,
      outputUrl: firstHttpsUrl(i.output),
    })),
    waits: t.waits,
    assets,
    assistantText: assistantText.slice(0, 300),
    realtimeSeen: t.realtimeSeen,
    elapsedMs: t.elapsedMs,
    pass,
    retryable,
    notes,
  };
}

type ReportMeta = { startedAt: string; apiBase: string; clerkUserId: string; reruns?: Array<{ scenarios: string[]; at: string }>; notes?: string[] };

function markdownReport(records: AttemptRecord[], meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push("# Acceptance conversations");
  lines.push("");
  lines.push(`Run started ${meta.startedAt} against ${meta.apiBase} as Clerk user \`${meta.clerkUserId}\`. Produced by \`pnpm acceptance\` (scripts/acceptance.ts).`);
  for (const rerun of meta.reruns ?? []) lines.push(`Re-run with \`--append\` at ${rerun.at}: ${rerun.scenarios.join(", ")} (earlier attempts of those scenarios were replaced).`);
  for (const note of meta.notes ?? []) lines.push(`Note: ${note}`);
  lines.push("");
  lines.push("| Scenario | Attempt | Routed model | Run | Tools (status, est/charged µc) | Waitpoints | Assets | Time | Result |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of records) {
    const tools = r.tools.length === 0 ? "none" : r.tools.map((t) => `${t.toolName} ${t.status} ${t.estimated}/${t.charged}`).join("<br>");
    const waits = r.waits.length === 0 ? "none" : r.waits.map((w) => `${w.type} ${w.action}`).join("<br>");
    lines.push(`| ${r.scenario} | ${r.attempt} | ${r.routedModel ?? "-"} | ${r.runStatus} | ${tools} | ${waits} | ${r.assets.length} | ${Math.round(r.elapsedMs / 1000)}s | ${r.pass ? "PASS" : "FAIL"} |`);
  }
  lines.push("");
  for (const r of records) {
    lines.push(`## ${r.scenario} #${r.attempt}: ${r.title}`);
    lines.push("");
    lines.push(`- Run \`${r.runId}\` (Trigger \`${r.triggerRunId}\`), chat \`${r.chatId}\`, status **${r.runStatus}**${r.runError ? `, error ${r.runError}` : ""}.`);
    for (const t of r.tools) lines.push(`- ${t.toolName}: ${t.status}, estimated ${t.estimated} µc, charged ${t.charged} µc${t.providerRunId ? `, Magica run ${t.providerRunId}` : ""}${t.outputUrl ? `, output ${t.outputUrl}` : ""}${t.error ? `, error ${t.error}` : ""}.`);
    for (const w of r.waits) lines.push(`- Waitpoint ${w.type} ${w.action} at ${w.at}${w.microcreditsEstimated !== null ? ` (estimate ${w.microcreditsEstimated} µc)` : ""}.`);
    for (const a of r.assets) lines.push(`- Asset: ${a}`);
    if (r.assistantText) lines.push(`- Assistant: "${r.assistantText}"`);
    for (const n of r.notes) lines.push(`- Note: ${n}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadDotenv();
  const apiBase = `${(process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "")}/api/v1`;
  const only = arg("only", "").split(",").map((s) => s.trim()).filter(Boolean);
  const attempts = Math.max(1, Number(arg("attempts", "2")));
  const out = arg("out", "");
  const mediaDir = arg("media-dir", path.join(process.cwd(), "node_modules", ".cache", "acceptance-media"));
  const scenarios = only.length > 0 ? SCENARIOS.filter((s) => only.includes(s.key)) : SCENARIOS;
  const publicScenarios: PublicScenarioKey[] = only.length > 0 ? PUBLIC_SCENARIO_KEYS.filter((k) => only.includes(k)) : [...PUBLIC_SCENARIO_KEYS];
  if (scenarios.length === 0 && publicScenarios.length === 0) {
    throw new Error(`No scenarios match --only ${only.join(",")}. Known: ${[...SCENARIOS.map((s) => s.key), ...PUBLIC_SCENARIO_KEYS].join(", ")}`);
  }

  const startedAt = new Date().toISOString();
  const media = scenarios.some((s) => s.needs) || publicScenarios.includes("tool_api") ? ensureMedia(mediaDir) : null;
  const records: AttemptRecord[] = [];
  let clerkUserId = "";

  for (const s of scenarios) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      log(`=== ${s.key} (${s.title}) attempt ${attempt}/${attempts}`);
      const minted = await mintJwt();
      clerkUserId = minted.clerkUserId;
      const api = new Api(apiBase, minted.jwt);
      const chat = await api.call<{ id: string }>("POST", "/chats", { title: `acceptance ${s.key} #${attempt} ${startedAt.slice(0, 16)}` });

      let attachmentIds: string[] = [];
      if (s.needs && media) {
        const files = s.needs === "image" ? [media.image] : media.clips;
        attachmentIds = (await uploadFiles(api, chat.id, files)).map((a) => a.id);
      }

      const turn = await sendAndWait(api, chat.id, s.prompt, attachmentIds, { approve: s.approve ?? true, maxDenials: 2, timeoutMs: s.timeoutMs ?? 10 * 60_000 });
      const record = evaluate(s, turn, chat.id, attempt);
      records.push(record);
      log(`  ${record.pass ? "PASS" : "FAIL"}${record.notes.length ? ` - ${record.notes.join("; ")}` : ""}`);
      if (record.pass || !record.retryable) break;
      if (attempt < attempts) log("  retrying in a fresh chat (model-quality failure)");
    }
  }

  for (const key of publicScenarios) {
    log(`=== ${key} (${PUBLIC_TITLES[key]})`);
    try {
      const minted = await mintJwt();
      clerkUserId = minted.clerkUserId;
      const record =
        key === "apikey" ? await scenarioApiKey(apiBase, minted.jwt) : key === "tool_api" ? await scenarioToolApi(apiBase, minted.jwt, media!) : await scenarioWebhook(apiBase, minted.jwt);
      records.push(record);
      log(`  ${record.pass ? "PASS" : "FAIL"}${record.notes.length ? ` - ${record.notes.join("; ")}` : ""}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      records.push(baseRecord({ scenario: key, title: PUBLIC_TITLES[key], pass: false, notes: [message.slice(0, 300)] }));
      log(`  FAIL - ${message.slice(0, 200)}`);
    }
  }

  // --append: merge this run into an existing report (same --out), replacing earlier attempts of
  // the scenarios that ran now and keeping everything else. Used to re-run scenarios that failed
  // for environmental reasons (e.g. OpenRouter free-tier rate limiting) without spending credits
  // on the ones that already passed.
  const append = process.argv.includes("--append");
  const note = arg("note", "");
  const jsonPath = out ? out.replace(/\.md$/, "") + ".json" : "";
  let allRecords = records;
  let meta: ReportMeta = { startedAt, apiBase, clerkUserId, ...(note ? { notes: [note] } : {}) };
  if (out && append && existsSync(jsonPath)) {
    const previous = JSON.parse(readFileSync(jsonPath, "utf8")) as ReportMeta & { records: AttemptRecord[] };
    const rerun = new Set(records.map((r) => r.scenario));
    const order = [...SCENARIOS.map((s) => s.key), ...PUBLIC_SCENARIO_KEYS];
    allRecords = [...previous.records.filter((r) => !rerun.has(r.scenario)), ...records].sort(
      (a, b) => order.indexOf(a.scenario) - order.indexOf(b.scenario) || a.attempt - b.attempt,
    );
    meta = {
      startedAt: previous.startedAt,
      apiBase: previous.apiBase,
      clerkUserId: previous.clerkUserId || clerkUserId,
      reruns: [...(previous.reruns ?? []), { scenarios: [...rerun], at: startedAt }],
      ...(previous.notes || note ? { notes: [...(previous.notes ?? []), ...(note ? [note] : [])] } : {}),
    };
  }
  const report = markdownReport(allRecords, meta);
  if (out) {
    writeFileSync(out, `${report}\n`);
    writeFileSync(jsonPath, `${JSON.stringify({ ...meta, records: allRecords }, null, 2)}\n`);
    log(`report written to ${out}${append ? " (merged)" : ""}`);
  }
  console.log(`\n${report}`);

  const byScenario = new Map<string, boolean>();
  for (const r of records) byScenario.set(r.scenario, (byScenario.get(r.scenario) ?? false) || r.pass);
  const failed = [...byScenario.entries()].filter(([, ok]) => !ok).map(([k]) => k);
  log(`${byScenario.size - failed.length}/${byScenario.size} scenarios passed${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
