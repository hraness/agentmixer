import { createHash } from "node:crypto";
import { constants, writeFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { spawnBoundedProvider, type BoundedProviderProcessFactory, type BoundedProviderProcessInput } from "./provider-process.ts";

/**
 * OS-confinement port for provider processes. A backend turns a closed launch
 * spec into a plan: a canonical policy artifact, its digest, the wrapper
 * executable the child actually spawns, and a pure `wrap()` that rewrites one
 * invocation onto the admitted policy. Planning is asynchronous so backends
 * can re-verify their own admitted artifacts; wrapping is synchronous so it
 * can run inside provider SDKs that spawn from a sync callback.
 *
 * Custody stays with the caller: bounded stdio, detached process groups,
 * SIGTERM/SIGKILL escalation and join evidence are unchanged underneath every
 * backend. A plan proves policy construction and artifact admission only — it
 * is not proof that the kernel enforced the policy. Kernel-boundary evidence
 * belongs to `qualification/` probes, and every receipt keeps
 * `productionQualified: false` until a host supplies it.
 *
 * - `seatbelt` (darwin): the caller supplies reviewed SBPL policy text through
 *   `generateProfile`; the plan wraps argv as `/usr/bin/sandbox-exec -f
 *   <policyPath> <executable> <args...>` byte-identically to the launchers this
 *   port replaces. Environment passes through — callers already close it.
 * - `bwrap` (linux): bubblewrap builds a private rootfs from per-file
 *   `--ro-bind` entries, `--bind` for the writable scratch/account roots,
 *   `--unshare-all`, `--new-session`, `--die-with-parent`, `--clearenv` +
 *   `--setenv`. Only `network: "denied"` is plannable: bwrap cannot express
 *   per-destination egress, and a unix-socket proxy bridge is a separate
 *   qualification. The wrapper binary is itself an admitted artifact whose
 *   SHA-256 is re-verified from a checked descriptor at plan time.
 *   `--setenv` values are visible in the wrapper's own command line, so a
 *   forwarder plan may instead declare `envFile`: `wrap()` then persists
 *   the closed env into the writable scratch (mode 0600) and emits no
 *   `--setenv` at all — the forwarder reads, deletes, and injects the
 *   pairs only into the supervised child's environment.
 */
export type OsSandboxNetworkPolicy = "denied" | "loopback" | "provider-tcp443-dns";
export type OsSandboxBackendName = "seatbelt" | "bwrap";
/** The platform the *admitted runtime* targets — host admission evidence, not
 * `process.platform`. A backend refuses a spec whose platform it cannot
 * enforce; synthetic custody tests exercise the real launch path on any host. */
export type OsSandboxPlatform = "darwin" | "linux";

export type OsSandboxSpec = Readonly<{
  platform: OsSandboxPlatform;
  /** Absolute canonical path of the in-sandbox executable (the admitted run
   * snapshot), bound read-only and executable. */
  executable: string;
  /** Per-run private writable root (home/tmp/work). */
  scratch: string;
  /** Persistent private writable root holding account credentials. */
  accountHome?: string;
  /** Extra absolute file literals admitted read-only inside the sandbox
   * (admitted library closure, fixed config). Never directories unless the
   * backend documents subpath semantics. */
  readOnlyPaths?: readonly string[];
  /** Extra absolute paths admitted read-write inside the sandbox beyond
   * scratch/accountHome — e.g. the consumer workspace for providers whose own
   * filesystem tools write directly rather than through a host broker. Paths
   * must not contain or enclose the executable (unless a `protectedPaths`
   * entry re-covers it), each other, scratch, accountHome, policyPath, the
   * egress socket, or forwarder artifacts. */
  readWritePaths?: readonly string[];
  /** Read-only re-covers mounted *after* the writable binds, so a path nested
   * inside a writable root stays immutable (e.g. a provider's install tree
   * inside its writable state root). On seatbelt these emit deny-write
   * rules; on bwrap they are later ro binds that shadow the rw parent. Every
   * entry must sit inside a writable root. */
  protectedPaths?: readonly string[];
  /** Masked subtrees nested inside a writable root: contents stay reachable
   * on the host but are invisible inside the sandbox (e.g. credential stores
   * that happen to sit under a workspace bound read-write). On seatbelt
   * these emit deny read+write rules; on bwrap they are tmpfs mounts that
   * shadow the bound subtree. Every entry must sit inside a writable root
   * and must never cover the executable. */
  hiddenPaths?: readonly string[];
  network: OsSandboxNetworkPolicy;
  /** Canonical absolute path of a host-side egress-bridge unix socket,
   * bind-mounted read-write. Required iff `network` is
   * `"provider-tcp443-dns"` on a bwrap plan; refused by seatbelt, whose
   * profile carries egress internally. */
  egressSocket?: string;
  /** Optional in-namespace CONNECT forwarder for stock binaries that do not
   * consume the bridge socket natively: an admitted JS runtime plus the
   * admitted forwarder script are bound read-only and become the namespace
   * entry point — `runtime script <socket> <port> <lo|- > <env|- > <svc|- > -- <executable> <args>`.
   * The forwarder binds `127.0.0.1:<port>` and launches the child with
   * standard proxy variables, so the plan env needs no proxy keys. Requires
   * `egressSocket`; refused by seatbelt.
   * `envFile` is an optional absolute path inside the writable scratch or
   * account root: when set, `wrap()` writes the invocation env there
   * (mode 0600) and the forwarder injects it into the child, keeping every
   * value — secret or not — out of the wrapper's command line.
   * `service` is an optional second listener: the forwarder binds
   * `127.0.0.1:<service.port>` inside the namespace and pipes each accepted
   * connection to `service.socket`, a host-side unix socket bound into the
   * namespace — the in-namespace consumption path for host services (the
   * tool relay) that are not CONNECT egress. */
  egressForward?: Readonly<{ runtime: string; script: string; port: number; envFile?: string;
    service?: Readonly<{ socket: string; port: number }> }>;
  /** Absolute path of the durable policy artifact the caller persists
   * (`sandbox.sb`, `sandbox.json`). Identity flows into custody journals. */
  policyPath: string;
}>;

export type OsSandboxWrapInput = Readonly<{
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
}>;

export type OsSandboxPlan = Readonly<{
  backend: OsSandboxBackendName;
  /** Canonical policy bytes: SBPL text on seatbelt, canonical plan JSON on
   * bwrap. The caller persists this verbatim at `spec.policyPath`. */
  policy: string;
  policySha256: string;
  /** The wrapper executable the child process spawns. */
  executable: string;
  wrap(input: OsSandboxWrapInput): { args: readonly string[]; env: Readonly<Record<string, string>> };
}>;

export interface OsSandboxBackend {
  readonly name: OsSandboxBackendName;
  plan(spec: OsSandboxSpec): Promise<OsSandboxPlan>;
}

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fail = (code: string): never => { throw new Error(code); };
function assert(value: unknown, code: string): asserts value { if (!value) fail(code); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)), "OS_SANDBOX_OBJECT_INVALID");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value as object)) {
    assert(typeof key === "string" && keys.includes(key), "OS_SANDBOX_UNKNOWN_FIELD");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    assert("value" in descriptor, "OS_SANDBOX_ACCESSOR_DENIED"); result[key] = descriptor.value;
  }
  return result;
}
function path(value: unknown): string {
  assert(typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4096 && !/[\x00-\x1f\x7f"\\]/u.test(value), "OS_SANDBOX_PATH_INVALID");
  return value;
}
function digest(value: unknown): string {
  assert(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), "OS_SANDBOX_PIN_INVALID"); return value;
}
function arg(value: string, code: string): string {
  // argv elements are byte strings, not shell text: reject control bytes and
  // embedded NUL; everything else reaches execve verbatim.
  assert(!/[\x00-\x1f\x7f]/u.test(value) && value.length <= 4096, code);
  return value;
}
function specOf(value: unknown): OsSandboxSpec {
  const raw = object(value, ["platform", "executable", "scratch", "accountHome", "readOnlyPaths", "readWritePaths", "protectedPaths", "hiddenPaths", "network", "egressSocket", "egressForward", "policyPath"]);
  const platform = raw.platform;
  assert(platform === "darwin" || platform === "linux", "OS_SANDBOX_PLATFORM_INVALID");
  const readOnly = raw.readOnlyPaths === undefined ? [] : (() => {
    assert(Array.isArray(raw.readOnlyPaths) && raw.readOnlyPaths.length <= 256, "OS_SANDBOX_SPEC_INVALID");
    return (raw.readOnlyPaths as unknown[]).map(entry => path(entry));
  })();
  const readWrite = raw.readWritePaths === undefined ? [] : (() => {
    assert(Array.isArray(raw.readWritePaths) && raw.readWritePaths.length <= 8, "OS_SANDBOX_SPEC_INVALID");
    return (raw.readWritePaths as unknown[]).map(entry => path(entry));
  })();
  const protectedPaths = raw.protectedPaths === undefined ? [] : (() => {
    assert(Array.isArray(raw.protectedPaths) && raw.protectedPaths.length <= 8, "OS_SANDBOX_SPEC_INVALID");
    return (raw.protectedPaths as unknown[]).map(entry => path(entry));
  })();
  const hiddenPaths = raw.hiddenPaths === undefined ? [] : (() => {
    assert(Array.isArray(raw.hiddenPaths) && raw.hiddenPaths.length <= 16, "OS_SANDBOX_SPEC_INVALID");
    return (raw.hiddenPaths as unknown[]).map(entry => path(entry));
  })();
  const network = raw.network;
  assert(network === "denied" || network === "loopback" || network === "provider-tcp443-dns", "OS_SANDBOX_NETWORK_INVALID");
  const executable = path(raw.executable), scratch = path(raw.scratch), policyPath = path(raw.policyPath);
  const egressSocket = raw.egressSocket === undefined ? undefined : path(raw.egressSocket);
  assert(egressSocket === undefined || network === "provider-tcp443-dns", "OS_SANDBOX_EGRESS_UNEXPECTED");
  const egressForward = raw.egressForward === undefined ? undefined : (() => {
    const forward = object(raw.egressForward, ["runtime", "script", "port", "envFile", "service"]);
    const port = forward.port;
    assert(Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535, "OS_SANDBOX_EGRESS_PORT_INVALID");
    const service = forward.service === undefined ? undefined : (() => {
      const svc = object(forward.service, ["socket", "port"]);
      assert(Number.isInteger(svc.port) && (svc.port as number) >= 1 && (svc.port as number) <= 65535
        && svc.port !== port, "OS_SANDBOX_EGRESS_PORT_INVALID");
      return Object.freeze({ socket: path(svc.socket), port: svc.port as number });
    })();
    return Object.freeze({ runtime: path(forward.runtime), script: path(forward.script), port: port as number,
      ...(forward.envFile === undefined ? {} : { envFile: path(forward.envFile) }),
      ...(service === undefined ? {} : { service }) });
  })();
  // A forwarder is meaningless without the bridge socket it translates to;
  // conversely the socket alone is the native-consumption contract.
  assert(egressForward === undefined || egressSocket !== undefined, "OS_SANDBOX_EGRESS_UNEXPECTED");
  const serviceSocket = egressForward?.service?.socket;
  const spec = Object.freeze({ platform, executable, scratch,
    ...(raw.accountHome === undefined ? {} : { accountHome: path(raw.accountHome) }),
    readOnlyPaths: Object.freeze(readOnly),
    readWritePaths: Object.freeze(readWrite),
    protectedPaths: Object.freeze(protectedPaths),
    hiddenPaths: Object.freeze(hiddenPaths), network,
    ...(egressSocket === undefined ? {} : { egressSocket }),
    ...(egressForward === undefined ? {} : { egressForward }), policyPath });
  // The writable roots must not contain or enclose the executable or each
  // other: a rw bind over the exe would let the child replace it. An extra
  // read-write path may hold the executable only when a protected path
  // re-covers it (ro bind over the rw parent / seatbelt deny-write).
  const inside = (inner: string, outer: string) => inner === outer || inner.startsWith(outer + "/");
  const writable = [scratch, ...(spec.accountHome === undefined ? [] : [spec.accountHome]), ...spec.readWritePaths];
  assert(!inside(executable, scratch) && (spec.accountHome === undefined || !inside(executable, spec.accountHome))
    && (!spec.readWritePaths.some(root => inside(executable, root))
      || spec.protectedPaths.some(root => inside(executable, root))), "OS_SANDBOX_LAYOUT_INVALID");
  assert(spec.accountHome === undefined || (!inside(scratch, spec.accountHome) && !inside(spec.accountHome, scratch)), "OS_SANDBOX_LAYOUT_INVALID");
  assert(!inside(policyPath, scratch) && (spec.accountHome === undefined || !inside(policyPath, spec.accountHome)), "OS_SANDBOX_LAYOUT_INVALID");
  // Extra writable roots bind their target to itself, so nesting among them
  // or against scratch is harmless — the durable policy, the egress socket
  // and forwarder artifacts are the only real containment concerns: a child
  // that could rewrite its own policy artifact, swap the bridge socket, or
  // replace the namespace entry point would break admission integrity.
  for (const root of spec.readWritePaths) {
    assert(!inside(policyPath, root), "OS_SANDBOX_LAYOUT_INVALID");
    assert(egressSocket === undefined || !inside(egressSocket, root), "OS_SANDBOX_LAYOUT_INVALID");
    assert(egressForward === undefined
      || (!inside(egressForward.runtime, root) && !inside(egressForward.script, root)), "OS_SANDBOX_LAYOUT_INVALID");
  }
  // Protected and hidden paths re-cover a subtree of an existing writable
  // root (ro shadow / seatbelt deny-write / masked contents). An entry
  // outside every writable root would be a meaningless duplicate of
  // readOnlyPaths — or, for hidden paths, a mount on nothing.
  for (const root of spec.protectedPaths) {
    assert(writable.some(parent => inside(root, parent)), "OS_SANDBOX_LAYOUT_INVALID");
    assert(egressSocket === undefined || !inside(egressSocket, root), "OS_SANDBOX_LAYOUT_INVALID");
  }
  for (const root of spec.hiddenPaths) {
    assert(writable.some(parent => inside(root, parent)), "OS_SANDBOX_LAYOUT_INVALID");
    assert(!inside(executable, root), "OS_SANDBOX_LAYOUT_INVALID");
    assert(egressSocket === undefined || !inside(egressSocket, root), "OS_SANDBOX_LAYOUT_INVALID");
  }
  // The bridge socket takes its own rw bind; nesting it inside a writable root
  // would make the extra bind meaningless, and a socket inside the writable
  // roots could be replaced by the child before the bridge notices. The
  // service socket is the same shape: inside a writable root a child could
  // substitute its own host-service impersonation.
  assert(egressSocket === undefined || (!inside(egressSocket, scratch)
    && (spec.accountHome === undefined || !inside(egressSocket, spec.accountHome))), "OS_SANDBOX_LAYOUT_INVALID");
  assert(serviceSocket === undefined || (!inside(serviceSocket, scratch)
    && (spec.accountHome === undefined || !inside(serviceSocket, spec.accountHome))
    && !spec.readWritePaths.some(root => inside(serviceSocket, root))
    && !spec.hiddenPaths.some(root => inside(serviceSocket, root))
    && !spec.protectedPaths.some(root => inside(serviceSocket, root))), "OS_SANDBOX_LAYOUT_INVALID");
  // Forwarder artifacts get the same non-containment rule as the executable:
  // a rw bind must never cover the entry point the namespace actually runs.
  assert(egressForward === undefined
    || (!inside(egressForward.runtime, scratch) && !inside(egressForward.script, scratch)
      && (spec.accountHome === undefined
        || (!inside(egressForward.runtime, spec.accountHome) && !inside(egressForward.script, spec.accountHome)))),
    "OS_SANDBOX_LAYOUT_INVALID");
  // The env file is the mirror image of a forwarder artifact: it must sit
  // inside a writable root so the forwarder can read and delete it, and it
  // must never land on a read-only bind.
  assert(egressForward === undefined || egressForward.envFile === undefined
    || inside(egressForward.envFile, scratch)
    || (spec.accountHome !== undefined && inside(egressForward.envFile, spec.accountHome)),
    "OS_SANDBOX_LAYOUT_INVALID");
  return spec;
}
function wrapInputOf(value: unknown): { args: readonly string[]; env: Readonly<Record<string, string>>; cwd: string } {
  const raw = object(value, ["args", "env", "cwd"]);
  assert(Array.isArray(raw.args) && raw.args.length <= 256, "OS_SANDBOX_WRAP_INVALID");
  const args = Object.freeze((raw.args as unknown[]).map(entry => {
    assert(typeof entry === "string", "OS_SANDBOX_WRAP_INVALID"); return arg(entry, "OS_SANDBOX_WRAP_INVALID");
  }));
  assert(raw.env !== null && typeof raw.env === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(raw.env)), "OS_SANDBOX_WRAP_INVALID");
  const env: Record<string, string> = Object.create(null);
  for (const key of Reflect.ownKeys(raw.env as object)) {
    assert(typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key), "OS_SANDBOX_WRAP_INVALID");
    const descriptor = Object.getOwnPropertyDescriptor(raw.env, key)!;
    assert("value" in descriptor && typeof descriptor.value === "string" && descriptor.value.length <= 64 * 1024 && !descriptor.value.includes("\0"), "OS_SANDBOX_WRAP_INVALID");
    env[key] = descriptor.value;
  }
  return { args, env: Object.freeze(env), cwd: path(raw.cwd) };
}

