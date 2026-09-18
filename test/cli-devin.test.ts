import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, Socket, type Server } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { cliBinaryCandidates, CLI_DEVIN_ENV } from "../src/cli/binaries.ts";
import { CLI_DEVIN_MAX_MAJOR, CLI_DEVIN_MIN_VERSION, cliDevinRuntimeIdentity, devinAuthStatus,
  devinCliVersionMatches, devinManagedEnv } from "../src/cli/devin.ts";
import { devinCliProcessFactory, devinCliSandboxPolicy, type DevinCliLinuxSandbox } from "../src/cli/sandbox.ts";
import { planBwrapPolicy, type OsSandboxSpec } from "../src/os-sandbox.ts";
import { startDevinToolRelay } from "../src/devin-mcp.ts";
import { createCapabilityBroker, createCapabilityProfile } from "../src/capabilities.ts";
import type { CliBinaryInspection } from "../src/cli/binaries.ts";

async function dir(prefix = "agentmixer-devin-") {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(root, 0o700);
  return root;
}

describe("devin cli version admission", () => {
  test("admits the floor and newer same-major versions only", () => {
    expect(devinCliVersionMatches(CLI_DEVIN_MIN_VERSION)).toBe(true);
    expect(devinCliVersionMatches("3000.10.31")).toBe(true);
    expect(devinCliVersionMatches(`${CLI_DEVIN_MAX_MAJOR}.99.99`)).toBe(true);
    // Older minors, other majors and malformed strings are all refused.
    expect(devinCliVersionMatches("3000.10.0")).toBe(false);
    expect(devinCliVersionMatches("3000.9.99")).toBe(false);
    expect(devinCliVersionMatches("3001.0.0")).toBe(false);
    expect(devinCliVersionMatches("2999.99.99")).toBe(false);
    expect(devinCliVersionMatches("devin")).toBe(false);
    expect(devinCliVersionMatches("3000.10")).toBe(false);
    expect(devinCliVersionMatches("3000.10.31-beta..")).toBe(false);
  });

  test("runtime identity binds the version line and executable digest", () => {
    const sha = "a".repeat(64);
    const identity = cliDevinRuntimeIdentity({ executableSha256: sha, cliVersion: "3000.10.31" });
    expect(identity.version).toBe("devin-acp/1;devin-cli/3000.10.31;task");
    expect(identity.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(cliDevinRuntimeIdentity({ executableSha256: "b".repeat(64), cliVersion: "3000.10.31" }).digest).not.toBe(identity.digest);
  });
});

describe("devin binary discovery", () => {
  test("env pin wins, then PATH, then the managed install locations", () => {
    const env = (name: string) => name === CLI_DEVIN_ENV ? "/pinned/devin" : name === "PATH" ? "/opt/bin" : undefined;
    const candidates = cliBinaryCandidates("devin", env);
    expect(candidates[0]).toBe("/pinned/devin");
    expect(candidates).toContain(join("/opt/bin", "devin"));
    expect(candidates.some((candidate) => candidate.includes(".local"))).toBe(true);
  });
});

describe("devin managed environment", () => {
  test("every credential and cache root resolves inside the managed home", () => {
    const env = devinManagedEnv("/var/managed-home");
    expect(env.HOME).toBe("/var/managed-home");
    expect(env.XDG_DATA_HOME).toBe("/var/managed-home/.local/share");
    expect(env.XDG_CONFIG_HOME).toBe("/var/managed-home/.config");
    expect(env.XDG_CACHE_HOME).toBe("/var/managed-home/.cache");
    expect(env.TMPDIR).toBe("/var/managed-home/tmp");
    // Nothing references the ambient user home.
    expect(JSON.stringify(env)).not.toContain(process.env.HOME ?? "\0");
  });
});

describe("devin auth status", () => {
  test("a fresh managed home reports signed out", async () => {
    const root = await dir();
    try {
      // Stub devin binary: `auth status` prints the logged-out report.
      const stub = join(root, "devin");
      await writeFile(stub, "#!/bin/sh\nprintf 'Not logged in.\\n'\n", { mode: 0o755 });
      const inspection: CliBinaryInspection = { provider: "devin", executablePath: stub,
        version: "3000.10.31", sha256: "a".repeat(64), pinnedSha256: null, versionMatches: true, digestMatches: true };
      const status = await devinAuthStatus(root, inspection);
      expect(status.loggedIn).toBe(false);
      expect(status.planType).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("a logged-in report parses the plan line", async () => {
    const root = await dir();
    try {
      const stub = join(root, "devin");
      await writeFile(stub, "#!/bin/sh\nprintf 'Logged in (via Devin).\\n\\nAccount:\\n  Plan:              Max\\n'\n", { mode: 0o755 });
      const inspection: CliBinaryInspection = { provider: "devin", executablePath: stub,
        version: "3000.10.31", sha256: "a".repeat(64), pinnedSha256: null, versionMatches: true, digestMatches: true };
      const status = await devinAuthStatus(root, inspection);
      expect(status.loggedIn).toBe(true);
      expect(status.planType).toBe("Max");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("cli devin seatbelt policy", () => {
  const base = { executable: "/opt/run/provider", bridgeExecutable: "/opt/run/bunrt",
    scratch: "/opt/run/scratch", accountHome: "/var/acct", workspace: "/var/work" };

  test("denies by default; exec is pinned to the snapshot plus the bridge runtime", () => {
    const policy = devinCliSandboxPolicy(base);
    expect(policy).toContain("(deny default)");
    expect(policy).toContain(`(literal "${base.executable}")`);
    expect(policy).toContain(`(literal "${base.bridgeExecutable}")`);
    for (const banned of ["securityd", "keychain", "process-exec*"]) expect(policy).not.toContain(banned);
    expect(policy.match(/process-exec/gu)?.length).toBe(1);
  });

  test("workspace is read-only; writes stay confined to scratch and account home", () => {
    const policy = devinCliSandboxPolicy(base);
    // The workspace appears only under file-read*, never a write rule.
    const writeRules = policy.split("\n").filter(line => line.includes("file-write*") && !line.includes("/dev/"));
    expect(writeRules).toHaveLength(1);
    expect(writeRules[0]).toContain(`(subpath "${base.scratch}")`);
    expect(writeRules[0]).toContain(`(subpath "${base.accountHome}")`);
    expect(writeRules[0]).not.toContain(base.workspace);
    expect(policy).toContain(`(subpath "${base.workspace}")`);
    // The MCP bridge reaches the host relay over loopback; remote egress is 443.
    // Seatbelt names loopback "localhost" — a literal "127.0.0.1" host filter is
    // a compile-time rejection, not a narrower grant.
    expect(policy).toContain('(remote tcp "localhost:*")');
    expect(policy).toContain('(remote tcp "*:443")');
  });

  test("rejects nested and uncanonical layouts", () => {
    expect(() => devinCliSandboxPolicy({ ...base, executable: `${base.scratch}/provider` })).toThrow("CLI_SANDBOX_LAYOUT_INVALID");
    expect(() => devinCliSandboxPolicy({ ...base, workspace: `${base.scratch}/work` })).toThrow("CLI_SANDBOX_LAYOUT_INVALID");
    expect(() => devinCliSandboxPolicy({ ...base, scratch: `${base.workspace}/scratch` })).toThrow("CLI_SANDBOX_LAYOUT_INVALID");
    expect(() => devinCliSandboxPolicy({ ...base, bridgeExecutable: "relative/bun" })).toThrow("CLI_SANDBOX_PATH_INVALID");
  });
});

describe("cli devin process factory", () => {
  test("linux without a prepared sandbox never produces a factory", () => {
    expect(devinCliProcessFactory({ stateRoot: "/state", accountHome: "/acct",
      workspace: "/work", bridgeExecutable: "/opt/bun" }, "linux")).toBeUndefined();
    expect(devinCliProcessFactory({ stateRoot: "/state", accountHome: "/acct",
      workspace: "/work", bridgeExecutable: "/opt/bun" }, "freebsd")).toBeUndefined();
  });

  test("linux factory snapshots the executable under the run marker, plans service forwarding and defaults env", async () => {
    const root = await dir();
    try {
      const state = join(root, "state"), account = join(root, "acct"), workspace = join(root, "work"), bridge = join(root, "bunrt");
      for (const target of [state, account, workspace]) await mkdir(target, { recursive: true });
      const hostExe = join(root, "host-devin");
      await writeFile(hostExe, "devin-bytes", { mode: 0o755 });
      await writeFile(bridge, "bridge-bytes", { mode: 0o755 });
      const socket = join(root, "egress.sock"), service = join(root, "service.sock"),
        runtime = join(root, "rt"), script = join(root, "fwd.js");
      let specSeen: OsSandboxSpec | undefined;
      let envSeen: Readonly<Record<string, string>> | undefined;
      const linux: DevinCliLinuxSandbox = {
        socketPath: socket, serviceSocketPath: service, servicePort: 48124,
        plan(input) {
          specSeen = { platform: "linux", executable: input.executable, scratch: input.scratch,
            accountHome: input.accountHome, readOnlyPaths: [input.workspace],
            network: "provider-tcp443-dns", egressSocket: socket,
            egressForward: { runtime, script, port: 48123, service: { socket: service, port: 48124 } },
            policyPath: input.policyPath };
          const real = planBwrapPolicy(specSeen, "/bin/true");
          return { ...real, wrap(w) { envSeen = w.env; return real.wrap(w); } };
        },
        close: () => Promise.resolve({} as never),
      };
      const factory = devinCliProcessFactory({ stateRoot: state, accountHome: account,
        workspace, bridgeExecutable: bridge, linux }, "linux")!;
      const handle = factory({ executable: hostExe, args: ["acp"], cwd: workspace,
        env: { HOME: account }, onViolation: () => {},
        binding: { runId: "r1", accountId: "a", workspaceId: "w" } });
      await handle.stopAndJoin().catch(() => {});
      const runRoot = join(state, "devin-run-r1");
      // The snapshot copy carries the run-id marker for lease recovery.
      expect(await readFile(join(runRoot, "provider"), "utf8")).toBe("devin-bytes");
      expect(specSeen!.executable).toBe(join(runRoot, "provider"));
      expect(specSeen!.scratch).toBe(join(runRoot, "scratch"));
      expect(specSeen!.accountHome).toBe(account);
      expect(specSeen!.readOnlyPaths).toEqual([workspace]);
      const policy = JSON.parse(await readFile(join(runRoot, "sandbox.json"), "utf8"));
      expect(policy.backend).toBe("bwrap");
      expect(policy.egress.forwarder.service).toEqual({ socket: service, port: 48124 });
      expect(envSeen!.PATH).toBe("/usr/bin:/bin");
      expect(envSeen!.HOME).toBe(account);
      expect(envSeen!.TMPDIR).toBe(join(runRoot, "scratch"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("bwrap service forward planning", () => {
  const base = (root: string): OsSandboxSpec => ({ platform: "linux",
    executable: join(root, "provider"), scratch: join(root, "scratch"), accountHome: join(root, "acct"),
    network: "provider-tcp443-dns", egressSocket: join(root, "egress.sock"),
    egressForward: { runtime: join(root, "rt"), script: join(root, "fwd.js"), port: 48123,
      service: { socket: join(root, "service.sock"), port: 48124 } },
    policyPath: join(root, "sandbox.json") });

  test("the service socket binds rw, records in policy and carries the descriptor positional", async () => {
    const root = await dir();
    try {
      const spec = base(root);
      const plan = planBwrapPolicy(spec, "/bin/true");
      const args = plan.wrap({ args: ["acp"], env: {}, cwd: "/" }).args;
      const tail = args.slice(args.indexOf("--") + 1);
      expect(tail).toEqual([join(root, "rt"), join(root, "fwd.js"), join(root, "egress.sock"),
        "48123", "-", "-", `${join(root, "service.sock")}:48124`, "--", spec.executable, "acp"]);
      const bindTargets = args.flatMap((value, index) =>
        value === "--bind" || value === "--ro-bind" ? [`${value} ${args[index + 1]}`] : []);
      expect(bindTargets).toContain(`--bind ${join(root, "service.sock")}`);
      const policy = JSON.parse(plan.policy);
      expect(policy.egress.forwarder.service).toEqual({ socket: join(root, "service.sock"), port: 48124 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects a service port colliding with egress and a socket inside writable roots", async () => {
    const root = await dir();
    try {
      expect(() => planBwrapPolicy({ ...base(root),
        egressForward: { runtime: join(root, "rt"), script: join(root, "fwd.js"), port: 48123,
          service: { socket: join(root, "service.sock"), port: 48123 } } }, "/bin/true"))
        .toThrow("OS_SANDBOX_EGRESS_PORT_INVALID");
      expect(() => planBwrapPolicy({ ...base(root),
        egressForward: { runtime: join(root, "rt"), script: join(root, "fwd.js"), port: 48123,
          service: { socket: join(root, "scratch", "service.sock"), port: 48124 } } }, "/bin/true"))
        .toThrow("OS_SANDBOX_LAYOUT_INVALID");
      expect(() => planBwrapPolicy({ ...base(root), readWritePaths: [join(root, "rw")],
        egressForward: { runtime: join(root, "rt"), script: join(root, "fwd.js"), port: 48123,
          service: { socket: join(root, "rw", "service.sock"), port: 48124 } } }, "/bin/true"))
        .toThrow("OS_SANDBOX_LAYOUT_INVALID");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("readWrite/protected/hidden paths bind in shadow order and record in policy", async () => {
    const root = await dir();
    try {
      const spec: OsSandboxSpec = { platform: "linux", executable: join(root, "provider"),
        scratch: join(root, "scratch"), network: "denied", policyPath: join(root, "sandbox.json"),
        readWritePaths: [join(root, "rw")], protectedPaths: [join(root, "rw", "keep")],
        hiddenPaths: [join(root, "rw", "secret")] };
      const plan = planBwrapPolicy(spec, "/bin/true");
      const args = plan.wrap({ args: [], env: {}, cwd: "/" }).args;
      const rw = args.indexOf(join(root, "rw")), ro = args.indexOf(join(root, "rw/keep")), mask = args.indexOf(join(root, "rw/secret"));
      expect(rw).toBeGreaterThan(-1); expect(ro).toBeGreaterThan(rw); expect(mask).toBeGreaterThan(ro);
      const policy = JSON.parse(plan.policy);
      expect(policy.masked).toEqual([join(root, "rw/secret")]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("loopback-forwarder service relay", () => {
  const FORWARDER = fileURLToPath(new URL("../sandbox/loopback-forwarder.cjs", import.meta.url));

  function unixEcho(socketPath: string): Promise<Server> {
    const server = createServer((inbound: Socket) => inbound.pipe(inbound));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve(server));
    });
  }

  test("rejects a malformed invocation and a bad service descriptor", async () => {
    const root = await dir();
    try {
      for (const args of [
        ["not-absolute", "1", "-", "-", "--", "/bin/true"],
        [join(root, "e.sock"), "abc", "-", "-", "--", "/bin/true"],
        [join(root, "e.sock"), "1", "-", "-", "relative:2", "--", "/bin/true"],
        [join(root, "e.sock"), "1", "-", "-", join(root, "s.sock"), "--", "/bin/true"],
      ]) {
        const child = spawn(process.execPath, [FORWARDER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        const code = await new Promise<number>(resolve => child.once("exit", status => resolve(status ?? -1)));
        expect(code).toBe(2);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("pipes namespace TCP to the host service socket and keeps CONNECT egress intact", async () => {
    const root = await dir();
    const service = await unixEcho(join(root, "service.sock"));
    const bridge = await unixEcho(join(root, "egress.sock"));
    const forwarder = spawn(process.execPath,
      [FORWARDER, join(root, "egress.sock"), "49381", "-", "-", `${join(root, "service.sock")}:49382`, "--", "/bin/sleep", "30"],
      { stdio: ["ignore", "pipe", "pipe"] });
    try {
      // Wait for the service listener to report ready.
      const deadline = Date.now() + 10_000;
      let listening = false;
      while (Date.now() < deadline && !listening) {
        listening = await new Promise(resolve => {
          const probe = new Socket();
          probe.once("connect", () => { probe.destroy(); resolve(true); });
          probe.once("error", () => resolve(false));
          probe.connect(49382, "127.0.0.1");
        });
        if (!listening) await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(listening).toBe(true);
      // Bytes sent to the service port come back from the unix echo peer.
      const echoed = await new Promise<string>((resolve, reject) => {
        const client = new Socket();
        client.once("error", reject);
        client.connect(49382, "127.0.0.1", () => client.write("ping"));
        client.once("data", chunk => { resolve(chunk.toString("utf8")); client.destroy(); });
      });
      expect(echoed).toBe("ping");
    } finally {
      forwarder.kill("SIGKILL");
      service.close();
      bridge.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("devin tool relay unix listener", () => {
  test("listens on the admitted socket, advertises the in-namespace port and reclaims a stale file", async () => {
    const root = await dir();
    try {
      const socketPath = join(root, "relay.sock");
      // A stale socket file is reclaimed — the connect probe fails and the
      // path is unlinked before bind.
      await writeFile(socketPath, "stale", { mode: 0o600 });
      const profile = createCapabilityProfile({ id: "devin.relay.fixture", version: 1, tools: [] });
      const broker = createCapabilityBroker({ profile, workspaceId: "w", runId: "r", isActive: () => true });
      const relay = await startDevinToolRelay({ broker, bridgeExecutable: "/bin/sh",
        listen: { socketPath, port: 48124 } });
      try {
        const env = relay.bridgeEnv();
        expect(env.XCB_MCP_RELAY).toMatch(/^http:\/\/127\.0\.0\.1:48124\//u);
        // The unix listener answers the manifest over the socket transport.
        const manifest = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const client = new Socket();
          client.connect(socketPath, () => {
            client.write(`GET ${new URL(env.XCB_MCP_RELAY!).pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${env.XCB_MCP_TOKEN}\r\nConnection: close\r\n\r\n`);
          });
          const chunks: Buffer[] = [];
          client.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          client.once("close", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = Number(/^HTTP\/1\.1 (\d+)/u.exec(text)?.[1]);
            resolve({ status, body: text });
          });
          client.once("error", reject);
        });
        expect(manifest.status).toBe(200);
        expect(manifest.body).toContain('"tools"');
      } finally { await relay.stop(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
