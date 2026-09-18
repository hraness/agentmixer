import { join } from "node:path";
import { realpath } from "node:fs/promises";

import type { AgentTaskAdapter } from "../task-runtime.ts";
import { createClaudeTaskAdapter, claudeTaskRuntimeIdentity, type ClaudeTaskEvents } from "../claude-task-adapter.ts";
import { CLAUDE_CODE_MIN_VERSION } from "../claude-sdk.ts";
import { createCodexManagedTaskAdapter } from "../codex-managed-task-adapter.ts";
import { CODEX_NATIVE_VERSION } from "../codex-process.ts";
import { createDevinAcpAdapter } from "../devin-adapter.ts";
import type { CapabilityProfile } from "../capabilities.ts";

import { inspectCliBinary, type CliBinaryInspection, type CliProviderName } from "./binaries.ts";
import { providerAuthDirs, readClaudeOAuthToken } from "./auth.ts";
import { CLI_CODEX_BUN_DARWIN_ARM64_SHA256, CLI_CODEX_SCHEMA_SHA256, cliCodexRuntimeIdentity,
  createCliCodexManagedLauncher, qualifyCliCodexRuntime } from "./codex.ts";
import { CLI_DEVIN_MIN_VERSION, cliDevinRuntimeIdentity, devinManagedEnv } from "./devin.ts";
import { claudeCliProcessFactory, devinCliProcessFactory, prepareCliLinuxSandbox, prepareDevinCliLinuxSandbox,
  type CliLinuxSandbox, type DevinCliLinuxSandbox } from "./sandbox.ts";
import { buildQualificationRecord, readCliQualification, toTaskQualification, writeCliQualification, type CliQualificationRecord } from "./qualification.ts";
import { privateDirectory } from "./state.ts";

export const CLI_CLAUDE_ROUTE = "claude-subscription";
export const CLI_CODEX_ROUTE = "codex-subscription";
export const CLI_DEVIN_ROUTE = "devin-subscription";
export const CLI_CLAUDE_DEFAULT_MODEL = "claude-sonnet-4-5";
export const CLI_CODEX_DEFAULT_MODEL = "gpt-5.1-codex-mini";
export const CLI_DEVIN_DEFAULT_MODEL = "adaptive";

export type CliProviderState =
  | Readonly<{ status: "ready"; adapter: AgentTaskAdapter; inspection: CliBinaryInspection; record: CliQualificationRecord; close?: () => Promise<unknown> }>
  | Readonly<{ status: "binary-missing" | "version-mismatch" | "unadmitted" | "sandbox-unavailable"; inspection: CliBinaryInspection | null }>;

export const CLI_SYSTEM_PROMPT = [
  "You are xcb, a coding assistant running inside the user's terminal.",
  "The workspace tools address files inside the opened project directory only; there is no shell, process or arbitrary-path access.",
  "Use workspace.list and workspace.search before workspace.read; keep each file's revision and pass it back as expectedRevision to workspace.write.",
  "Answer directly and concisely. Never claim an action you did not perform through the tools.",
].join(" ");

/** Inspect the provider binary and, when the exact pinned version matches, bind
 * it to this runtime/profile and persist the local admission record. This is
 * the doctor half of admission: the adapter separately re-proves the effective
 * boundary on every run. */