/** Forwarder-owned variable names: the env file may carry secrets, but it
 * must never let a value redirect egress — the forwarder sets proxy vars
 * itself after injecting the file. Mirrored by the in-namespace forwarder. */
const PROXY_ENV_KEYS = new Set(["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"]);

/** Persists the closed invocation env as bounded `KEY=VALUE` lines at a
 * declared path inside the writable scratch, mode 0600. The env map is
 * already validated by `wrapInputOf`; this adds the total bound and the
 * reserved-key check, then writes deterministically in sorted key order. */
function writeForwarderEnv(envFile: string, env: Readonly<Record<string, string>>): void {
  let body = "";
  for (const key of Object.keys(env).sort()) {
    assert(!PROXY_ENV_KEYS.has(key), "OS_SANDBOX_WRAP_INVALID");
    body += `${key}=${env[key]!}\n`;
  }
  assert(Buffer.byteLength(body) <= 64 * 1024, "OS_SANDBOX_WRAP_INVALID");
  writeFileSync(envFile, body, { mode: 0o600, flag: "w" });
}

/** Re-verifies an admitted executable from a checked descriptor: owner,
 * file identity, size bound, no-follow canonical path, and exact SHA-256.
 * The owner may be the current user or root — a root-owned system tool like
 * a distribution `bwrap` is at least as tamper-evident as a user-owned file.
 * Any mutation or relabel is `OS_SANDBOX_EXECUTABLE_CHANGED`; a missing or
 * non-file path is `OS_SANDBOX_EXECUTABLE_INVALID`. */
