import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, openSync, closeSync, readSync, writeSync, fstatSync, lstatSync, realpathSync, rmSync, constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { planSeatbeltPolicy, planBwrapPolicy, createSandboxedProviderProcessFactory, verifyOsSandboxExecutable, type OsSandboxPlan } from "../os-sandbox.ts";
import { createEgressBridge, egressBridgeDialer, type EgressBridgeReceipt } from "../egress-bridge.ts";
import { finished } from "node:stream/promises";
import { identifier } from "../validation.ts";
import type { BoundedProviderProcess, BoundedProviderProcessFactory } from "../provider-process.ts";
import { canonicalizePrivatePath, assertPrivateStat } from "../private-file.ts";

const fail = (code: string): never => { throw new Error(code); };
function path(value: unknown): string {
  return canonicalizePrivatePath(value, { code: "CLI_SANDBOX_PATH_INVALID" });
}

/** Reviewed SBPL profile for one CLI Claude run, verified against Claude Code
 * under sandbox-exec. The model's whole tool surface is the in-process MCP
 * broker, so the OS policy grants: exec of the verified run snapshot only
 * (fork is allowed, but no other binary can be exec'd — the child's attempts
 * to spawn git/sh/security are denied and it continues without them),
 * read-only system runtime surface (dyld cryptexes, ICU, resolver config in
 * /etc, global preferences, zoneinfo), rw on the per-run scratch, the managed
 * auth directory and Claude's own per-user /tmp/claude-<uid> dir, and egress
 * on TCP 443 plus the system resolver and syslog sockets. Keychain and
 * securityd are deliberately absent — the subscription token arrives via
 * CLAUDE_CODE_OAUTH_TOKEN env, so no Mach credential service is needed.
 * Verified note: a denied process cwd makes the bun runtime report a
 * misleading "low max file descriptors" error, so cwd must resolve inside the
 * writable scratch subtree. Host-owned text, never model or settings input. */
export function claudeCliSandboxPolicy(input: { executable: string; scratch: string; accountHome: string }): string {
  const executable = path(input.executable), scratch = path(input.scratch), accountHome = path(input.accountHome);
  const inside = (inner: string, outer: string) => inner === outer || inner.startsWith(outer + "/");
  if (inside(executable, scratch) || inside(executable, accountHome) || inside(scratch, accountHome) || inside(accountHome, scratch)) {
    fail("CLI_SANDBOX_LAYOUT_INVALID");
  }
  const uid = process.getuid?.();
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) fail("CLI_SANDBOX_UID_INVALID");
  const claudeTmp = `/private/tmp/claude-${uid}`;
  const q = JSON.stringify;
  return `(version 1)
(deny default)
(allow process-exec (literal ${q(executable)}))
(allow process-fork)
(allow process-info* (target self))
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow file-ioctl (literal "/dev/null") (subpath "/dev/fd"))
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/dtracehelper") (subpath "/dev/fd"))
(allow file-read* (literal "/") (literal "/tmp") (literal "/etc") (literal "/var") (literal "/Library") (literal "/private/etc") (literal "/private/tmp") (literal "/private/var")
  (literal ${q(executable)})
  (subpath "/System") (subpath "/usr") (subpath "/Library/Preferences") (subpath "/Library/Apple") (subpath "/etc") (subpath "/private/etc") (subpath "/var/db/timezone") (subpath "/private/var/db/timezone"))
(allow file-map-executable (literal ${q(executable)}) (subpath "/System") (subpath "/usr"))
(allow file-read* file-write* (subpath ${q(scratch)}) (subpath ${q(accountHome)}) (subpath ${q(claudeTmp)}))
(allow file-read-metadata (path-ancestors ${q(executable)}) (path-ancestors ${q(scratch)}) (path-ancestors ${q(accountHome)}) (path-ancestors ${q(claudeTmp)}))
(allow network-outbound (literal "/private/var/run/mDNSResponder") (literal "/private/var/run/syslog") (remote tcp "*:443"))
`;
}