export async function admitCliProvider(stateRoot: string, provider: CliProviderName, profile: CapabilityProfile): Promise<Readonly<{
  inspection: CliBinaryInspection | null; record: CliQualificationRecord | null; detail: string;
}>> {
  const inspection = await inspectCliBinary(provider, undefined, true);
  if (inspection === null) {
    return Object.freeze({ inspection, record: null, detail: `${provider} binary not found` });
  }
  if (!inspection.versionMatches) {
    const required = provider === "codex" ? CODEX_NATIVE_VERSION
      : provider === "devin" ? CLI_DEVIN_MIN_VERSION : CLAUDE_CODE_MIN_VERSION;
    const comparator = provider === "codex" ? `pinned ${required}` : `>= ${required}`;
    const hint = provider === "claude" ? ` — install with \`bun add -g @anthropic-ai/claude-code@2\``
      : provider === "devin" ? ` — upgrade the devin CLI to ${required} or newer` : "";
    return Object.freeze({ inspection, record: null, detail: `${provider} ${inspection.version} found; ${comparator} required${hint}` });
  }
  if (provider === "devin") {
    const identity = cliDevinRuntimeIdentity({ executableSha256: inspection.sha256, cliVersion: inspection.version });
    const record = await writeCliQualification(await privateDirectory(stateRoot), buildQualificationRecord({
      provider, route: Object.freeze({ id: CLI_DEVIN_ROUTE, provider: "devin", authentication: "subscription" }),
      executablePath: inspection.executablePath, executableSha256: inspection.sha256,
      runtimeVersion: identity.version, runtimeDigest: identity.digest,
      profileDigest: profile.digest, now: Date.now(),
    }));
    return Object.freeze({ inspection, record, detail: `admitted ${provider} ${inspection.version}` });
  }
  if (provider === "codex") {
    let evidence;
    try { evidence = await qualifyCliCodexRuntime({ stateRoot, inspection }); }
    catch (error) {
      const code = error instanceof Error && /^CLI_CODEX_[A-Z_]+$/u.test(error.message) ? error.message : "CLI_CODEX_QUALIFICATION_FAILED";
      return Object.freeze({ inspection, record: null, detail: `codex managed admission failed: ${code}` });
    }
    const record = await writeCliQualification(await privateDirectory(stateRoot), buildQualificationRecord({
      provider, route: Object.freeze({ id: CLI_CODEX_ROUTE, provider: "codex", authentication: "subscription" }),
      executablePath: inspection.executablePath, executableSha256: inspection.sha256,
      runtimeVersion: evidence.runtime.version, runtimeDigest: evidence.runtime.digest,
      profileDigest: profile.digest, evidenceDigest: evidence.evidenceDigest, now: Date.now(),
    }));
    return Object.freeze({ inspection, record, detail: `admitted ${provider} ${inspection.version}` });
  }
  const identity = claudeTaskRuntimeIdentity({ executableSha256: inspection.sha256, cliVersion: inspection.version, authentication: "subscription" });
  const record = await writeCliQualification(await privateDirectory(stateRoot), buildQualificationRecord({
    provider,
    route: Object.freeze({ id: CLI_CLAUDE_ROUTE, provider: "claude", authentication: "subscription" }),
    executablePath: inspection.executablePath,
    executableSha256: inspection.sha256,
    runtimeVersion: identity.version,
    runtimeDigest: identity.digest,
    profileDigest: profile.digest,
    now: Date.now(),
  }));
  return Object.freeze({ inspection, record, detail: `admitted ${provider} ${inspection.version}` });
}

/** Open the task adapter for one provider if a matching live admission record
 * exists. Anything stale, drifted or absent leaves the adapter out — the TUI
 * explains the next step instead of running unqualified. `workspaceRoot` is
 * the resolved consumer workspace: Devin's sandbox binds it read-only and
 * its ACP session anchors there, so it is required for that provider. */