export async function verifyOsSandboxExecutable(executablePath: string, sha256: string, sizeLimit: bigint): Promise<void> {
  const fd = await open(executablePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => fail("OS_SANDBOX_EXECUTABLE_INVALID"));
  try {
    const before = await fd.stat({ bigint: true });
    assert(before.isFile() && [0n, BigInt(process.getuid!())].includes(before.uid) && before.size > 0n && before.size <= sizeLimit, "OS_SANDBOX_EXECUTABLE_INVALID");
    const fileHash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let read = 0;
    while (read <= Number(before.size)) {
      const count = (await fd.read(buffer, 0, Math.min(buffer.length, Number(before.size) + 1 - read), read)).bytesRead;
      if (!count) break;
      read += count; assert(read <= Number(before.size), "OS_SANDBOX_EXECUTABLE_CHANGED");
      fileHash.update(buffer.subarray(0, count));
    }
    const after = await fd.stat({ bigint: true }), named = await lstat(executablePath, { bigint: true });
    const stable = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(key => before[key as keyof typeof before] === after[key as keyof typeof after] && before[key as keyof typeof before] === named[key as keyof typeof named]);
    assert(read === Number(before.size) && stable && await realpath(executablePath) === executablePath && fileHash.digest("hex") === sha256, "OS_SANDBOX_EXECUTABLE_CHANGED");
  } finally { await fd.close(); }
}