/** Reviewed SBPL profile for one CLI Devin run. Devin's ACP session keeps the
 * model's file surface on the host-brokered MCP relay, so the OS boundary is
 * Claude-shaped with these deltas: `process-exec` also admits the pinned
 * bridge runtime the agent spawns for the stdio MCP server, the consumer
 * workspace is bound *read-only* (all writes flow through the relay's
 * revision-checked `workspace.write`), and loopback TCP is admitted so the
 * in-process bridge can reach the host relay — same-user loopback services
 * are reachable to a same-uid process regardless, the port is per-run and
 * bearer-token gated. Devin's rustls stack additionally needs
 * `com.apple.trustd.agent` (SecTrustEvaluate) and
 * `com.apple.SystemConfiguration.configd` (system proxy lookup) or every
 * HTTPS call fails certificate verification — read-only system services,
 * not keychain item access; the Claude profile's ban on securityd stands.
 * Verified note inherited from the Claude profile: cwd
 * must resolve inside an accessible subtree. Host-owned text, never model or
 * settings input. */
export function devinCliSandboxPolicy(input: { executable: string; bridgeExecutable: string; scratch: string; accountHome: string; workspace: string }): string {
  const executable = path(input.executable), bridge = path(input.bridgeExecutable),
    scratch = path(input.scratch), accountHome = path(input.accountHome), workspace = path(input.workspace);
  const inside = (inner: string, outer: string) => inner === outer || inner.startsWith(outer + "/");
  if (inside(executable, scratch) || inside(executable, accountHome) || inside(executable, workspace)
    || inside(bridge, scratch) || inside(bridge, accountHome) || inside(bridge, workspace)
    || inside(scratch, accountHome) || inside(accountHome, scratch)
    || inside(scratch, workspace) || inside(accountHome, workspace) || inside(workspace, scratch) || inside(workspace, accountHome)) {
    fail("CLI_SANDBOX_LAYOUT_INVALID");
  }
  const uid = process.getuid?.();
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) fail("CLI_SANDBOX_UID_INVALID");
  const devinTmp = `/private/tmp/devin-${uid}`;
  const q = JSON.stringify;
  return `(version 1)
(deny default)
(allow process-exec (literal ${q(executable)}) (literal ${q(bridge)}))
(allow process-fork)
(allow process-info* (target self))
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.trustd.agent") (global-name "com.apple.SystemConfiguration.configd"))
(allow file-ioctl (literal "/dev/null") (subpath "/dev/fd"))
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/dtracehelper") (subpath "/dev/fd"))
(allow file-read* (literal "/") (literal "/tmp") (literal "/etc") (literal "/var") (literal "/Library") (literal "/private/etc") (literal "/private/tmp") (literal "/private/var")
  (literal ${q(executable)}) (literal ${q(bridge)})
  (subpath "/System") (subpath "/usr") (subpath "/Library/Preferences") (subpath "/Library/Apple") (subpath "/etc") (subpath "/private/etc") (subpath "/var/db/timezone") (subpath "/private/var/db/timezone")
  (subpath ${q(workspace)}))
(allow file-map-executable (literal ${q(executable)}) (literal ${q(bridge)}) (subpath "/System") (subpath "/usr"))
(allow file-read* file-write* (subpath ${q(scratch)}) (subpath ${q(accountHome)}) (subpath ${q(devinTmp)}))
(allow file-read-metadata (path-ancestors ${q(executable)}) (path-ancestors ${q(bridge)}) (path-ancestors ${q(scratch)}) (path-ancestors ${q(accountHome)}) (path-ancestors ${q(workspace)}))
(allow network-outbound (literal "/private/var/run/mDNSResponder") (literal "/private/var/run/syslog") (remote tcp "*:443") (remote tcp "localhost:*"))
`;
}

const SEATBELT = "/usr/bin/sandbox-exec";

/** Fixed discovery set for the admitted wrapper — never resolved through
 * PATH so a writable directory cannot inject a substitute artifact. */
const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"] as const;
/** Fixed loopback port inside the private net namespace — it cannot collide
 * because the namespace is created empty per launch. */
const FORWARDER_PORT = 48123;

/** Shared-library closure of one dynamic executable via `ldd` (absolute paths
 * only; vdso and loader-internal entries without a path are skipped). Sync so
 * it can run inside the plan's per-spawn path. */
