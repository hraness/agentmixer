import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, closeSync, fsyncSync, openSync, writeSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { boundedText, identifier, safeInteger } from "./validation.ts";

/**
 * Per-account browser-session custody. Interactive provider sign-in runs inside
 * one fixed, privately owned browser profile per provider account: cookies and
 * site state persist across launches under that profile, so a returning account
 * is already signed in and a new account never shares another account's
 * session. The profile directory, never its contents, is the custody boundary:
 * this module creates it privately, binds it to the exact account identity,
 * serializes launches through an exclusive durable lock, bounds every launch
 * through a hash-chained journal, and requires proven process exit plus group
 * absence before releasing the lock. A stale lock is a recovery requirement,
 * never permission to take over.
 *
 * No credentials, cookies, page contents, or browser output are read, returned,
 * or logged. The provider supplies only the initial navigation URL; the host
 * supplies the admitted executable. This module cannot prove a rendered page,
 * a completed sign-in, or provider account state — it proves custody.
 */

export type BrowserSessionBinding = Readonly<{
  /** Namespace label for the account's provider family, e.g. "codex". This is
   * an identifier, not provider admission or a closed routing union. */
  provider: string;
  accountId: string;
  owner: string;
  /** The caller's current account-lease fence at launch time. */
  leaseGeneration: number;
  /** This launch's process fence; increments per session process. */
  processGeneration: number;
}>;
export type BrowserSessionRuntimeAdmission = Readonly<{
  /** Absolute canonical path of the reviewed browser executable. */
  executablePath: string;
  /** Observed version evidence, recorded verbatim. */
  version: string;
  /** SHA-256 of the reviewed executable bytes, re-verified at launch. */
  sha256: string;
}>;
export type BrowserSessionOptions = Readonly<{
  binding: BrowserSessionBinding;
  /** Host-owned private root, mode 0700, canonical and user-only. */
  stateRoot: string;
  runtime: BrowserSessionRuntimeAdmission;
  /** Optional initial navigation. https only; no userinfo or fragment policy
   * is relaxed. Omitted launches open the browser's default blank page. */
  url?: string;
  /** Whole preparation deadline, 1 to 120000 milliseconds. */
  startupTimeoutMs?: number;
  /** Maximum session lifetime before a graceful close begins, 60000 to
   * 3600000 milliseconds; default 900000. A login browser must not linger. */
  maxSessionMs?: number;
  /** Ambient environment the GUI-attach allowlist filters. Defaults to
   * `process.env`; trusted hosts and tests pass an explicit map. */
  environment?: Readonly<Record<string, string | undefined>>;
}>;
export type BrowserSessionSpawn = Readonly<{
  executable: string; args: readonly string[]; cwd: string;
  env: Readonly<Record<string, string>>; detached: true; stdio: readonly ["pipe", "pipe", "pipe"];
}>;
/** Trusted system seam for synthetic process tests. This is not a plugin, an
 * agent tool, a configuration input, or a sandboxing decision. */
export interface BrowserSessionSystem {
  spawn(request: BrowserSessionSpawn): ChildProcessWithoutNullStreams;
  processGroup(pid: number): number | null;
  signalGroup(pgid: number, signal: "SIGTERM" | "SIGKILL" | 0): boolean;
}
export type BrowserSessionPhase = "preparing" | "launch-pending" | "running" | "recovery-required" | "closed";
export type BrowserSessionReceipt = Readonly<{
  schema: "xcb.browser-session.v1"; binding: BrowserSessionBinding;
  productionQualified: false;
  browserVersion: string; browserSha256: string;
  launchAttempted: boolean; pid: number | null; pgid: number | null;
  rootExited: boolean; groupAbsent: boolean; stdoutJoined: boolean; stderrJoined: boolean;
  lockReleased: boolean; forcedExit: boolean; gracefulExit: boolean;
  journalPath: string | null; phase: BrowserSessionPhase; failures: readonly string[];
}>;
export type BrowserSessionCloseReceipt = Readonly<{
  binding: BrowserSessionBinding; processExited: boolean; processGroupStopped: boolean;
  stdoutEnded: boolean; stderrEnded: boolean; gracefulExit: boolean;
}>;
export interface BrowserSessionPort {
  readonly binding: BrowserSessionBinding;
  /** Resolves once the launch is proven running; rejects on refused launch. */
  readonly ready: Promise<void>;
  /** Resolves when the session has fully closed, however it ended. */
  readonly closed: Promise<BrowserSessionCloseReceipt>;
  receipt(): BrowserSessionReceipt;
  /** Graceful close bound to the exact session binding: SIGTERM so the
   * profile flushes, SIGKILL fallback, then proven exit, group absence, and
   * stream joins before lock release. A mismatched binding refuses. */
  close(request: { binding: BrowserSessionBinding; deadlineMs?: number }): Promise<BrowserSessionCloseReceipt>;
}