/** Pure seatbelt planning: the wrapper argv and artifact identity for an
 * already-reviewed SBPL profile. Exported so tests can pin the exact spawn
 * contract on any platform; `createSeatbeltOsSandbox` adds the darwin
 * platform gate and generator ownership. */
export function planSeatbeltPolicy(input: OsSandboxSpec, policy: string): OsSandboxPlan {
  const spec = specOf(input);
  assert(spec.platform === "darwin", "OS_SANDBOX_PLATFORM_MISMATCH");
  // Seatbelt carries egress inside its reviewed profile; a bridge socket or
  // forwarder is never consumed and admitting one silently would misrecord
  // the plan.
  assert(spec.egressSocket === undefined && spec.egressForward === undefined, "OS_SANDBOX_EGRESS_UNEXPECTED");
  assert(typeof policy === "string" && policy.length > 0 && policy.length <= 64 * 1024, "OS_SANDBOX_POLICY_INVALID");
  const policyPath = spec.policyPath, executable = spec.executable;
  return Object.freeze({ backend: "seatbelt", policy, policySha256: hash(policy),
    executable: "/usr/bin/sandbox-exec",
    wrap(invocation: OsSandboxWrapInput) {
      const wrapped = wrapInputOf(invocation);
      return { args: Object.freeze(["-f", policyPath, executable, ...wrapped.args]), env: wrapped.env };
    },
  });
}