function lddClosure(executable: string): string[] {
  const result = spawnSync("ldd", [executable], { encoding: "utf8", timeout: 15_000 });
  const paths = new Set<string>();
  if (result.status === 0 && typeof result.stdout === "string") {
    for (const match of result.stdout.matchAll(/(?:=>\s*)?(\/[A-Za-z0-9._\/+:-]+)/g)) {
      if (isAbsolute(match[1]!)) paths.add(match[1]!);
    }
  }
  return [...paths].sort();
}

/** Prepared Linux sandbox context: everything the synchronous per-spawn
 * factory needs that can only be produced asynchronously — the admitted and
 * re-verified bwrap artifact, the in-namespace JS runtime plus its library
 * closure, the shipped forwarder script, and the live host-side bridge. The
 * bridge is scoped to the adapter lifetime; `close()` joins it and the
 * session calls it on exit. */
export type CliLinuxSandbox = Readonly<{
  socketPath: string;
  plan(input: { executable: string; scratch: string; accountHome: string; policyPath: string }): OsSandboxPlan;
  close(): Promise<EgressBridgeReceipt>;
}>;

/** Admit the Linux sandbox surface and start the session bridge. Any failure
 * throws — the caller maps that to `sandbox-unavailable`, never to an
 * unsandboxed run. The bwrap artifact is verified here at admission; the
 * per-spawn plan is pure. */
export async function prepareCliLinuxSandbox(input: Readonly<{
  bridgeDirectory: string;
}>): Promise<CliLinuxSandbox> {
  const bridgeDirectory = path(input.bridgeDirectory);
  await mkdir(bridgeDirectory, { mode: 0o700, recursive: true });
  let bwrap: string | undefined;
  for (const candidate of BWRAP_CANDIDATES) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) { bwrap = await realpath(candidate); break; }
  }
  const wrapper = bwrap ?? fail("CLI_SANDBOX_BWRAP_MISSING");
  const bwrapSha256 = createHash("sha256").update(await readFile(wrapper)).digest("hex");
  await verifyOsSandboxExecutable(wrapper, bwrapSha256, 8n * 1024n * 1024n);
  const runtime = await realpath(process.execPath);
  // The source layout keeps the artifact at <repo>/sandbox (two levels above
  // src/cli) while the packed bundle puts it at <pkg>/sandbox (one above
  // dist/cli.js); admit whichever canonical copy is present.
  let script: string | undefined;
  for (const rel of ["../../sandbox/loopback-forwarder.cjs", "../sandbox/loopback-forwarder.cjs"]) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (await lstat(candidate).then(meta => meta.isFile(), () => false)) { script = await realpath(candidate); break; }
  }
  const forwarderScript = script ?? fail("CLI_SANDBOX_FORWARDER_MISSING");
  // The runtime's closure is fixed at admission; the spawned executable's is
  // computed per plan so the closure always matches the exact artifact handed
  // to the factory.
  const runtimeLibs = lddClosure(runtime);
  const socketPath = join(bridgeDirectory, `egress-${process.pid}-${createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12)}.sock`);
  const bridge = await createEgressBridge({ socketPath, dialer: egressBridgeDialer });
  return Object.freeze({
    socketPath,
    plan({ executable: exe, scratch, accountHome, policyPath }) {
      const readOnlyPaths = [...new Set([...runtimeLibs, ...lddClosure(exe)])].sort();
      return planBwrapPolicy({ platform: "linux", executable: exe, scratch, accountHome, readOnlyPaths,
        network: "provider-tcp443-dns", egressSocket: socketPath,
        egressForward: { runtime, script: forwarderScript, port: FORWARDER_PORT,
          envFile: join(scratch, "forwarder.env") }, policyPath }, wrapper);
    },
    close: () => bridge.close(),
  });
}

/** Fixed loopback port the in-namespace forwarder publishes for the tool
 * relay — distinct from the egress port and collision-free inside the
 * per-launch empty namespace. */
const SERVICE_PORT = 48124;

