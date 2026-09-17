import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

import { createCapabilityBroker, type CapabilityBroker, type CapabilityProfile } from "../capabilities.ts";
import type { AccountLeaseStore } from "../accounts.ts";
import { runAgentTask, type AgentTaskAdapter, type AgentTaskResult } from "../task-runtime.ts";
import { boundedText, identifier } from "../validation.ts";

import type { CliTranscriptEntry } from "./sessions.ts";

const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_RUN_MS = 10 * 60 * 1000;
const MAX_CLEANUP_MS = 30 * 1000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export type CliRunInput = Readonly<{
  adapter: AgentTaskAdapter;
  leases: AccountLeaseStore;
  profile: CapabilityProfile;
  accountId: string;
  workspaceId: string;
  model: string;
  prompt: string;
  prior: readonly CliTranscriptEntry[];
  signal: AbortSignal;
  onTool?: (name: string, input: unknown) => void;
  now?: () => number;
}>;

export type CliRunResult = Readonly<{
  result: AgentTaskResult;
  output: string | null;
}>;

function promptWithContext(prompt: string, prior: readonly CliTranscriptEntry[]): string {
  if (prior.length === 0) return prompt;
  const lines: string[] = ["Prior conversation in this session (recorded locally):"];
  let bytes = 0;
  const selected: string[] = [];
  for (const entry of [...prior].reverse()) {
    const line = `${entry.role === "user" ? "User" : "AgentMixer"}: ${entry.text}`;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > MAX_CONTEXT_BYTES || selected.length >= 40) break;
    selected.unshift(line);
  }
  return [...lines, ...selected, "", "Current request:", prompt].join("\n");
}

/** A previous run that failed to prove provider-process exit retains account
 * custody ("no automatic TTL recovery"). The lease owner is the owning runId,
 * and a live run process always has `<stateRoot>/<provider>-run-<runId>/…` in
 * its argv — pgrep on that exact string is independent stop evidence. No
 * match means the owning process is gone and the lease can be released. */
async function recoverHeldLease(leases: AccountLeaseStore, provider: "claude" | "codex" | "devin", accountId: string): Promise<void> {
  if (leases.inspect === undefined || leases.recover === undefined) return;
  const held = leases.inspect(provider, accountId);
  if (held === null) return;
  await leases.recover(held, async (lease) => {
    const probe = spawnSync("pgrep", ["-f", `${provider}-run-${lease.owner}`], { timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    return probe.status === 1;
  });
}

/** One interactive turn: admit the exact broker bound to this run, hand the
 * model the provider task, and return its completion plus stop evidence. The
 * broker closes and the account lease releases inside runAgentTask. */
export async function runCliTurn(input: CliRunInput): Promise<CliRunResult> {
  const workspaceId = identifier(input.workspaceId);
  const accountId = identifier(input.accountId);
  const model = Object.freeze({ id: boundedText(input.model, 160), reasoningEffort: null, serviceTier: null });
  const profile = input.profile;
  const prompt = boundedText(promptWithContext(input.prompt, input.prior), 512 * 1024);
  let active = true;
  // Each attempt owns a fresh runId and broker: a failed attempt closes its
  // broker and may retain its own run dir, so nothing may be shared across tries.
  const attempt = () => {
    const runId = `run_${randomBytes(12).toString("hex")}`;
    const inner = createCapabilityBroker({
      profile, workspaceId, runId,
      isActive: () => active && !input.signal.aborted,
      signal: input.signal,
    });
    const broker: CapabilityBroker = Object.freeze({
      profile: inner.profile, workspaceId: inner.workspaceId, runId: inner.runId,
      assertActive: () => inner.assertActive(),
      revoke: () => inner.revoke(),
      close: () => inner.close(),
      invoke: (name: unknown, callInput: unknown) => {
        if (typeof name === "string") input.onTool?.(name, callInput);
        return inner.invoke(name, callInput);
      },
    });
    return runAgentTask(
      { adapters: [input.adapter], leases: input.leases, now: input.now ?? Date.now },
      {
        route: input.adapter.route, accountId, workspaceId, runId,
        profile: Object.freeze({ id: profile.id, version: profile.version, digest: profile.digest }),
        model, purpose: "cli-turn", prompt,
        limits: Object.freeze({ maxRunMs: MAX_RUN_MS, maxCleanupMs: MAX_CLEANUP_MS, maxOutputBytes: MAX_OUTPUT_BYTES }),
        signal: input.signal,
      },
      broker,
    );
  };
  try {
    try {
      const result = await attempt();
      return Object.freeze({ result, output: result.output });
    } catch (error) {
      // One recovery shot: a held lease from a provably dead run is released,
      // then retried; anything else propagates.
      if (!(error instanceof Error) || error.message !== "ACCOUNT_BUSY_OR_RECOVERY_REQUIRED") throw error;
      await recoverHeldLease(input.leases, input.adapter.route.provider, accountId);
      const result = await attempt();
      return Object.freeze({ result, output: result.output });
    }
  } finally {
    active = false;
  }
}
