import type { AgentTaskAdapter } from "../task-runtime.ts";
import { createClaudeTaskAdapter, claudeTaskRuntimeIdentity } from "../claude-task-adapter.ts";
import { CLAUDE_CODE_VERSION } from "../claude-sdk.ts";
import { CODEX_NATIVE_VERSION } from "../codex-process.ts";
import type { CapabilityProfile } from "../capabilities.ts";

import { inspectCliBinary, type CliBinaryInspection, type CliProviderName } from "./binaries.ts";
import { providerAuthDirs, readClaudeOAuthToken } from "./auth.ts";
import { claudeCliProcessFactory } from "./sandbox.ts";
import { buildQualificationRecord, readCliQualification, toTaskQualification, writeCliQualification, type CliQualificationRecord } from "./qualification.ts";
import { privateDirectory } from "./state.ts";

export const CLI_CLAUDE_ROUTE = "claude-subscription";
export const CLI_CODEX_ROUTE = "codex-subscription";
export const CLI_CLAUDE_DEFAULT_MODEL = "claude-sonnet-4-5";
export const CLI_CODEX_DEFAULT_MODEL = "gpt-5.1-codex-mini";

export type CliProviderState =
  | Readonly<{ status: "ready"; adapter: AgentTaskAdapter; inspection: CliBinaryInspection; record: CliQualificationRecord }>
  | Readonly<{ status: "binary-missing" | "version-mismatch" | "unadmitted"; inspection: CliBinaryInspection | null }>;

export const CLI_SYSTEM_PROMPT = [
  "You are AgentMixer, a coding assistant running inside the user's terminal.",
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
    return Object.freeze({ inspection, record: null, detail: provider === "codex" ? "codex binary not found" : "claude binary not found" });
  }
  if (!inspection.versionMatches) {
    const required = provider === "codex" ? CODEX_NATIVE_VERSION : CLAUDE_CODE_VERSION;
    const hint = provider === "claude" ? ` — install with \`bun add -g @anthropic-ai/claude-code@${required}\`` : "";
    return Object.freeze({ inspection, record: null, detail: `${provider} ${inspection.version} found; pinned ${required} required${hint}` });
  }
  if (provider !== "claude") {
    // The managed Codex admission needs the trusted protocol manifest and parent
    // runtime pin; local binary admission alone is insufficient.
    return Object.freeze({ inspection, record: null, detail: "codex managed admission is not yet available in the CLI" });
  }
  const identity = claudeTaskRuntimeIdentity(inspection.sha256, "subscription");
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
 * explains the next step instead of running unqualified. */
export async function openCliProvider(stateRoot: string, provider: CliProviderName, profile: CapabilityProfile): Promise<CliProviderState> {
  const inspection = await inspectCliBinary(provider);
  if (inspection === null) return Object.freeze({ status: "binary-missing", inspection });
  if (!inspection.versionMatches) return Object.freeze({ status: "version-mismatch", inspection });
  const record = await readCliQualification(stateRoot, provider);
  if (record === null || record.executableSha256 !== inspection.sha256 || record.executablePath !== inspection.executablePath) {
    return Object.freeze({ status: "unadmitted", inspection });
  }
  if (provider === "claude") {
    const { config } = await providerAuthDirs(stateRoot, "claude");
    const route = Object.freeze({ id: CLI_CLAUDE_ROUTE, provider: "claude" as const, authentication: "subscription" as const });
    const runtime = Object.freeze({ executablePath: inspection.executablePath, executableSha256: inspection.sha256 });
    const identity = claudeTaskRuntimeIdentity(inspection.sha256, "subscription");
    const qualification = toTaskQualification(record, { route, profile, runtimeVersion: identity.version, runtimeDigest: identity.digest });
    // On darwin the provider process is wrapped in seatbelt: writable access
    // is confined to the per-run scratch and the managed auth directory, and
    // egress is limited to TCP 443 plus the system resolver. Off-darwin keeps
    // the existing bounded-process custody (no OS sandbox claim).
    const processFactory = claudeCliProcessFactory(config);
    const adapter = createClaudeTaskAdapter({
      route, runtime, stateRoot, authDirectory: config,
      authentication: "subscription", qualification, systemPrompt: CLI_SYSTEM_PROMPT,
      subscriptionToken: async () => {
        const token = await readClaudeOAuthToken(stateRoot);
        if (token === null) throw new Error("CLAUDE_OAUTH_TOKEN_REQUIRED");
        return token;
      },
      ...(processFactory === undefined ? {} : { processFactory }),
    });
    if (qualification.status !== "qualified") return Object.freeze({ status: "unadmitted", inspection });
    return Object.freeze({ status: "ready", adapter, inspection, record });
  }
  return Object.freeze({ status: "unadmitted", inspection });
}