/** Devin's Linux sandbox adds the second namespace socket: the host-side
 * tool relay listens on `serviceSocket`, the forwarder re-publishes it at
 * `127.0.0.1:SERVICE_PORT` for the MCP bridge the agent spawns. The
 * workspace rides in as a read-only bind; writes stay brokered. */
export type DevinCliLinuxSandbox = Readonly<{
  socketPath: string;
  serviceSocketPath: string;
  servicePort: number;
  plan(input: { executable: string; bridgeExecutable: string; scratch: string; accountHome: string; workspace: string; policyPath: string }): OsSandboxPlan;
  close(): Promise<EgressBridgeReceipt>;
}>;

export async function prepareDevinCliLinuxSandbox(input: Readonly<{
  bridgeDirectory: string;
}>): Promise<DevinCliLinuxSandbox> {
  const bridgeDirectory = path(input.bridgeDirectory);
  await mkdir(bridgeDirectory, { mode: 0o700, recursive: true });
  let bwrap: string | undefined;
  for (const candidate of BWRAP_CANDIDATES) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) { bwrap = await realpath(candidate); break; }
  }
  const wrapper = bwrap ?? fail("CLI_SANDBOX_BWRAP_MISSING");
  const bwrapSha256 = createHash("sha256").update(await readFile(wrapper)).digest("hex");
  await verifyOsSandboxExecutable(wrapper, bwrapSha256, 8n * 1024n * 1024n);
  const runtime = await realpath(process.execPath);
  let script: string | undefined;
  for (const rel of ["../../sandbox/loopback-forwarder.cjs", "../sandbox/loopback-forwarder.cjs"]) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (await lstat(candidate).then(meta => meta.isFile(), () => false)) { script = await realpath(candidate); break; }
  }
  const forwarderScript = script ?? fail("CLI_SANDBOX_FORWARDER_MISSING");
  const runtimeLibs = lddClosure(runtime);
  const unique = `-${process.pid}-${createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12)}.sock`;
  const socketPath = join(bridgeDirectory, `egress${unique}`);
  const serviceSocketPath = join(bridgeDirectory, `service${unique}`);
  const bridge = await createEgressBridge({ socketPath, dialer: egressBridgeDialer });
  return Object.freeze({
    socketPath,
    serviceSocketPath,
    servicePort: SERVICE_PORT,
    plan({ executable: exe, bridgeExecutable, scratch, accountHome, workspace, policyPath }) {
      const readOnlyPaths = [...new Set([...runtimeLibs, ...lddClosure(exe), bridgeExecutable, ...lddClosure(bridgeExecutable), workspace])].sort();
      return planBwrapPolicy({ platform: "linux", executable: exe, scratch, accountHome, readOnlyPaths,
        network: "provider-tcp443-dns", egressSocket: socketPath,
        egressForward: { runtime, script: forwarderScript, port: FORWARDER_PORT,
          envFile: join(scratch, "forwarder.env"),
          service: { socket: serviceSocketPath, port: SERVICE_PORT } }, policyPath }, wrapper);
    },
    close: () => bridge.close(),
  });
}