/** Pure bwrap planning: canonical policy JSON plus wrapper argv for an
 * already-validated spec. Exported so tests can pin the exact contract on any
 * platform; `createBwrapOsSandbox` adds the linux platform gate, the
 * `network: "denied"` bound, and wrapper-artifact re-verification. */
export function planBwrapPolicy(input: OsSandboxSpec, wrapperExecutable: string): OsSandboxPlan {
  const spec = specOf(input);
  assert(spec.platform === "linux", "OS_SANDBOX_PLATFORM_MISMATCH");
  // bwrap is all-or-nothing on network namespaces and seccomp cBPF cannot
  // inspect sockaddr contents: provider egress rides a host-side unix-socket
  // CONNECT bridge bound into the namespace. The net namespace stays
  // unshared either way — the socket is the only egress path.
  assert(spec.network === "denied"
    || (spec.network === "provider-tcp443-dns" && spec.egressSocket !== undefined), "OS_SANDBOX_NETWORK_UNSUPPORTED");
  const wrapper = path(wrapperExecutable);
  const binds: readonly { mode: "ro" | "rw"; target: string }[] = Object.freeze([
    { mode: "ro" as const, target: spec.executable },
    ...(spec.readOnlyPaths ?? []).map(target => ({ mode: "ro" as const, target })),
    { mode: "rw" as const, target: spec.scratch },
    ...(spec.accountHome === undefined ? [] : [{ mode: "rw" as const, target: spec.accountHome }]),
    ...(spec.readWritePaths ?? []).map(target => ({ mode: "rw" as const, target })),
    ...(spec.egressSocket === undefined ? [] : [{ mode: "rw" as const, target: spec.egressSocket }]),
    ...(spec.egressForward === undefined ? [] : [
      { mode: "ro" as const, target: spec.egressForward.runtime },
      { mode: "ro" as const, target: spec.egressForward.script }]),
    ...(spec.egressForward?.service === undefined ? [] : [{ mode: "rw" as const, target: spec.egressForward.service.socket }]),
    // Protected paths are ro binds emitted last: a later bind over a
    // subdirectory of a rw parent shadows it back to read-only.
    ...(spec.protectedPaths ?? []).map(target => ({ mode: "ro" as const, target })),
  ]);
  // The canonical policy binds every mount decision before any argv is
  // wrapped: namespace flags, bind set, and the in-sandbox executable.
  const policy = JSON.stringify({ schema: "xcb.os-sandbox-bwrap.v1", backend: "bwrap",
    namespaces: ["user", "mount", "pid", "ipc", "uts", "cgroup", "net"], newSession: true, dieWithParent: true,
    executable: spec.executable, binds,
    ...((spec.hiddenPaths ?? []).length === 0 ? {} : { masked: spec.hiddenPaths }),
    ...(spec.egressSocket === undefined ? {} : { egress: { socket: spec.egressSocket, protocol: "connect-tcp443",
      ...(spec.egressForward === undefined ? {} : { forwarder: { runtime: spec.egressForward.runtime,
        script: spec.egressForward.script, port: spec.egressForward.port,
        ...(spec.egressForward.envFile === undefined ? {} : { envFile: spec.egressForward.envFile }),
        ...(spec.egressForward.service === undefined ? {} : { service: spec.egressForward.service }),
        protocol: "http-connect-loopback" } }) } }) }) + "\n";
  const prefix = [
    "--unshare-all", "--new-session", "--die-with-parent",
    "--proc", "/proc", "--dev", "/dev",
    ...binds.flatMap(entry => entry.mode === "ro" ? ["--ro-bind", entry.target, entry.target] : ["--bind", entry.target, entry.target]),
    // Masked subtrees get a tmpfs shadow after every bind: the bound parent
    // stays reachable, the covered subtree reads as an empty directory.
    ...(spec.hiddenPaths ?? []).flatMap(target => ["--tmpfs", target]),
    "--clearenv",
  ];
  return Object.freeze({ backend: "bwrap", policy, policySha256: hash(policy), executable: wrapper,
    wrap(invocation: OsSandboxWrapInput) {
      const wrapped = wrapInputOf(invocation);
      // --clearenv scrubs ambient secrets; the child's environment is
      // exactly the caller-closed map, rebuilt in sorted key order. When an
      // env file is admitted the map travels inside the private namespace
      // instead — --setenv values are visible in the wrapper's argv.
      const envFile = spec.egressForward?.envFile;
      if (envFile !== undefined) writeForwarderEnv(envFile, wrapped.env);
      const setenv = envFile === undefined
        ? Object.keys(wrapped.env).sort().flatMap(key => ["--setenv", key, wrapped.env[key]!])
        : [];
      // With a forwarder admitted, the namespace entry point is the runtime
      // running the script; the provider executable becomes the supervised
      // child after `--`. `-` keeps the diagnostic lo-up hook unused; the
      // optional service positional carries `<socket>:<port>` or `-`.
      const service = spec.egressForward?.service;
      const entrypoint = spec.egressForward === undefined
        ? [spec.executable]
        : [spec.egressForward.runtime, spec.egressForward.script, spec.egressSocket!,
          String(spec.egressForward.port), "-", envFile ?? "-",
          service === undefined ? "-" : `${service.socket}:${service.port}`, "--", spec.executable];
      return { args: Object.freeze([...prefix, ...setenv, "--chdir", wrapped.cwd, "--", ...entrypoint, ...wrapped.args]),
        // bwrap itself needs nothing beyond a minimal PATH; the policy env
        // is delivered through --setenv or the private env file.
        env: Object.freeze({ PATH: "/usr/bin:/bin" }) };
    },
  });
}

