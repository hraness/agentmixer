import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import { query, createSdkMcpServer, tool, type SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";

import { assertCapabilityProfile, type CapabilityBroker, type CapabilityObject, type CapabilityDescriptor } from "./capabilities.ts";
import { literalClaudePrompt, restrictedClaudeOptions } from "./claude-options.ts";
import { CLAUDE_CODE_VERSION, CLAUDE_SDK_VERSION, inspectClaudeSdkRuntime, type ClaudeApiKeyResolver } from "./claude-sdk.ts";
import { spawnBoundedProvider, type BoundedProviderProcess, type BoundedProviderProcessFactory } from "./provider-process.ts";
import {
  assertAgentTaskAccountLease,
  type AgentTaskAdapter,
  type AgentTaskBinding,
  type AgentTaskCompletion,
  type AgentTaskExecutionRequest,
  type AgentTaskRoute,
  type AgentTaskStopEvidence,
  type TaskRuntimeQualification,
} from "./task-runtime.ts";
import { boundedText, identifier, safeInteger } from "./validation.ts";

const SERVER = "agentmixer";
const fail = (code: string): never => { throw new Error(code); };
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

export type ClaudeTaskAuthentication = "api" | "subscription";

/** Returns the account's long-lived Claude subscription OAuth token
 * (`sk-ant-oat…`) for one task, or fails closed. The host owns storage; the
 * token reaches the provider only through CLAUDE_CODE_OAUTH_TOKEN env. */
export type ClaudeSubscriptionTokenResolver = (accountId: string, signal: AbortSignal) => Promise<string>;

export type ClaudeTaskAdapterOptions = Readonly<{
  route: AgentTaskRoute;
  runtime: Readonly<{ executablePath: string; executableSha256: string }>;
  /** Existing physical mode-0700 directory owned by this user, outside all workspaces. */
  stateRoot: string;
  /** Persistent physical mode-0700 directory holding the managed Claude
   * configuration and subscription credentials. */
  authDirectory: string;
  /** Required when `authentication` is `"api"`. */
  credentials?: ClaudeApiKeyResolver;
  /** Required when `authentication` is `"subscription"`. */
  subscriptionToken?: ClaudeSubscriptionTokenResolver;
  authentication: ClaudeTaskAuthentication;
  qualification: TaskRuntimeQualification;
  /** System prompt for the host's own product surface. */
  systemPrompt: string;
  processFactory?: BoundedProviderProcessFactory;
  now?: () => number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  deadlineMs?: number;
}>;

const publicName = (name: string) => name.replaceAll(".", "_");
const fullName = (name: string) => `mcp__${SERVER}__${publicName(name)}`;

/** The adapter's stable runtime identity for one authentication mode and exact
 * inspected binary. Hosts bind qualification records to this digest. */
export function claudeTaskRuntimeIdentity(executableSha256: string, authentication: ClaudeTaskAuthentication): Readonly<{ version: string; digest: string }> {
  const version = `claude-sdk/${CLAUDE_SDK_VERSION};claude-code/${CLAUDE_CODE_VERSION};task`;
  return Object.freeze({ version, digest: hash(JSON.stringify({ runtimeVersion: version, executableSha256, authentication })) });
}

/** Translate the closed JSON-schema subset capability descriptors use into the
 * SDK's Zod tool shapes. Anything outside the subset fails closed at adapter
 * construction, never at model call time. */
function descriptorSchema(schema: CapabilityObject): Record<string, z.ZodTypeAny> {
  if (schema.type !== "object" || schema.additionalProperties !== false
    || schema.properties === null || typeof schema.properties !== "object" || Array.isArray(schema.properties)
    || !Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string")) {
    fail("CLAUDE_TASK_SCHEMA_INVALID");
  }
  const required = new Set(schema.required as string[]);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, raw] of Object.entries(schema.properties as Record<string, CapabilityObject>)) {
    shape[name] = propertySchema(raw, required.has(name));
  }
  return shape;
}