type DevinDirectoryIdentity = Readonly<{ dev: bigint; ino: bigint }>;
function devinPrivateDirectoryIdentity(directory: string): DevinDirectoryIdentity {
  const stat = lstatSync(directory, { bigint: true });
  assertPrivateStat(stat, { kind: "directory", noSymlink: true, owner: "self", mode: [{ mask: 0o077, equals: 0 }] }, "CLI_DEVIN_DIRECTORY_INVALID");
  if (realpathSync(directory) !== directory) fail("CLI_DEVIN_DIRECTORY_INVALID");
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function removeDevinSnapshot(runRoot: string, runIdentity: DevinDirectoryIdentity, stateIdentity: DevinDirectoryIdentity): void {
  // Revalidate physical paths and inode custody immediately before removal.
  // If another actor replaced either directory, retain it untouched.
  const state = devinPrivateDirectoryIdentity(dirname(runRoot)), run = devinPrivateDirectoryIdentity(runRoot);
  if (state.dev !== stateIdentity.dev || state.ino !== stateIdentity.ino
    || run.dev !== runIdentity.dev || run.ino !== runIdentity.ino) fail("CLI_DEVIN_DIRECTORY_CHANGED");
  rmSync(runRoot, { recursive: true, force: true });
}

/** Delete a run snapshot only after both process custody and stdio join are
 * proven. An uncertain join keeps its executable and policy for recovery. */
function withDevinSnapshotCleanup(handle: BoundedProviderProcess, runRoot: string, runIdentity: DevinDirectoryIdentity, stateIdentity: DevinDirectoryIdentity): BoundedProviderProcess {
  let stopped = false, stopping: Promise<void> | undefined;
  return Object.freeze({ process: handle.process, isStopped: () => stopped,
    stopAndJoin() {
      return stopping ??= (async () => {
        try { handle.process.stdin.end(); } catch { /* join is authoritative */ }
        await handle.stopAndJoin();
        if (!handle.isStopped()) throw new Error("DEVIN_PROCESS_JOIN_UNPROVEN");
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1_000);
        try {
          await Promise.all([handle.process.stdin, handle.process.stdout].map(stream =>
            finished(stream, { signal: controller.signal, cleanup: true }).catch(() => undefined)));
          if (!(handle.process.stdin.closed || handle.process.stdin.writableFinished)
            || !(handle.process.stdout.closed || handle.process.stdout.readableEnded)) {
            throw new Error("DEVIN_PROCESS_STDIO_JOIN_UNPROVEN");
          }
        } finally { clearTimeout(timer); }
        stopped = true;
        // Cleanup failure does not invalidate the independent stop proof.
        try { removeDevinSnapshot(runRoot, runIdentity, stateIdentity); } catch { /* retain uncertain artifacts */ }
      })();
    },
  });
}

/** Snapshot the exact admitted executable before launch. A fresh private run
 * directory prevents overwriting an earlier run's retained recovery evidence. */
function snapshotDevinExecutable(source: string, executable: string, expectedSha256: string): void {
  const sourceFd = openSync(path(source), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const sourceStat = fstatSync(sourceFd);
    assertPrivateStat(sourceStat, { kind: "file", links: "single", owner: "selfOrRoot",
      mode: [{ mask: 0o022, equals: 0 }, { mask: 0o111, notEquals: 0 }],
      size: { min: 1, max: 256 * 1024 * 1024 } }, "CLI_DEVIN_EXECUTABLE_INVALID");
    const destination = openSync(executable, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o500);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let bytes = 0, count: number;
      while ((count = readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) {
        bytes += count;
        if (bytes > sourceStat.size || bytes > 256 * 1024 * 1024) fail("CLI_DEVIN_EXECUTABLE_CHANGED");
        let written = 0;
        while (written < count) {
          const progress = writeSync(destination, buffer, written, count - written);
          if (progress === 0) fail("CLI_DEVIN_EXECUTABLE_COPY_FAILED");
          written += progress;
        }
      }
      if (bytes !== sourceStat.size) fail("CLI_DEVIN_EXECUTABLE_CHANGED");
    } finally { closeSync(destination); }
  } finally { closeSync(sourceFd); }
  const fd = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 256 * 1024 * 1024) fail("CLI_DEVIN_EXECUTABLE_INVALID");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let bytes = 0, count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += count;
      if (bytes > 256 * 1024 * 1024) fail("CLI_DEVIN_EXECUTABLE_INVALID");
      hash.update(buffer.subarray(0, count));
    }
    if (bytes !== stat.size || hash.digest("hex") !== expectedSha256) fail("CLI_DEVIN_EXECUTABLE_CHANGED");
  } finally { closeSync(fd); }
}