/** macOS seatbelt backend. The SBPL policy text is host-owned admission input
 * — the port owns wrapping, canonical identity and the durable-artifact
 * contract. `/usr/bin/sandbox-exec` is a fixed literal: PATH cannot inject. */
export function createSeatbeltOsSandbox(options: Readonly<{
  /** Reviewed policy generator. Receives the validated spec; returns exact
   * SBPL text. The generator, not this port, owns rule semantics. */
  generateProfile(spec: OsSandboxSpec): string;
}>): OsSandboxBackend {
  const raw = object(options, ["generateProfile"]);
  assert(typeof raw.generateProfile === "function", "OS_SANDBOX_GENERATOR_INVALID");
  const generate = raw.generateProfile as (spec: OsSandboxSpec) => string;
  return Object.freeze({
    name: "seatbelt" as const,
    async plan(input: OsSandboxSpec): Promise<OsSandboxPlan> {
      return planSeatbeltPolicy(input, generate(specOf(input)));
    },
  });
}

/** Linux bubblewrap backend, offline policy only. The wrapper binary is a
 * second admitted artifact, re-verified at plan time. */
export function createBwrapOsSandbox(options: Readonly<{
  /** Absolute canonical path of the admitted `bwrap` binary. */
  executable: string;
  /** SHA-256 of the admitted `bwrap` bytes. */
  sha256: string;
}>): OsSandboxBackend {
  const raw = object(options, ["executable", "sha256"]);
  const wrapper = path(raw.executable), wrapperSha256 = digest(raw.sha256);
  return Object.freeze({
    name: "bwrap" as const,
    async plan(input: OsSandboxSpec): Promise<OsSandboxPlan> {
      assert(specOf(input).platform === "linux", "OS_SANDBOX_PLATFORM_MISMATCH");
      await verifyOsSandboxExecutable(wrapper, wrapperSha256, 8n * 1024n * 1024n);
      return planBwrapPolicy(input, wrapper);
    },
  });
}

/** Composes an admitted plan onto the unchanged bounded-provider custody:
 * argv/env are rewritten, stdout/stderr bounds, detached group custody and
 * join semantics are untouched. The returned factory stays synchronous so it
 * can run inside provider SDKs that spawn from a sync callback. */
export function createSandboxedProviderProcessFactory(plan: OsSandboxPlan): BoundedProviderProcessFactory {
  assert(plan !== null && typeof plan === "object", "OS_SANDBOX_PLAN_INVALID");
  const executable = path(plan.executable), wrap = plan.wrap.bind(plan);
  return input => {
    const wrapped = wrap({ args: input.args, env: input.env, cwd: input.cwd });
    const forwarded: BoundedProviderProcessInput = { executable, args: wrapped.args, cwd: input.cwd, env: wrapped.env, onViolation: input.onViolation };
    return spawnBoundedProvider(forwarded);
  };
}