function propertySchema(raw: CapabilityObject, required: boolean): z.ZodTypeAny {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("CLAUDE_TASK_SCHEMA_INVALID");
  const type = baseSchema(raw);
  return required ? type : type.optional();
}

function baseSchema(raw: CapabilityObject): z.ZodTypeAny {
  if (Array.isArray(raw.anyOf)) {
    const variants = raw.anyOf.map((variant) => propertySchema(variant as CapabilityObject, true));
    if (variants.length === 0 || variants.length > 4) fail("CLAUDE_TASK_SCHEMA_INVALID");
    return variants.length === 1 ? variants[0]! : z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }
  if (raw.type === "string") {
    let value = z.string();
    if (raw.minLength !== undefined) value = value.min(safeInteger(raw.minLength, 0, 4096));
    if (raw.maxLength !== undefined) value = value.max(safeInteger(raw.maxLength, 1, 4 * 1024 * 1024));
    return value;
  }
  if (raw.type === "null") return z.null();
  if (raw.type === "boolean") return z.boolean();
  if (raw.type === "integer" || raw.type === "number") {
    let value: z.ZodNumber = raw.type === "integer" ? z.number().int() : z.number();
    if (raw.minimum !== undefined) value = value.min(safeInteger(raw.minimum, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
    if (raw.maximum !== undefined) value = value.max(safeInteger(raw.maximum, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
    return value;
  }
  return fail("CLAUDE_TASK_SCHEMA_INVALID");
}

function assertTaskInitialization(value: SDKSystemMessage, request: AgentTaskExecutionRequest, broker: CapabilityBroker, cwd: string, authentication: ClaudeTaskAuthentication): void {
  const expected = broker.profile.tools.map((descriptor) => fullName(descriptor.name)).sort();
  const expectedKeySource = authentication === "api" ? "ANTHROPIC_API_KEY" : "none";
  if (value.claude_code_version !== CLAUDE_CODE_VERSION || value.cwd !== cwd || value.model !== request.model.id
    || value.apiKeySource !== expectedKeySource || value.permissionMode !== "dontAsk"
    || !Array.isArray(value.tools) || JSON.stringify([...value.tools].sort()) !== JSON.stringify(expected)
    || !Array.isArray(value.skills) || value.skills.length !== 0 || !Array.isArray(value.plugins) || value.plugins.length !== 0
    || !Array.isArray(value.mcp_servers) || value.mcp_servers.length !== (expected.length ? 1 : 0)
    || value.mcp_servers.some((server) => server.name !== SERVER || server.status !== "connected")) {
    throw new Error("CLAUDE_EFFECTIVE_BOUNDARY_MISMATCH");
  }
}

async function privateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("CLAUDE_STATE_ROOT_INVALID");
  const actual = await realpath(path), stat = await lstat(path);
  if (actual !== path || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("CLAUDE_STATE_ROOT_INVALID");
  }
  return actual;
}

function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(v: unknown): void {
    if (v !== null && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
  }
  freeze(copy); return copy;
}

const proof = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const requestDigest = (request: AgentTaskExecutionRequest) => proof({
  route: request.route, accountId: request.accountId, workspaceId: request.workspaceId, runId: request.runId,
  profile: request.profile, model: request.model, runtime: request.runtime, purpose: request.purpose,
  prompt: request.prompt, limits: request.limits, admittedAtUnixMs: request.admittedAtUnixMs,
  executionDeadlineUnixMs: request.executionDeadlineUnixMs,
});

type Active = {
  binding: AgentTaskBinding;
  requestDigest: string;
  cleanupDeadlineUnixMs: number;
  controller: AbortController;
  promise: Promise<AgentTaskCompletion>;
  sessionStarted: boolean;
  processStopped: boolean;
  stopping?: Promise<AgentTaskStopEvidence>;
};

/**
 * Claude Code through the Agent SDK as an application-profile task adapter. The
 * model's entire tool surface is the capability broker; subscription auth uses
 * the managed CLAUDE_CONFIG_DIR written by `agentmixer auth claude`, while API
 * auth keeps the key-resolver seam. No native tools, hooks, plugins, skills or
 * inherited configuration reach the provider.
 */
export function createClaudeTaskAdapter(options: ClaudeTaskAdapterOptions): AgentTaskAdapter {
  if (options.route.provider !== "claude") throw Error("CLAUDE_TASK_ROUTE_INVALID");
  if (options.authentication !== "api" && options.authentication !== "subscription") throw Error("CLAUDE_TASK_AUTH_INVALID");
  if (options.authentication === "api" && typeof options.credentials?.withApiKey !== "function") throw Error("CLAUDE_TASK_CREDENTIALS_REQUIRED");
  if (options.authentication === "subscription" && typeof options.subscriptionToken !== "function") throw Error("CLAUDE_TASK_CREDENTIALS_REQUIRED");
  const authentication = options.authentication;
  const route = Object.freeze({ id: identifier(options.route.id), provider: "claude" as const, authentication });
  if (route.authentication !== options.route.authentication) throw Error("CLAUDE_TASK_ROUTE_INVALID");
  const now = options.now ?? Date.now;
  const processFactory = options.processFactory ?? spawnBoundedProvider;
  if (typeof processFactory !== "function") throw Error("CLAUDE_PROCESS_FACTORY_INVALID");
  const maxTurns = (value => (Number.isSafeInteger(value) && value >= 1 && value <= 32 ? value : fail("CLAUDE_TASK_LIMIT_INVALID")))(options.maxTurns ?? 12);
  const deadlineMs = (value => (Number.isSafeInteger(value) && value >= 1_000 && value <= 300_000 ? value : fail("CLAUDE_TASK_LIMIT_INVALID")))(options.deadlineMs ?? 120_000);
  const maxBudgetUsd = options.maxBudgetUsd ?? 0.25;
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 5) throw new Error("CLAUDE_TASK_LIMIT_INVALID");
  const systemPrompt = boundedText(options.systemPrompt, 64 * 1024);
  const stateRoot = options.stateRoot, authDirectory = options.authDirectory;
  const executablePath = options.runtime.executablePath;
  if (typeof executablePath !== "string" || !isAbsolute(executablePath)) throw Error("CLAUDE_RUNTIME_INVALID");
  const runtime = Object.freeze({ executablePath, executableSha256: options.runtime.executableSha256 });
  const identity = claudeTaskRuntimeIdentity(runtime.executableSha256, authentication);
  const runtimeVersion = identity.version;
  const runtimeDigest = identity.digest;
  const qualification: TaskRuntimeQualification = Object.freeze(freezeCopy(options.qualification));
  const credentials = options.credentials;
  const slots = new WeakMap<AbortSignal, Active>();
  let active: Active | null = null;

  const adapter: AgentTaskAdapter = {
    route,
    runtime: Object.freeze({ version: runtimeVersion, digest: runtimeDigest }),
    qualification,
    async run(input, broker: CapabilityBroker): Promise<AgentTaskCompletion> {
      if (qualification.status !== "qualified") throw Error("CLAUDE_TASK_ADAPTER_UNQUALIFIED");
      const qualified = qualification;
      assertAgentTaskAccountLease(input);
      if (slots.has(input.signal)) throw Error("CLAUDE_TASK_REQUEST_ALREADY_ADMITTED");
      const request: AgentTaskExecutionRequest = Object.freeze({ ...input });
      const busy = active !== null, controller = new AbortController();
      const slot: Active = { binding: bindingOf(request), requestDigest: requestDigest(request),
        cleanupDeadlineUnixMs: request.cleanupDeadlineUnixMs, controller,
        promise: Promise.resolve().then(execute), sessionStarted: false, processStopped: true };
      slots.set(request.signal, slot);
      if (!busy) active = slot;
      async function execute(): Promise<AgentTaskCompletion> {
        try {
          if (busy) throw Error("CLAUDE_TASK_ALREADY_RUNNING");
          if (qualified.status !== "qualified" || qualified.route.id !== route.id
            || qualified.runtimeVersion !== adapter.runtime.version || qualified.runtimeDigest !== adapter.runtime.digest
            || qualified.expiresAt <= now() || !qualified.controls.noCommandTools || !qualified.controls.exactToolInventory
            || !qualified.controls.workspaceReadIsolation || !qualified.controls.workspaceWriteIsolation
            || !qualified.controls.isolatedConfiguration || !qualified.controls.authOutsideWorkspace || !qualified.controls.hostBrokerOnly) {
            throw Error("CLAUDE_TASK_QUALIFICATION_MISMATCH");
          }
          if (qualified.profile.id !== request.profile.id || qualified.profile.version !== request.profile.version
            || qualified.profile.digest !== request.profile.digest) throw Error("CLAUDE_TASK_PROFILE_MISMATCH");
          assertCapabilityProfile(broker.profile, request.profile);
          if (broker.runId !== request.runId || broker.workspaceId !== request.workspaceId) throw Error("CLAUDE_TASK_BROKER_MISMATCH");
          broker.assertActive(); request.signal.throwIfAborted();
          const inspected = await inspectClaudeSdkRuntime(runtime);
          if (inspected.runtimeDigest === undefined) throw Error("CLAUDE_RUNTIME_PREFLIGHT_FAILED");
          const resolvedStateRoot = await privateDirectory(stateRoot);
          const resolvedAuthDirectory = await privateDirectory(authDirectory);
          const remaining = safeInteger(request.executionDeadlineUnixMs - now(), 1, request.limits.maxRunMs);
          const deadline = Math.min(deadlineMs, remaining);
          const output = await runProvider(request, broker, resolvedStateRoot, resolvedAuthDirectory, deadline, controller.signal, slot);
          slot.sessionStarted = true;
          return Object.freeze({ ...slot.binding, output,
            usage: Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null }),
            outcome: Object.freeze({ status: "completed", code: null }) });
        } catch (error) {
          // outcome.code must be identifier-shaped — coerce any message into
          // a bounded [A-Za-z0-9_.:-] code.
          const code = error instanceof Error
            ? (error.message.replaceAll(/[^A-Za-z0-9_.:-]/gu, "_").replaceAll(/^_+|_+$/gu, "").slice(0, 140) || "CLAUDE_TASK_FAILED")
            : "CLAUDE_TASK_FAILED";
          return Object.freeze({ ...slot.binding, output: null,
            usage: Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null }),
            outcome: Object.freeze({ status: "failed", code }) });
        }
      }
      return slot.promise;
    },
    async stop(request): Promise<AgentTaskStopEvidence> {
      const descriptor = Object.getOwnPropertyDescriptor(request, "signal");
      if (!descriptor || !("value" in descriptor)) throw Error("CLAUDE_TASK_STOP_BINDING_MISMATCH");
      const slot = slots.get(descriptor.value);
      if (!slot) throw Error("CLAUDE_TASK_NOT_RUNNING");
      try { assertAgentTaskAccountLease(request, "stop"); }
      catch { throw Error("CLAUDE_TASK_STOP_BINDING_MISMATCH"); }
      if (requestDigest(request) !== slot.requestDigest || !Number.isSafeInteger(request.cleanupDeadlineUnixMs)
        || request.cleanupDeadlineUnixMs < request.admittedAtUnixMs || request.cleanupDeadlineUnixMs > slot.cleanupDeadlineUnixMs) {
        throw Error("CLAUDE_TASK_STOP_BINDING_MISMATCH");
      }
      return slot.stopping ??= Promise.resolve().then(async () => {
        slot.controller.abort();
        await slot.promise;
        if (slot.sessionStarted && !slot.processStopped) throw Error("CLAUDE_TASK_STOP_UNPROVEN");
        const evidence = Object.freeze({ ...slot.binding, processStopped: true as const, controllersStopped: true as const,
          joined: true as const, stoppedAtUnixMs: safeInteger(now(), request.admittedAtUnixMs, Number.MAX_SAFE_INTEGER),
          proofDigest: proof({ requestDigest: slot.requestDigest, custody: { sessionStarted: slot.sessionStarted, processStopped: slot.processStopped } }) });
        if (active === slot) active = null;
        return evidence;
      });
    },
  };

  function bindingOf(value: AgentTaskExecutionRequest): AgentTaskBinding {
    return Object.freeze({ ...freezeCopy({ route: value.route, accountId: value.accountId, workspaceId: value.workspaceId,
      runId: value.runId, profile: value.profile, model: value.model, runtime: value.runtime }),
      accountLease: value.accountLease });
  }

  async function runProvider(request: AgentTaskExecutionRequest, broker: CapabilityBroker, stateRootResolved: string,
    authDirectoryResolved: string, deadline: number, runSignal: AbortSignal, slot: Active): Promise<string> {
    const directory = join(stateRootResolved, `claude-run-${request.runId}`);
    const timer = setTimeout(() => slot.controller.abort(), deadline);
    const abort = () => slot.controller.abort();
    runSignal.addEventListener("abort", abort, { once: true });
    let joined = true;
    try {
      // One writable scratch root so an OS sandbox can admit rw access to
      // exactly one subtree; the executable snapshot and any policy artifact
      // stay siblings outside it.
      const scratch = join(directory, "scratch");
      const cwd = join(scratch, "work"), home = join(scratch, "home"), temp = join(scratch, "tmp");
      for (const path of [cwd, home, temp]) await mkdir(path, { mode: 0o700, recursive: true });
      const executable = join(directory, "provider");
      const source = await open(runtime.executablePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const bytes = await source.readFile();
        const out = await open(executable, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o500);
        try { await out.writeFile(bytes); } finally { await out.close(); }
      } finally { await source.close(); }
      const invoke = async (env: Record<string, string>): Promise<string> => {
        let child: BoundedProviderProcess | undefined;
        let admitted = false;
        const brokerTools = broker.profile.tools.map((descriptor: CapabilityDescriptor) => tool(
          publicName(descriptor.name), boundedText(descriptor.description, 2048), descriptorSchema(descriptor.inputSchema),
          async (input: Record<string, unknown>) => {
            if (!admitted || slot.controller.signal.aborted) {
              return { isError: true, content: [{ type: "text" as const, text: "RUN_NOT_ADMITTED" }] };
            }
            try {
              const result = await broker.invoke(descriptor.name, input);
              return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
            } catch {
              return { isError: true, content: [{ type: "text" as const, text: "TOOL_REQUEST_DENIED" }] };
            }
          },
        ));
        const sdkOptions = restrictedClaudeOptions({
          abortController: slot.controller, cwd, env, model: request.model.id,
          brokerToolNames: broker.profile.tools.map((descriptor) => fullName(descriptor.name)),
          maxTurns, maxBudgetUsd, pathToClaudeCodeExecutable: executable,
          mcpServers: brokerTools.length ? { [SERVER]: createSdkMcpServer({ name: SERVER, version: "1.0.0", tools: brokerTools }) } : {},
          systemPrompt,
          spawnClaudeCodeProcess: (inputArgs) => {
            if (child !== undefined || inputArgs.command !== executable || inputArgs.cwd !== cwd) throw new Error("CLAUDE_SPAWN_MISMATCH");
            slot.controller.signal.throwIfAborted();
            joined = false;
            child = processFactory({ executable, args: Object.freeze([...inputArgs.args]), cwd, env, onViolation: () => slot.controller.abort(),
              binding: Object.freeze({ runId: request.runId, accountId: request.accountId, workspaceId: request.workspaceId }) });
            return child.process;
          },
        });
        let response: ReturnType<typeof query> | undefined;
        let output: string | undefined;
        let resultSeen = false;
        let failure = false;
        let detail = "CLAUDE_RUN_FAILED";
        try {
          response = query({ prompt: literalClaudePrompt(request.prompt), options: sdkOptions });
          let received = 0;
          for await (const event of response) {
            slot.controller.signal.throwIfAborted();
            received += Buffer.byteLength(JSON.stringify(event));
            if (received > 8 * 1024 * 1024) throw new Error("CLAUDE_OUTPUT_LIMIT");
            if (event.type === "system" && event.subtype === "init") {
              assertTaskInitialization(event, request, broker, cwd, authentication);
              admitted = true;
            } else if (event.type === "result") {
              if (!admitted || resultSeen) throw new Error("CLAUDE_RESULT_INVALID");
              // A provider-declared error result carries a typed subtype (or a
              // success envelope flagged is_error) — surface an identifier-safe
              // code rather than collapsing to a bare failure.
              if (event.is_error || event.subtype !== "success") {
                const subtype = String(event.subtype).toUpperCase().replaceAll(/[^A-Z0-9_]/gu, "_").slice(0, 60);
                throw new Error(subtype === "SUCCESS" ? "CLAUDE_TASK_ERROR" : `CLAUDE_TASK_${subtype}`);
              }
              if (Buffer.byteLength(event.result) > request.limits.maxOutputBytes) throw new Error("CLAUDE_RESULT_INVALID");
              output = event.result;
              resultSeen = true;
            }
          }
          if (!resultSeen || output === undefined) throw new Error("CLAUDE_RESULT_MISSING");
        } catch (runError) {
          // The thrown message becomes the identifier-shaped outcome code.
          detail = (runError instanceof Error ? runError.message : "CLAUDE_RUN_FAILED")
            .replaceAll(/[^A-Za-z0-9_.:-]/gu, "_").replaceAll(/^_+|_+$/gu, "").slice(0, 140) || "CLAUDE_RUN_FAILED";
          failure = true;
        } finally {
          admitted = false;
          try { response?.close(); } catch { failure = true; }
          try {
            if (child !== undefined) {
              await child.stopAndJoin();
              joined = child.isStopped();
            }
          } finally {
            delete env.ANTHROPIC_API_KEY;
            delete env.CLAUDE_CODE_OAUTH_TOKEN;
          }
        }
        slot.processStopped = joined;
        if (!joined) throw new Error("CLAUDE_PROCESS_EXIT_UNPROVEN");
        if (failure || slot.controller.signal.aborted) throw new Error(detail);
        return output!;
      };
      const env: Record<string, string> = {
        HOME: home, CLAUDE_CONFIG_DIR: authDirectoryResolved, TMPDIR: temp, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_AGENT_SDK_CLIENT_APP: "agentmixer/0.2.0", NO_COLOR: "1",
      };
      if (authentication === "api") {
        return await credentials!.withApiKey(request.accountId, slot.controller.signal, async (apiKey) => {
          if (typeof apiKey !== "string" || !/^sk-ant-api03-[A-Za-z0-9_-]{16,512}$/u.test(apiKey)) throw new Error("CLAUDE_API_KEY_REQUIRED");
          env.ANTHROPIC_API_KEY = apiKey;
          return await invoke(env);
        });
      }
      const token = await options.subscriptionToken!(request.accountId, slot.controller.signal);
      if (typeof token !== "string" || !/^sk-ant-oat\d{2}-[A-Za-z0-9_-]{16,1024}$/u.test(token)) throw new Error("CLAUDE_OAUTH_TOKEN_REQUIRED");
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
      return await invoke(env);
    } finally {
      clearTimeout(timer);
      runSignal.removeEventListener("abort", abort);
      slot.sessionStarted = true;
      if (joined) await rm(directory, { recursive: true, force: true });
    }
  }

  return Object.freeze(adapter);
}