const STDOUT_MAX_BYTES = 8 * 1024 * 1024;
const STDERR_MAX_BYTES = 256 * 1024;
const URL_MAX_BYTES = 2048;
const JOURNAL_MAX_LINES = 32;
const GRACEFUL_EXIT_MS = 5_000;

/** Environment keys a browser child may inherit: locale and identity basics
 * plus the GUI-attach surface (display, wayland, xauthority, runtime dir,
 * session bus). HOME and TMPDIR are always overridden to private run dirs;
 * ambient credentials, proxies, and provider variables never cross. */
const BROWSER_SESSION_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "USER",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
]);

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fail = (code: string): never => { throw new Error(code); };
const assert = (value: unknown, code: string): void => { if (!value) fail(code); };
const digest = (value: unknown): string => { assert(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), "BROWSER_SESSION_PIN_INVALID"); return value as string; };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)), "BROWSER_SESSION_OBJECT_INVALID");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value as object)) {
    assert(typeof key === "string" && keys.includes(key), "BROWSER_SESSION_UNKNOWN_FIELD");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    assert("value" in descriptor, "BROWSER_SESSION_ACCESSOR_DENIED"); result[key as string] = descriptor.value;
  }
  return result;
}
function path(value: unknown): string {
  assert(typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4096 && !/[\x00-\x1f\x7f"\\]/u.test(value), "BROWSER_SESSION_PATH_INVALID");
  return value as string;
}
function bindingOf(value: unknown): BrowserSessionBinding {
  const raw = object(value, ["provider", "accountId", "owner", "leaseGeneration", "processGeneration"]);
  return Object.freeze({
    provider: identifier(raw.provider), accountId: identifier(raw.accountId), owner: identifier(raw.owner),
    leaseGeneration: safeInteger(raw.leaseGeneration, 1, Number.MAX_SAFE_INTEGER),
    processGeneration: safeInteger(raw.processGeneration, 1, Number.MAX_SAFE_INTEGER),
  });
}
const sameBinding = (a: BrowserSessionBinding, b: BrowserSessionBinding) =>
  a.provider === b.provider && a.accountId === b.accountId && a.owner === b.owner
  && a.leaseGeneration === b.leaseGeneration && a.processGeneration === b.processGeneration;
function navigation(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = boundedText(value, URL_MAX_BYTES);
  assert(!/[\x00-\x20]/u.test(text), "BROWSER_SESSION_URL_INVALID");
  const parsed = new URL(text);
  assert(parsed.protocol === "https:" && parsed.username === "" && parsed.password === "", "BROWSER_SESSION_URL_INVALID");
  return parsed.toString();
}
async function directory(value: string): Promise<BigIntStats> {
  const metadata = await lstat(value, { bigint: true });
  assert(await realpath(value) === value && metadata.isDirectory() && metadata.uid === BigInt(process.getuid!()) && (metadata.mode & 0o7777n) === 0o700n, "BROWSER_SESSION_PRIVATE_DIRECTORY_REQUIRED");
  return metadata;
}
async function syncDirectory(value: string): Promise<void> {
  const fd = await open(value, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function ensureDirectory(value: string): Promise<void> {
  try { await mkdir(value, { mode: 0o700 }); await syncDirectory(dirname(value)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await directory(value);
}
async function durableFile(value: string, contents: string): Promise<void> {
  const fd = await open(value, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(contents); await fd.sync(); } finally { await fd.close(); }
  await syncDirectory(dirname(value));
}
async function fixedFile(value: string, contents: string, create: boolean): Promise<void> {
  if (create) try { await durableFile(value, contents); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const fd = await open(value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({ bigint: true });
    assert(before.isFile() && before.uid === BigInt(process.getuid!()) && before.nlink === 1n && (before.mode & 0o7777n) === 0o600n && before.size === BigInt(Buffer.byteLength(contents)), "BROWSER_SESSION_CONFIG_INVALID");
    const read = Buffer.alloc(Buffer.byteLength(contents) + 1), result = await fd.read(read, 0, read.length, 0);
    const after = await fd.stat({ bigint: true }), named = await lstat(value, { bigint: true });
    assert(result.bytesRead === read.length - 1 && read.subarray(0, result.bytesRead).equals(Buffer.from(contents)) && sameFile(before, after) && sameFile(before, named), "BROWSER_SESSION_CONFIG_CHANGED");
  } finally { await fd.close(); }
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean { return ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(key => a[key as keyof BigIntStats] === b[key as keyof BigIntStats]); }
async function bounded<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  const remaining = deadlineMs - Date.now(); if (remaining <= 0) return fail("BROWSER_SESSION_DEADLINE");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("BROWSER_SESSION_DEADLINE")), remaining); })]); }
  finally { clearTimeout(timer); }
}
async function verifyExecutable(executablePath: string, sha256: string): Promise<void> {
  const fd = await open(executablePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({ bigint: true });
    assert(before.isFile() && before.uid === BigInt(process.getuid!()) && before.size > 0n && before.size <= 512n * 1024n * 1024n, "BROWSER_SESSION_EXECUTABLE_INVALID");
    const fileHash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let read = 0;
    while (read <= Number(before.size)) {
      const count = (await fd.read(buffer, 0, Math.min(buffer.length, Number(before.size) + 1 - read), read)).bytesRead;
      if (!count) break;
      read += count; assert(read <= Number(before.size), "BROWSER_SESSION_EXECUTABLE_CHANGED");
      fileHash.update(buffer.subarray(0, count));
    }
    const after = await fd.stat({ bigint: true });
    assert(read === Number(before.size) && sameFile(before, after) && sameFile(before, await lstat(executablePath, { bigint: true }))
      && await realpath(executablePath) === executablePath && fileHash.digest("hex") === sha256, "BROWSER_SESSION_EXECUTABLE_CHANGED");
  } finally { await fd.close(); }
}
/** Reads a marker only as exact expected bytes; any drift refuses. */
async function readJsonMarker(value: string, keys: readonly string[]): Promise<Record<string, unknown> | null> {
  const fd = await open(value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (fd === null) return null;
  try {
    const metadata = await fd.stat({ bigint: true });
    assert(metadata.isFile() && metadata.uid === BigInt(process.getuid!()) && (metadata.mode & 0o7777n) === 0o600n && metadata.size > 0n && metadata.size <= 8192n, "BROWSER_SESSION_MARKER_INVALID");
    const buffer = Buffer.alloc(Number(metadata.size)); const result = await fd.read(buffer, 0, buffer.length, 0);
    assert(result.bytesRead === buffer.length, "BROWSER_SESSION_MARKER_CHANGED");
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    return object(parsed, keys);
  } finally { await fd.close(); }
}

const system: BrowserSessionSystem = {
  spawn: request => spawn(request.executable, [...request.args], { cwd: request.cwd, env: { ...request.env }, detached: true, stdio: ["pipe", "pipe", "pipe"] }),
  processGroup(pid) {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8", timeout: 1_000, maxBuffer: 1024, env: { PATH: "/usr/bin:/bin" } });
    return !result.error && result.status === 0 && /^[1-9][0-9]*$/u.test(result.stdout.trim()) ? Number(result.stdout.trim()) : null;
  },
  signalGroup(pgid, signal) { try { process.kill(-pgid, signal); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } },
};

/** Fixed Chromium-family launch argv for the account's own profile. The
 * password store stays profile-local (`basic`) so cookies never touch the
 * system keyring and no interactive prompt can stall a managed launch; sync is
 * disabled so the session cannot join a vendor account; crash/restore bubbles
 * are suppressed so a recovered profile opens cleanly. */
export function browserSessionArgv(input: { executable: string; profile: string; url?: string }): readonly string[] {
  const args = [
    input.executable,
    `--user-data-dir=${path(input.profile)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--password-store=basic",
  ];
  if (input.url !== undefined) args.push(navigation(input.url)!);
  return Object.freeze(args);
}

export function browserSessionEnvironment(
  ambient: Readonly<Record<string, string | undefined>>,
  input: { home: string; tmp: string },
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(ambient)) {
    if (!BROWSER_SESSION_ENVIRONMENT_KEYS.has(key) || value === undefined) continue;
    if (value.includes("\0") || new TextEncoder().encode(value).byteLength > 64 * 1024) fail("BROWSER_SESSION_ENVIRONMENT_INVALID");
    result[key] = value;
  }
  result.HOME = path(input.home);
  result.TMPDIR = path(input.tmp);
  result.PATH = result.PATH ?? "/usr/bin:/bin";
  return result;
}

function sessionRoot(stateRoot: string, provider: string, accountId: string): string {
  return join(stateRoot, "browser-sessions", provider, accountId);
}

/**
 * Recovers a session directory whose launch lock outlived its process. The
 * caller proves the recorded process is stopped; this function then removes
 * the stale lock and the browser's singleton trio so the profile opens
 * cleanly. It never deletes cookies, history, or the binding marker, and it
 * refuses to run while any lock holder could be alive.
 */
export async function recoverBrowserSession(input: Readonly<{
  stateRoot: string; provider: string; accountId: string;
  proveStopped(binding: BrowserSessionBinding): Promise<boolean>;
}>): Promise<{ recovered: true }> {
  const stateRoot = path(input.stateRoot), provider = identifier(input.provider), accountId = identifier(input.accountId);
  assert(typeof input.proveStopped === "function", "BROWSER_SESSION_RECOVERY_PROOF_REQUIRED");
  const root = sessionRoot(stateRoot, provider, accountId);
  const lockPath = join(root, "lock.json");
  const marker = await readJsonMarker(lockPath, ["schema", "binding", "journalPath"]);
  if (marker === null || marker.schema !== "xcb.browser-session-lock.v1") throw new Error("BROWSER_SESSION_RECOVERY_UNNEEDED");
  const lock = marker;
  const held = bindingOf(lock.binding);
  assert(await input.proveStopped(held), "BROWSER_SESSION_PROCESS_STOP_UNPROVEN");
  // The recorded journal path is evidence for the caller's own diagnosis; the
  // stop proof, not the journal, authorizes this recovery.
  assert(typeof lock.journalPath === "string" && lock.journalPath.length <= 4096, "BROWSER_SESSION_LOCK_INVALID");
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await rm(join(root, "profile", name), { force: true });
  }
  await unlink(lockPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  await syncDirectory(root);
  return { recovered: true };
}

/**
 * Destroys one account's whole browser-session directory as a unit — profile,
 * cookies, markers, locks, and run journals — after proving no launch lock is
 * held by a live process. This is the sign-out/revocation boundary; it is
 * never implied by a close, an expiry, or a failed launch.
 */
export async function purgeBrowserSession(input: Readonly<{
  stateRoot: string; provider: string; accountId: string;
  proveStopped(binding: BrowserSessionBinding): Promise<boolean>;
}>): Promise<{ purged: true }> {
  const stateRoot = path(input.stateRoot), provider = identifier(input.provider), accountId = identifier(input.accountId);
  const root = sessionRoot(stateRoot, provider, accountId);
  const lockPath = join(root, "lock.json");
  // ENOENT means no lock: nothing to prove. Any other lock failure — an
  // unreadable or drifting marker — refuses the purge rather than guessing.
  const lock = await readJsonMarker(lockPath, ["schema", "binding", "journalPath"]);
  if (lock !== null) {
    const held = bindingOf(lock.binding);
    assert(await input.proveStopped(held), "BROWSER_SESSION_PROCESS_STOP_UNPROVEN");
  }
  await rm(root, { recursive: true, force: true });
  await syncDirectory(dirname(root)).catch(() => {});
  return { purged: true };
}

/** Synchronous custody handle; preparation and launch proceed asynchronously.
 * The caller must already hold the matching account lease. Callers pass only
 * the admitted executable, the account binding, and an optional https URL —
 * profile, environment, and argv are owned here. */
export function createBrowserSession(options: BrowserSessionOptions, trustedSystem: BrowserSessionSystem = system): BrowserSessionPort {
  const raw = object(options, ["binding", "stateRoot", "runtime", "url", "startupTimeoutMs", "maxSessionMs", "environment"]);
  const owned = bindingOf(raw.binding);
  const stateRoot = path(raw.stateRoot);
  const runtimeRaw = object(raw.runtime, ["executablePath", "version", "sha256"]);
  const runtime = Object.freeze({ executablePath: path(runtimeRaw.executablePath), version: identifier(runtimeRaw.version), sha256: digest(runtimeRaw.sha256) });
  const url = navigation(raw.url);
  const startupMs = safeInteger(raw.startupTimeoutMs ?? 10_000, 1, 120_000), startupDeadline = Date.now() + startupMs;
  const maxSessionMs = safeInteger(raw.maxSessionMs ?? 900_000, 60_000, 3_600_000);
  const host = Object.freeze({ spawn: trustedSystem.spawn.bind(trustedSystem), processGroup: trustedSystem.processGroup.bind(trustedSystem), signalGroup: trustedSystem.signalGroup.bind(trustedSystem) });
  const failures = new Set<string>();
  const state = { phase: "preparing" as BrowserSessionPhase, launchAttempted: false, pid: null as number | null, pgid: null as number | null, rootExited: false, groupAbsent: false, stdoutJoined: false, stderrJoined: false, lockReleased: false, forcedExit: false, journalPath: null as string | null };
  let child: ChildProcessWithoutNullStreams | undefined, root: string | undefined, scratch: string | undefined, profileDir: string | undefined, lockPath: string | undefined, lockContents = "", scratchIdentity: BigIntStats | undefined;
  let lockOwned = false, journalFd: number | undefined, journalFailed = false, previous: string | null = null, sequence = 0;
  let closedEvent = false, nativeStdoutClosed = false, nativeStderrClosed = false, nativeStdinClosed = false, spawnEvent = false, spawnError = false, closing = false, stopTask: Promise<BrowserSessionCloseReceipt> | undefined;
  let resolveExit!: () => void, resolveClosed!: () => void;
  const exited = new Promise<void>(done => { resolveExit = done; }), nativeClosed = new Promise<void>(done => { resolveClosed = done; });
  const nativeStreamClosures: Promise<void>[] = [];
  const receipt = (): BrowserSessionReceipt => Object.freeze({ schema: "xcb.browser-session.v1", binding: owned,
    productionQualified: false, browserVersion: runtime.version, browserSha256: runtime.sha256,
    ...state, gracefulExit: state.rootExited && !state.forcedExit, failures: Object.freeze([...failures]) });
  function recordFailure(code: string) { if (failures.size < 24) failures.add(code); }
  function persist() {
    const fd = journalFd;
    if (fd === undefined || journalFailed || sequence >= JOURNAL_MAX_LINES) { journalFailed = true; throw new Error("BROWSER_SESSION_JOURNAL_FAILED"); }
    const line = JSON.stringify({ sequence, previousSha256: previous, snapshot: receipt() }) + "\n";
    try { const bytes = Buffer.from(line); assert(bytes.length <= 8192, "BROWSER_SESSION_JOURNAL_BOUND"); let offset = 0;
      while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); assert(count > 0, "BROWSER_SESSION_JOURNAL_FAILED"); offset += count; }
      fsyncSync(fd); previous = hash(line); sequence++;
    } catch { journalFailed = true; fail("BROWSER_SESSION_JOURNAL_FAILED"); }
  }
  function alivePreparation() { assert(!closing && Date.now() < startupDeadline, "BROWSER_SESSION_START_CANCELLED"); }
  const preparation = Promise.resolve().then(async () => {
    alivePreparation(); await directory(stateRoot);
    await verifyExecutable(runtime.executablePath, runtime.sha256); alivePreparation();
    const sessions = join(stateRoot, "browser-sessions"), providerRoot = join(sessions, owned.provider);
    await ensureDirectory(sessions); await ensureDirectory(providerRoot);
    const sessionDir = join(providerRoot, owned.accountId);
    let created = false;
    try { await mkdir(sessionDir, { mode: 0o700 }); created = true; await syncDirectory(providerRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await directory(sessionDir);
    // The marker binds this directory to the exact account identity forever.
    // A foreign or drifting marker refuses the launch rather than inheriting
    // another account's cookies.
    await fixedFile(join(sessionDir, "binding.json"),
      JSON.stringify({ schema: "xcb.browser-session-binding.v1", provider: owned.provider, accountId: owned.accountId }) + "\n", created);
    // A pre-existing lock means a previous launch never proved its close.
    // Recover explicitly; never inherit an ambiguous profile.
    const existingLock = await lstat(join(sessionDir, "lock.json")).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
    assert(!existingLock, "BROWSER_SESSION_RECOVERY_REQUIRED");
    root = join(sessionDir, "runs", `${owned.owner}-${owned.processGeneration}-${randomBytes(12).toString("hex")}`);
    await mkdir(dirname(root), { mode: 0o700, recursive: true }); await mkdir(root, { mode: 0o700 }); await syncDirectory(dirname(root));
    state.journalPath = join(root, "custody.jsonl");
    journalFd = openSync(state.journalPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fsyncSync(journalFd); await syncDirectory(root);
    lockPath = join(sessionDir, "lock.json");
    lockContents = JSON.stringify({ schema: "xcb.browser-session-lock.v1", binding: owned, journalPath: state.journalPath }) + "\n";
    const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); lockOwned = true;
    try { await lock.writeFile(lockContents); await lock.sync(); } finally { await lock.close(); }
    await syncDirectory(sessionDir);
    persist();
    // Profile writes are admitted only by this exact durable lock.
    profileDir = join(sessionDir, "profile"); await ensureDirectory(profileDir);
    scratch = join(root, "scratch"); await mkdir(scratch, { mode: 0o700 }); scratchIdentity = await directory(scratch);
    const home = join(scratch, "home"), tmp = join(scratch, "tmp"), work = join(scratch, "work");
    for (const dir of [home, tmp, work]) await mkdir(dir, { mode: 0o700 });
    alivePreparation();
    const args = browserSessionArgv({ executable: runtime.executablePath, profile: profileDir, ...(url === undefined ? {} : { url }) });
    const ambient = raw.environment === undefined ? process.env : object(raw.environment, [...Object.keys(raw.environment as object)]);
    const env = browserSessionEnvironment(ambient as Record<string, string | undefined>, { home, tmp });
    alivePreparation(); state.phase = "launch-pending"; state.launchAttempted = true; persist();
    // The durable record deliberately leaves the PID unknown. A crash here
    // requires independent recovery, even if no child was created.
    child = host.spawn(Object.freeze({ executable: runtime.executablePath, args, cwd: work, env: Object.freeze(env), detached: true, stdio: Object.freeze(["pipe", "pipe", "pipe"] as const) }));
    state.pid = child.pid ?? null;
    child.once("spawn", () => { spawnEvent = true; });
    child.once("exit", () => { state.rootExited = true; resolveExit(); });
    child.once("close", () => { closedEvent = true; if (!spawnEvent && spawnError && state.pid === null) { state.rootExited = true; state.groupAbsent = true; resolveExit(); } resolveClosed(); });
    child.once("error", () => { spawnError = true; recordFailure("native-spawn"); });
    for (const [stream, mark] of [[child.stdout, () => { nativeStdoutClosed = true; }], [child.stderr, () => { nativeStderrClosed = true; }], [child.stdin, () => { nativeStdinClosed = true; }]] as const) {
      nativeStreamClosures.push(new Promise<void>(done => stream.once("close", () => { mark(); done(); })));
    }
    let stdoutBytes = 0, stderrBytes = 0;
    const streamFailure = (code: string) => { recordFailure(code); void close({ binding: owned, deadlineMs: 10_000 }).catch(() => {}); };
    // Browser output is counted, never surfaced: it may embed navigated URLs.
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > STDOUT_MAX_BYTES) streamFailure("stdout-bound"); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > STDERR_MAX_BYTES) streamFailure("stderr-bound"); });
    child.stdout.on("error", () => streamFailure("native-stdout")); child.stderr.on("error", () => streamFailure("native-stderr")); child.stdin.on("error", () => streamFailure("native-stdin"));
    persist();
    assert(state.pid !== null && Number.isSafeInteger(state.pid) && state.pid > 0, "BROWSER_SESSION_PID_UNPROVEN");
    state.pgid = host.processGroup(state.pid!); assert(state.pgid === state.pid, "BROWSER_SESSION_GROUP_UNPROVEN");
    alivePreparation(); assert(!state.rootExited, "BROWSER_SESSION_PREMATURE_EXIT"); state.phase = "running"; persist();
    // A login session is interactive and bounded: at the deadline the session
    // begins the same graceful close a caller would request. SIGTERM lets the
    // profile flush cookies to disk; a forced close records gracefulExit=false.
    setTimeout(() => { recordFailure("session-deadline"); void close({ binding: owned, deadlineMs: GRACEFUL_EXIT_MS + 10_000 }).catch(() => {}); }, maxSessionMs).unref();
  }).catch(error => {
    recordFailure(error instanceof Error && /^BROWSER_SESSION_[A-Z_]+$/u.test(error.message) ? error.message : "preparation-failed");
    if (!state.launchAttempted) { state.rootExited = true; state.groupAbsent = true; resolveExit(); }
    if (error instanceof Error && error.message === "BROWSER_SESSION_RECOVERY_REQUIRED") {
      state.phase = "recovery-required";
      throw error;
    }
    throw new Error("BROWSER_SESSION_PREPARATION_FAILED");
  });
  void preparation.catch(() => {});
  const ready = bounded(preparation, startupDeadline).then(() => {}).catch(error => {
    if (!(error instanceof Error && error.message === "BROWSER_SESSION_RECOVERY_REQUIRED")) {
      recordFailure("startup-failed"); void close({ binding: owned, deadlineMs: 10_000 }).catch(() => {});
      throw new Error("BROWSER_SESSION_UNAVAILABLE");
    }
    throw error;
  });
  void ready.catch(() => {});
  const closed = new Promise<BrowserSessionCloseReceipt>(done => {
    void exited.then(() => close({ binding: owned, deadlineMs: 30_000 })).then(done);
  });
  void closed.catch(() => {});
  function close(request: { binding: BrowserSessionBinding; deadlineMs?: number }): Promise<BrowserSessionCloseReceipt> {
    const input = object(request, ["binding", "deadlineMs"]);
    assert(sameBinding(bindingOf(input.binding), owned), "BROWSER_SESSION_CLOSE_BINDING_MISMATCH");
    const now = Date.now(), deadline = safeInteger(input.deadlineMs ?? 15_000, 1, 120_000) + now;
    if (stopTask !== undefined) return stopTask;
    closing = true;
    const task = Promise.resolve().then(async () => {
      try {
        await bounded(preparation.catch(() => {}), deadline);
        if (child) {
          try { child.stdin.end(); } catch { recordFailure("stdin-end"); }
          for (const signal of ["SIGTERM", "SIGKILL"] as const) {
            // An exited/reaped root no longer anchors numeric process-group
            // identity. Never signal a possibly reused group after that point.
            if (state.rootExited) {
              if (state.pgid === state.pid && state.pgid !== null) state.groupAbsent = !host.signalGroup(state.pgid, 0);
              break;
            }
            if (state.pgid !== null && state.pgid === state.pid) host.signalGroup(state.pgid, signal);
            else if (!state.rootExited) child.kill(signal);
            // Dispatching SIGKILL is itself the force evidence — the process
            // may already have reaped itself by the time the signal returns.
            if (signal === "SIGKILL") state.forcedExit = true;
            try { await bounded(exited, Math.min(deadline, Date.now() + (signal === "SIGTERM" ? GRACEFUL_EXIT_MS : 1_000))); } catch {}
          }
          if (!state.rootExited) state.forcedExit = true;
          if (state.rootExited && state.pgid === state.pid && state.pgid !== null) state.groupAbsent = !host.signalGroup(state.pgid, 0);
          await bounded(Promise.all([nativeClosed, ...nativeStreamClosures]), deadline);
          assert(closedEvent && state.rootExited && state.groupAbsent && nativeStdoutClosed && nativeStderrClosed && nativeStdinClosed, "BROWSER_SESSION_STOP_UNPROVEN");
        } else assert(!state.launchAttempted && state.rootExited, "BROWSER_SESSION_LAUNCH_UNCERTAIN");
        state.stdoutJoined = true; state.stderrJoined = true;
        if (lockOwned) {
          assert(!journalFailed, "BROWSER_SESSION_JOURNAL_FAILED");
          await fixedFile(lockPath!, lockContents, false);
          if (scratch && scratchIdentity) { const current = await directory(scratch); assert(current.dev === scratchIdentity.dev && current.ino === scratchIdentity.ino, "BROWSER_SESSION_SCRATCH_CHANGED"); await rm(scratch, { recursive: true }); scratch = undefined; }
          // The custody journal and profile stay: they are this launch's
          // recovery evidence and the account's persistent session state.
          // Terminal process/stream proof must be durable before the exclusive
          // lock disappears. A crash after unlink may resurrect a stale lock,
          // which safely requires recovery; it cannot resurrect the process.
          state.phase = "closed"; persist(); await unlink(lockPath!); lockOwned = false; state.lockReleased = true;
          try { await syncDirectory(dirname(lockPath!)); } catch { recordFailure("lock-release-sync"); }
        } else state.lockReleased = !state.launchAttempted;
        state.phase = "closed";
      } catch { recordFailure("cleanup-unproven"); state.phase = "recovery-required"; if (journalFd !== undefined && !journalFailed) try { persist(); } catch {} }
      const proven = state.phase === "closed" && state.lockReleased && !journalFailed;
      if (proven && journalFd !== undefined) { closeSync(journalFd); journalFd = undefined; }
      return Object.freeze({ binding: owned, processExited: state.rootExited, processGroupStopped: proven && state.groupAbsent,
        stdoutEnded: state.stdoutJoined, stderrEnded: state.stderrJoined, gracefulExit: state.rootExited && !state.forcedExit });
    });
    stopTask = task;
    void task.then(result => { if (!result.processGroupStopped && stopTask === task) stopTask = undefined; });
    return task;
  }
  return Object.freeze({ binding: owned, ready, closed, receipt, close });
}
