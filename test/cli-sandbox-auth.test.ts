import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { claudeCliSandboxPolicy, claudeCliProcessFactory, seatbeltAvailable } from "../src/cli/sandbox.ts";
import { readClaudeOAuthToken, claudeAuthStatus } from "../src/cli/auth.ts";
import { SqliteAccountLeases } from "../src/accounts.ts";
import { openAccountDatabase } from "../src/sqlite-port.ts";
import { createCapabilityProfile } from "../src/capabilities.ts";
import { runCliTurn } from "../src/cli/run.ts";
import type { AgentTaskAdapter, AgentTaskExecutionRequest } from "../src/task-runtime.ts";

async function stateRoot(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agentmixer-cli-auth-")));
  await chmod(dir, 0o700);
  return dir;
}

describe("cli claude seatbelt policy", () => {
  const base = { executable: "/opt/run/provider", scratch: "/opt/run/scratch", accountHome: "/var/acct" };

  test("policy denies by default and grants only the snapshot, scratch, account and system reads", () => {
    const policy = claudeCliSandboxPolicy(base);
    expect(policy).toContain("(deny default)");
    expect(policy).toContain(`(allow process-exec (literal "${base.executable}"))`);
    expect(policy).toContain(`(subpath "${base.scratch}")`);
    expect(policy).toContain(`(subpath "${base.accountHome}")`);
    // No credential or shell-service grants reach the provider.
    for (const banned of ["securityd", "SecurityServer", "keychain", "process-exec*"]) expect(policy).not.toContain(banned);
    // exec is pinned to the snapshot literal only.
    expect(policy.match(/process-exec/gu)?.length).toBe(1);
  });

  test("policy embeds the per-user claude tmp dir and rejects nested layouts", () => {
    const policy = claudeCliSandboxPolicy(base);
    expect(policy).toContain(`/private/tmp/claude-${process.getuid!()}`);
    expect(() => claudeCliSandboxPolicy({ ...base, executable: `${base.scratch}/provider` })).toThrow("CLI_SANDBOX_LAYOUT_INVALID");
    expect(() => claudeCliSandboxPolicy({ ...base, scratch: `${base.accountHome}/scratch` })).toThrow("CLI_SANDBOX_LAYOUT_INVALID");
    expect(() => claudeCliSandboxPolicy({ executable: "relative/bin", scratch: base.scratch, accountHome: base.accountHome })).toThrow("CLI_SANDBOX_PATH_INVALID");
  });

  test("factory is darwin-gated and never claims availability off it", async () => {
    if (process.platform === "darwin") {
      expect(typeof claudeCliProcessFactory(base.accountHome)).toBe("function");
      expect(await seatbeltAvailable()).toBe(true);
    } else {
      expect(claudeCliProcessFactory(base.accountHome)).toBeUndefined();
      expect(await seatbeltAvailable()).toBe(false);
    }
  });
});

describe("cli subscription token custody", () => {
  test("missing or malformed token reports signed out without reading secrets", async () => {
    const root = await stateRoot();
    expect(await readClaudeOAuthToken(root)).toBeNull();
    expect((await claudeAuthStatus(root, null as never)).loggedIn).toBe(false);
    await writeFile(join(root, "claude-oauth-token"), "not-a-token\n");
    expect(await readClaudeOAuthToken(root)).toBeNull();
    await writeFile(join(root, "claude-oauth-token"), `sk-ant-oat01-${"x".repeat(64)}\n`);
    const token = await readClaudeOAuthToken(root);
    expect(token).toBe(`sk-ant-oat01-${"x".repeat(64)}`);
    const status = await claudeAuthStatus(root, null as never);
    expect(status.loggedIn).toBe(true);
    expect(status.authMethod).toBe("subscription-token");
  });
});

describe("cli lease recovery", () => {
  const profile = createCapabilityProfile({ id: "synthetic-cli", version: 1, tools: [] });
  const route = { id: "claude-subscription", provider: "claude" as const, authentication: "subscription" as const };

  function adapter(output: string): AgentTaskAdapter {
    const runtime = { version: "synthetic", digest: "a".repeat(64) };
    return Object.freeze({
      route, runtime,
      qualification: { status: "qualified" as const, route, profile: { id: profile.id, version: profile.version, digest: profile.digest },
        runtimeVersion: runtime.version, runtimeDigest: runtime.digest, evidenceDigest: "b".repeat(64), expiresAt: 9_000_000_000_000,
        controls: { noCommandTools: true as const, exactToolInventory: true as const, workspaceReadIsolation: true as const, workspaceWriteIsolation: true as const,
          isolatedConfiguration: true as const, authOutsideWorkspace: true as const, hostBrokerOnly: true as const } },
      async run(request: AgentTaskExecutionRequest) {
        return Object.freeze({ route: request.route, accountId: request.accountId, workspaceId: request.workspaceId,
          runId: request.runId, profile: request.profile, model: request.model, runtime: request.runtime, accountLease: request.accountLease,
          output, usage: Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null }),
          outcome: Object.freeze({ status: "completed" as const, code: null }) });
      },
      async stop(request: AgentTaskExecutionRequest) {
        return Object.freeze({ route: request.route, accountId: request.accountId, workspaceId: request.workspaceId,
          runId: request.runId, profile: request.profile, model: request.model, runtime: request.runtime, accountLease: request.accountLease,
          processStopped: true as const, controllersStopped: true as const, joined: true as const,
          stoppedAtUnixMs: Date.now(), proofDigest: "0".repeat(64) });
      },
    });
  }

  async function leases() {
    const db = await openAccountDatabase(join(await stateRoot(), "account-leases.sqlite"));
    return { store: new SqliteAccountLeases(db), db };
  }

  test("a lease held by a provably dead run is recovered and the retry succeeds", async () => {
    const { store, db } = await leases();
    try {
      store.acquire({ provider: "claude", accountId: "local", owner: "run_deadbeefdeadbeef00", now: Date.now(), ttlMs: 60_000 });
      const result = await runCliTurn({ adapter: adapter("ok"), leases: store, profile, accountId: "local",
        workspaceId: "w", model: "m", prompt: "hi", prior: [], signal: AbortSignal.timeout(30_000) });
      expect(result.output).toBe("ok");
      expect(store.inspect!("claude", "local")).toBeNull();
    } finally { db.close(); }
  });

  test("a lease held by a live run process retains custody", async () => {
    const { store, db } = await leases();
    const owner = "run_livetestowner000000";
    // A live process whose argv carries the run path marker defeats recovery.
    const alive = spawn("bash", ["-c", `exec -a '/state/claude-run-${owner}/provider' sleep 30`], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      store.acquire({ provider: "claude", accountId: "local", owner, now: Date.now(), ttlMs: 60_000 });
      await expect(runCliTurn({ adapter: adapter("ok"), leases: store, profile, accountId: "local",
        workspaceId: "w", model: "m", prompt: "hi", prior: [], signal: AbortSignal.timeout(30_000) }))
        .rejects.toThrow("ACCOUNT_PROCESS_STOP_UNPROVEN");
      expect(store.inspect!("claude", "local")?.owner).toBe(owner);
    } finally { alive.kill("SIGKILL"); db.close(); }
  });
});
