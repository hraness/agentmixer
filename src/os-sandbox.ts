import { createHash } from "node:crypto";
import { constants } from "node:fs";
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
  network: OsSandboxNetworkPolicy;
  /** Canonical absolute path of a host-side egress-bridge unix socket,
   * bind-mounted read-write. Required iff `network` is
   * `"provider-tcp443-dns"` on a bwrap plan; refused by seatbelt, whose
   * profile carries egress internally. */
  egressSocket?: string;
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
  const raw = object(value, ["platform", "executable", "scratch", "accountHome", "readOnlyPaths", "network", "egressSocket", "policyPath"]);
  const platform = raw.platform;
  assert(platform === "darwin" || platform === "linux", "OS_SANDBOX_PLATFORM_INVALID");
  const readOnly = raw.readOnlyPaths === undefined ? [] : (() => {
    assert(Array.isArray(raw.readOnlyPaths) && raw.readOnlyPaths.length <= 256, "OS_SANDBOX_SPEC_INVALID");
    return (raw.readOnlyPaths as unknown[]).map(entry => path(entry));
  })();
  const network = raw.network;
  assert(network === "denied" || network === "loopback" || network === "provider-tcp443-dns", "OS_SANDBOX_NETWORK_INVALID");
  const executable = path(raw.executable), scratch = path(raw.scratch), policyPath = path(raw.policyPath);
  const egressSocket = raw.egressSocket === undefined ? undefined : path(raw.egressSocket);
  assert(egressSocket === undefined || network === "provider-tcp443-dns", "OS_SANDBOX_EGRESS_UNEXPECTED");
  const spec = Object.freeze({ platform, executable, scratch,
    ...(raw.accountHome === undefined ? {} : { accountHome: path(raw.accountHome) }),
    readOnlyPaths: Object.freeze(readOnly), network,
    ...(egressSocket === undefined ? {} : { egressSocket }), policyPath });
  // The writable roots must not contain or enclose the executable or each
  // other: a rw bind over the exe would let the child replace it.
  const inside = (inner: string, outer: string) => inner === outer || inner.startsWith(outer + "/");
  assert(!inside(executable, scratch) && (spec.accountHome === undefined || !inside(executable, spec.accountHome)), "OS_SANDBOX_LAYOUT_INVALID");
  assert(spec.accountHome === undefined || (!inside(scratch, spec.accountHome) && !inside(spec.accountHome, scratch)), "OS_SANDBOX_LAYOUT_INVALID");
  assert(!inside(policyPath, scratch) && (spec.accountHome === undefined || !inside(policyPath, spec.accountHome)), "OS_SANDBOX_LAYOUT_INVALID");
  // The bridge socket takes its own rw bind; nesting it inside a writable root
  // would make the extra bind meaningless, and a socket inside the writable
  // roots could be replaced by the child before the bridge notices.
  assert(egressSocket === undefined || (!inside(egressSocket, scratch)
    && (spec.accountHome === undefined || !inside(egressSocket, spec.accountHome))), "OS_SANDBOX_LAYOUT_INVALID");
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
  // Seatbelt carries egress inside its reviewed profile; a bridge socket is
  // never consumed and admitting one silently would misrecord the plan.
  assert(spec.egressSocket === undefined, "OS_SANDBOX_EGRESS_UNEXPECTED");
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
    ...(spec.egressSocket === undefined ? [] : [{ mode: "rw" as const, target: spec.egressSocket }]),
  ]);
  // The canonical policy binds every mount decision before any argv is
  // wrapped: namespace flags, bind set, and the in-sandbox executable.
  const policy = JSON.stringify({ schema: "agentmixer.os-sandbox-bwrap.v1", backend: "bwrap",
    namespaces: ["user", "mount", "pid", "ipc", "uts", "cgroup", "net"], newSession: true, dieWithParent: true,
    executable: spec.executable, binds,
    ...(spec.egressSocket === undefined ? {} : { egress: { socket: spec.egressSocket, protocol: "connect-tcp443" } }) }) + "\n";
  const prefix = [
    "--unshare-all", "--new-session", "--die-with-parent",
    "--proc", "/proc", "--dev", "/dev",
    ...binds.flatMap(entry => entry.mode === "ro" ? ["--ro-bind", entry.target, entry.target] : ["--bind", entry.target, entry.target]),
    "--clearenv",
  ];
  return Object.freeze({ backend: "bwrap", policy, policySha256: hash(policy), executable: wrapper,
    wrap(invocation: OsSandboxWrapInput) {
      const wrapped = wrapInputOf(invocation);
      // --clearenv scrubs ambient secrets; the child's environment is
      // exactly the caller-closed map, rebuilt in sorted key order.
      const setenv = Object.keys(wrapped.env).sort().flatMap(key => ["--setenv", key, wrapped.env[key]!]);
      return { args: Object.freeze([...prefix, ...setenv, "--chdir", wrapped.cwd, "--", spec.executable, ...wrapped.args]),
        // bwrap itself needs nothing beyond a minimal PATH; the policy env
        // is delivered exclusively through --setenv.
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