export function devinCliProcessFactory(input: Readonly<{
  stateRoot: string; accountHome: string; workspace: string; bridgeExecutable: string;
  executableSha256: string; linux?: DevinCliLinuxSandbox;
}>, platform: string = process.platform): BoundedProviderProcessFactory | undefined {
  const stateRoot = path(input.stateRoot), accountHome = path(input.accountHome),
    workspace = path(input.workspace), bridge = path(input.bridgeExecutable);
  if (!/^[a-f0-9]{64}$/u.test(input.executableSha256)) fail("CLI_DEVIN_EXECUTABLE_DIGEST_INVALID");
  if (platform !== "darwin" && (platform !== "linux" || input.linux === undefined)) return undefined;
  return request => {
    const runRoot = join(stateRoot, `devin-run-${identifier(request.binding.runId)}`);
    const stateIdentity = devinPrivateDirectoryIdentity(stateRoot);
    mkdirSync(runRoot, { mode: 0o700 });
    const runIdentity = devinPrivateDirectoryIdentity(runRoot);
    let launchStarted = false;
    try {
      const scratch = join(runRoot, "scratch"), executable = join(runRoot, "provider");
      mkdirSync(scratch, { mode: 0o700 });
      snapshotDevinExecutable(request.executable, executable, input.executableSha256);
      const policyPath = join(runRoot, platform === "darwin" ? "sandbox.sb" : "sandbox.json");
      const plan = platform === "darwin"
        ? planSeatbeltPolicy(
          { platform: "darwin", executable, scratch, accountHome, readOnlyPaths: [workspace], network: "provider-tcp443-dns", policyPath },
          devinCliSandboxPolicy({ executable, bridgeExecutable: bridge, scratch, accountHome, workspace }))
        : input.linux!.plan({ executable, bridgeExecutable: bridge, scratch, accountHome, workspace, policyPath });
      writeFileSync(policyPath, plan.policy, { mode: 0o400, flag: "wx" });
      const env = platform === "linux"
        ? Object.freeze({ PATH: "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, ...request.env }) : request.env;
      launchStarted = true;
      return withDevinSnapshotCleanup(createSandboxedProviderProcessFactory(plan)({ ...request, executable, env }), runRoot, runIdentity, stateIdentity);
    } catch (error) {
      if (!launchStarted) {
        try { removeDevinSnapshot(runRoot, runIdentity, stateIdentity); } catch { /* retain uncertain artifacts */ }
      }
      throw error;
    }
  };
}

/** Seatbelt is darwin-only; on Linux an admitted bwrap plan plus the
 * in-namespace CONNECT forwarder provides the equivalent boundary, and the
 * caller refuses to run without a prepared sandbox. The returned factory
 * plans lazily inside the SDK's synchronous spawn callback: the run
 * directory is derived from the snapshot path the adapter hands over, the
 * policy is persisted outside the writable scratch, and argv/env are
 * rewritten onto the wrapper. */
export function claudeCliProcessFactory(accountHome: string, linux?: CliLinuxSandbox,
  platform: string = process.platform): BoundedProviderProcessFactory | undefined {
  if (platform === "darwin") {
    const home = path(accountHome);
    return (input) => {
      const executable = path(input.executable);
      const runRoot = dirname(executable);
      const scratch = join(runRoot, "scratch");
      const policyPath = join(runRoot, "sandbox.sb");
      const plan: OsSandboxPlan = planSeatbeltPolicy(
        { platform: "darwin", executable, scratch, accountHome: home, network: "provider-tcp443-dns", policyPath },
        claudeCliSandboxPolicy({ executable, scratch, accountHome: home }),
      );
      writeFileSync(policyPath, plan.policy, { mode: 0o400, flag: "w" });
      return createSandboxedProviderProcessFactory(plan)(input);
    };
  }
  if (platform === "linux" && linux !== undefined) {
    const home = path(accountHome);
    return (input) => {
      const executable = path(input.executable);
      const runRoot = dirname(executable);
      const scratch = join(runRoot, "scratch");
      // bwrap --bind needs the source to exist — the scratch root is per-run
      // and owned by the child alone.
      mkdirSync(scratch, { mode: 0o700, recursive: true });
      const policyPath = join(runRoot, "sandbox.json");
      const plan = linux.plan({ executable, scratch, accountHome: home, policyPath });
      writeFileSync(policyPath, plan.policy, { mode: 0o400, flag: "w" });
      // --clearenv drops everything not in the map; guarantee the minimal
      // navigable env without overriding anything the adapter closed.
      const env = Object.freeze({ PATH: "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, ...input.env });
      return createSandboxedProviderProcessFactory(plan)({ ...input, env });
    };
  }
  return undefined;
}

/** Seatbelt availability probe for diagnostics; never admits by itself. */
export async function seatbeltAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await access(SEATBELT, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