export async function openCliProvider(stateRoot: string, provider: CliProviderName, profile: CapabilityProfile, events?: ClaudeTaskEvents,
  context?: Readonly<{ workspaceRoot?: string }>): Promise<CliProviderState> {
  const inspection = await inspectCliBinary(provider);
  if (inspection === null) return Object.freeze({ status: "binary-missing", inspection });
  if (!inspection.versionMatches) return Object.freeze({ status: "version-mismatch", inspection });
  const record = await readCliQualification(stateRoot, provider);
  if (record === null || record.executableSha256 !== inspection.sha256 || record.executablePath !== inspection.executablePath) {
    return Object.freeze({ status: "unadmitted", inspection });
  }
  if (provider === "devin") {
    const workspaceRoot = context?.workspaceRoot;
    if (workspaceRoot === undefined) throw new Error("CLI_DEVIN_WORKSPACE_REQUIRED");
    const { home } = await providerAuthDirs(stateRoot, "devin");
    const route = Object.freeze({ id: CLI_DEVIN_ROUTE, provider: "devin" as const, authentication: "subscription" as const });
    const identity = cliDevinRuntimeIdentity({ executableSha256: inspection.sha256, cliVersion: inspection.version });
    const qualification = toTaskQualification(record, { route, profile, runtimeVersion: identity.version, runtimeDigest: identity.digest });
    if (qualification.status !== "qualified") return Object.freeze({ status: "unadmitted", inspection });
    // Confinement mirrors the Claude posture: seatbelt on darwin, an
    // admitted bwrap plan on Linux — unavailable rather than unsandboxed.
    // The workspace is read-only inside either boundary; the agent's file
    // writes all flow through the host relay's revision-checked tools.
    let linuxSandbox: DevinCliLinuxSandbox | undefined;
    if (process.platform === "linux") {
      const bridgeDirectory = join(await privateDirectory(stateRoot), "egress");
      linuxSandbox = await prepareDevinCliLinuxSandbox({ bridgeDirectory }).catch(() => null) ?? undefined;
      if (linuxSandbox === undefined) return Object.freeze({ status: "sandbox-unavailable", inspection });
    }
    const bridgeExecutable = await realpath(process.execPath);
    const processFactory = devinCliProcessFactory({
      stateRoot, accountHome: home, workspace: workspaceRoot, bridgeExecutable,
      ...(linuxSandbox === undefined ? {} : { linux: linuxSandbox }),
    });
    if (processFactory === undefined) {
      await linuxSandbox?.close().catch(() => {});
      return Object.freeze({ status: "sandbox-unavailable", inspection });
    }
    const adapter = createDevinAcpAdapter({
      route, runtime: identity, qualification,
      executable: inspection.executablePath,
      env: devinManagedEnv(home),
      factory: processFactory,
      bridgeExecutable,
      ...(linuxSandbox === undefined ? {}
        : { relayListen: Object.freeze({ socketPath: linuxSandbox.serviceSocketPath, port: linuxSandbox.servicePort }) }),
      workspaceCwd: () => workspaceRoot,
      // Headless runs have no one to answer a permission prompt: each tool
      // gate gets allow_once, never allow_always — the OS boundary and the
      // brokered write path decide what is actually possible.
      permission: (request) => {
        const allow = request.options.find(option => option.kind === "allow_once");
        return allow === undefined ? Object.freeze({ outcome: "cancelled" as const })
          : Object.freeze({ outcome: "selected" as const, optionId: allow.optionId });
      },
      now: Date.now,
    });
    return Object.freeze({ status: "ready", adapter, inspection, record,
      ...(linuxSandbox === undefined ? {} : { close: () => linuxSandbox.close() }) });
  }
  if (provider === "codex") {
    if (process.platform !== "darwin" || process.arch !== "arm64") return Object.freeze({ status: "sandbox-unavailable", inspection });
    const route = Object.freeze({ id: CLI_CODEX_ROUTE, provider: "codex" as const, authentication: "subscription" as const });
    const identity = cliCodexRuntimeIdentity({ nativeSha256: inspection.sha256, schemaSha256: CLI_CODEX_SCHEMA_SHA256,
      parentSha256: CLI_CODEX_BUN_DARWIN_ARM64_SHA256 });
    const qualification = toTaskQualification(record, { route, profile, runtimeVersion: identity.version, runtimeDigest: identity.digest });
    if (qualification.status !== "qualified") return Object.freeze({ status: "unadmitted", inspection });
    const adapter = createCodexManagedTaskAdapter({ route, runtime: identity, qualification,
      instructions: Object.freeze({ base: CLI_SYSTEM_PROMPT, developer: "" }),
      launcher: createCliCodexManagedLauncher(stateRoot, inspection, identity), now: Date.now });
    return Object.freeze({ status: "ready", adapter, inspection, record });
  }
  if (provider === "claude") {
    const { config } = await providerAuthDirs(stateRoot, "claude");
    const route = Object.freeze({ id: CLI_CLAUDE_ROUTE, provider: "claude" as const, authentication: "subscription" as const });
    const runtime = Object.freeze({ executablePath: inspection.executablePath, executableSha256: inspection.sha256, cliVersion: inspection.version });
    const identity = claudeTaskRuntimeIdentity({ executableSha256: inspection.sha256, cliVersion: inspection.version, authentication: "subscription" });
    const qualification = toTaskQualification(record, { route, profile, runtimeVersion: identity.version, runtimeDigest: identity.digest });
    // On darwin the provider process is wrapped in seatbelt: writable access
    // is confined to the per-run scratch and the managed auth directory, and
    // egress is limited to TCP 443 plus the system resolver. On Linux an
    // admitted bwrap plan plus the in-namespace CONNECT forwarder provides
    // the equivalent boundary; if that surface cannot be prepared the
    // provider is unavailable rather than silently unsandboxed. Other
    // platforms keep the existing bounded-process custody (no OS sandbox
    // claim).
    let linuxSandbox: CliLinuxSandbox | undefined;
    if (process.platform === "linux") {
      const bridgeDirectory = join(await privateDirectory(stateRoot), "egress");
      linuxSandbox = await prepareCliLinuxSandbox({ bridgeDirectory }).catch(() => null) ?? undefined;
      if (linuxSandbox === undefined) return Object.freeze({ status: "sandbox-unavailable", inspection });
    }
    const processFactory = claudeCliProcessFactory(config, linuxSandbox);
    const adapter = createClaudeTaskAdapter({
      route, runtime, stateRoot, authDirectory: config,
      authentication: "subscription", qualification, systemPrompt: CLI_SYSTEM_PROMPT,
      subscriptionToken: async () => {
        const token = await readClaudeOAuthToken(stateRoot);
        if (token === null) throw new Error("CLAUDE_OAUTH_TOKEN_REQUIRED");
        return token;
      },
      ...(events === undefined ? {} : { events }),
      ...(processFactory === undefined ? {} : { processFactory }),
    });
    if (qualification.status !== "qualified") {
      await linuxSandbox?.close().catch(() => {});
      return Object.freeze({ status: "unadmitted", inspection });
    }
    return Object.freeze({ status: "ready", adapter, inspection, record,
      ...(linuxSandbox === undefined ? {} : { close: () => linuxSandbox.close() }) });
  }
  return Object.freeze({ status: "unadmitted", inspection });
}
