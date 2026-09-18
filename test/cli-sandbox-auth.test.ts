import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { claudeCliSandboxPolicy, claudeCliProcessFactory, seatbeltAvailable, type CliLinuxSandbox } from "../src/cli/sandbox.ts";
import { planBwrapPolicy, type OsSandboxSpec } from "../src/os-sandbox.ts";
import { readClaudeOAuthToken, claudeAuthStatus } from "../src/cli/auth.ts";
import type { CliBinaryInspection } from "../src/cli/binaries.ts";
import { SqliteAccountLeases } from "../src/accounts.ts";
import { openAccountDatabase } from "../src/sqlite-port.ts";
import { createCapabilityProfile } from "../src/capabilities.ts";
import { runCliTurn } from "../src/cli/run.ts";
import type { AgentTaskAdapter, AgentTaskExecutionRequest } from "../src/task-runtime.ts";

async function stateRoot(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "xcb-cli-auth-")));
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

describe("cli claude linux sandbox", () => {
  test("linux without a prepared sandbox never produces a factory", () => {
    expect(claudeCliProcessFactory("/var/acct", undefined, "linux")).toBeUndefined();
    expect(claudeCliProcessFactory("/var/acct", undefined, "freebsd")).toBeUndefined();
  });

  test("linux factory plans through the forwarder, persists the policy, and defaults the sandbox env", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "xcb-cli-linux-")));
    try {
      const runDir = join(dir, "run"), account = join(dir, "acct");
      await mkdir(runDir, { recursive: true }); await mkdir(account, { recursive: true });
      const executable = join(runDir, "provider");
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
      const socket = join(dir, "egress.sock"), runtime = join(dir, "rt"), script = join(dir, "fwd.js");
      // /bin/true exists on every host the tests run on; the bwrap argv it
      // receives is irrelevant since it exits immediately.
      const wrapper = "/bin/true";
      let specSeen: OsSandboxSpec | undefined;
      let envSeen: Readonly<Record<string, string>> | undefined;
      const linux: CliLinuxSandbox = {
        socketPath: socket,
        plan(input) {
          specSeen = { platform: "linux", executable: input.executable, scratch: input.scratch,
            accountHome: input.accountHome, network: "provider-tcp443-dns", egressSocket: socket,
            egressForward: { runtime, script, port: 48123 }, policyPath: input.policyPath };
          const real = planBwrapPolicy(specSeen, wrapper);
          return { ...real, wrap(w) { envSeen = w.env; return real.wrap(w); } };
        },
        close: () => Promise.resolve({} as never),
      };
      const factory = claudeCliProcessFactory(account, linux, "linux")!;
      expect(typeof factory).toBe("function");
      const handle = factory({ executable, args: ["--serve"], env: { MARKER: "1" }, cwd: runDir,
        onViolation: () => {}, binding: { runId: "r", accountId: "a", workspaceId: "w" } });
      await handle.stopAndJoin().catch(() => {});
      // The policy artifact lands outside the writable scratch, recording the
      // forwarder entry point in canonical form.
      const policy = JSON.parse(await readFile(join(runDir, "sandbox.json"), "utf8"));
      expect(policy.backend).toBe("bwrap");
      expect(policy.egress).toEqual({ socket, protocol: "connect-tcp443",
        forwarder: { runtime, script, port: 48123, protocol: "http-connect-loopback" } });
      expect(specSeen!.scratch).toBe(join(runDir, "scratch"));
      expect(specSeen!.accountHome).toBe(account);
      // --clearenv drops everything absent: PATH/HOME/TMPDIR default in, and
      // the adapter-closed map rides through.
      expect(envSeen!.PATH).toBe("/usr/bin:/bin");
      expect(envSeen!.HOME).toBe(join(runDir, "scratch"));
      expect(envSeen!.TMPDIR).toBe(join(runDir, "scratch"));
      expect(envSeen!.MARKER).toBe("1");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("cli subscription token custody", () => {
  test("split login tokens never reach either terminal output stream", async () => {
    const root = await stateRoot();
    const token = "sk-ant-oat01-synthetic_login_credential_not_for_service_use";
    const executable = join(root, "provider");
    const chunks = token.match(/.{1,9}/gu)!;
    await writeFile(executable, "#!/bin/sh\n" + chunks.map(chunk => `printf '%s' '${chunk}'\nsleep 0.02\n`).join("")
      + "printf '\\n'\n" + chunks.map(chunk => `printf '%s' '${chunk}' >&2\nsleep 0.02\n`).join("") + "printf '\\n' >&2\n", { mode: 0o700 });
    const inspection: CliBinaryInspection = { provider: "claude", executablePath: executable,
      version: "2.1.268", sha256: "0".repeat(64), pinnedSha256: null, versionMatches: true, digestMatches: true };
    const module = new URL("../src/cli/auth.ts", import.meta.url).href;
    const script = `import { claudeLogin } from ${JSON.stringify(module)}; await claudeLogin(${JSON.stringify(root)}, ${JSON.stringify(inspection)});`;
    try {
      const child = Bun.spawn([process.execPath, "--eval", script], {
        cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(0);
      expect(stdout.includes(token)).toBe(false);
      expect(stderr.includes(token)).toBe(false);
      expect(await readClaudeOAuthToken(root)).toBe(token);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("missing or malformed token reports signed out without reading secrets", async () => {
    const root = await stateRoot();
    expect(await readClaudeOAuthToken(root)).toBeNull();
    expect((await claudeAuthStatus(root)).loggedIn).toBe(false);
    await writeFile(join(root, "claude-oauth-token"), "not-a-token\n");
    expect(await readClaudeOAuthToken(root)).toBeNull();
    await writeFile(join(root, "claude-oauth-token"), `sk-ant-oat01-${"x".repeat(64)}\n`);
    const token = await readClaudeOAuthToken(root);
    expect(token).toBe(`sk-ant-oat01-${"x".repeat(64)}`);
    const status = await claudeAuthStatus(root);
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

  test("an absent argv marker alone cannot recover a held lease", async () => {
    const { store, db } = await leases();
    try {
      const held = store.acquire({ provider: "claude", accountId: "local", owner: "run_deadbeefdeadbeef00", now: Date.now(), ttlMs: 60_000 });
      await expect(runCliTurn({ adapter: adapter("ok"), leases: store, profile, accountId: "local",
        workspaceId: "w", model: "m", prompt: "hi", prior: [], signal: AbortSignal.timeout(30_000) }))
        .rejects.toThrow("ACCOUNT_PROCESS_STOP_UNPROVEN");
      expect(store.inspect!("claude", "local")).toEqual(held);
    } finally { db.close(); }
  });

  test("independently witnessed stop evidence permits one fenced recovery", async () => {
    const { store, db } = await leases();
    const stopped = Bun.spawn(["/usr/bin/true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const exit = await stopped.exited;
    try {
      const held = store.acquire({ provider: "claude", accountId: "local", owner: "run_witnessed_fixture", now: Date.now(), ttlMs: 60_000 });
      let proofs = 0;
      const result = await runCliTurn({ adapter: adapter("ok"), leases: store, profile, accountId: "local",
        workspaceId: "w", model: "m", prompt: "hi", prior: [], signal: AbortSignal.timeout(30_000),
        proveAccountStopped: async lease => { proofs++; expect(lease).toEqual(held); return exit === 0; } });
      expect(result.output).toBe("ok");
      expect(proofs).toBe(1);
      expect(store.inspect!("claude", "local")).toBeNull();
    } finally { db.close(); }
  });

  test("a rejected stop witness cannot release custody", async () => {
    const { store, db } = await leases();
    try {
      const held = store.acquire({ provider: "claude", accountId: "local", owner: "run_unknown_fixture", now: Date.now(), ttlMs: 60_000 });
      await expect(runCliTurn({ adapter: adapter("ok"), leases: store, profile, accountId: "local",
        workspaceId: "w", model: "m", prompt: "hi", prior: [], signal: AbortSignal.timeout(30_000),
        proveAccountStopped: async () => false })).rejects.toThrow("ACCOUNT_PROCESS_STOP_UNPROVEN");
      expect(store.inspect!("claude", "local")).toEqual(held);
    } finally { db.close(); }
  });

  test("a live pre-spawn owner keeps its lease when another terminal attempts a turn", async () => {
    const { store, db } = await leases();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const base = adapter("first");
    const waiting: AgentTaskAdapter = { ...base, async run(request, broker) { await gate; return base.run(request, broker); } };
    const input = { leases: store, profile, accountId: "local", workspaceId: "w", model: "m", prompt: "hi", prior: [], signal: AbortSignal.timeout(30_000) };
    const first = runCliTurn({ ...input, adapter: waiting });
    try {
      const held = store.inspect!("claude", "local");
      expect(held).not.toBeNull();
      await expect(runCliTurn({ ...input, adapter: adapter("second") })).rejects.toThrow("ACCOUNT_PROCESS_STOP_UNPROVEN");
      expect(store.inspect!("claude", "local")).toEqual(held);
    } finally { finish(); await first; db.close(); }
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
