import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { planSeatbeltPolicy, planBwrapPolicy, createSandboxedProviderProcessFactory, verifyOsSandboxExecutable, type OsSandboxPlan } from "../os-sandbox.ts";
import { createEgressBridge, egressBridgeDialer, type EgressBridgeReceipt } from "../egress-bridge.ts";
import type { BoundedProviderProcessFactory } from "../provider-process.ts";

const fail = (code: string): never => { throw new Error(code); };
function path(value: unknown): string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4096
    && !/[\x00-\x1f\x7f"\\]/u.test(value) ? value : fail("CLI_SANDBOX_PATH_INVALID");
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
        egressForward: { runtime, script: forwarderScript, port: FORWARDER_PORT }, policyPath }, wrapper);
    },
    close: () => bridge.close(),
  });
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
