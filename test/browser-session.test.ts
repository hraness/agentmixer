import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { browserSessionArgv, browserSessionEnvironment, createBrowserSession, purgeBrowserSession, recoverBrowserSession, type BrowserSessionBinding, type BrowserSessionOptions, type BrowserSessionPort, type BrowserSessionSpawn, type BrowserSessionSystem } from "../src/browser-session.ts";

const sha = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");
const binding: BrowserSessionBinding = { provider: "synthetic-provider", accountId: "synthetic-account", owner: "synthetic-owner", leaseGeneration: 2, processGeneration: 3 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Real private filesystem boundary, synthetic detached browser process. No
 * executable, browser, cookie, credential, network, or GUI is used here. */
async function fixture(input: {
  onSpawn?: (request: BrowserSessionSpawn) => void;
  stop?: "hold" | "exit-only" | "root-and-close" | "kill-only"; pgid?: number | null; pid?: number | null;
  spawnFailsBeforePid?: boolean;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xcb-browser-session-test-")));
  await chmod(root, 0o700); const stateRoot = join(root, "state"); await mkdir(stateRoot, { mode: 0o700 });
  const executablePath = join(root, "synthetic-browser");
  await writeFile(executablePath, "synthetic browser bytes; never run", { mode: 0o500 });
  let nextPid = 42001;
  const signals: ("SIGTERM" | "SIGKILL" | 0)[] = [], spawns: BrowserSessionSpawn[] = [], ports: BrowserSessionPort[] = [];
  interface Kid { child: ChildProcessWithoutNullStreams; native: EventEmitter; stdout: PassThrough; stderr: PassThrough; groupPresent: boolean; exited: boolean; closedEvent: boolean;
    exitRoot(): void; closeStreams(): void; emitClose(): void; finish(): void; }
  const kids: Kid[] = [];
  function makeKid(assignedPid: number | undefined): Kid {
    const native = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough();
    const stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const kid: Kid = { native, stdout, stderr, groupPresent: true, exited: false, closedEvent: false,
      child: undefined as unknown as ChildProcessWithoutNullStreams,
      exitRoot() { if (!kid.exited) { kid.exited = true; native.emit("exit", 0, null); } },
      closeStreams() { stdin.destroy(); stdout.destroy(); stderr.destroy(); },
      emitClose() { if (!kid.closedEvent) { kid.closedEvent = true; native.emit("close", 0, null); } },
      finish() { kid.groupPresent = false; kid.exitRoot(); kid.closeStreams(); kid.emitClose(); } };
    kid.child = Object.assign(native, { pid: assignedPid, stdin, stdout, stderr, kill(signal: "SIGTERM" | "SIGKILL") { signals.push(signal); kid.finish(); return true; } }) as unknown as ChildProcessWithoutNullStreams;
    return kid;
  }
  const host: BrowserSessionSystem = {
    spawn(request) {
      const kid = makeKid(input.spawnFailsBeforePid || input.pid === null ? undefined : input.pid ?? nextPid++);
      kids.push(kid); spawns.push(request); input.onSpawn?.(request); queueMicrotask(() => {
        if (input.spawnFailsBeforePid) { kid.native.emit("error", new Error("synthetic spawn rejection")); kid.closeStreams(); kid.emitClose(); }
        else kid.native.emit("spawn");
      }); return kid.child;
    },
    processGroup: requested => input.pgid === undefined ? requested : input.pgid,
    signalGroup(group, signal) { signals.push(signal);
      const kid = kids.find(candidate => candidate.child.pid === group);
      if (kid === undefined) return true;
      if (signal === 0) return kid.groupPresent;
      if (input.stop === "kill-only") { if (signal === "SIGKILL") kid.finish(); }
      else if (input.stop === "exit-only") kid.exitRoot();
      else if (input.stop === "root-and-close") { kid.groupPresent = false; kid.exitRoot(); kid.emitClose(); }
      else if (input.stop !== "hold") kid.finish();
      return true;
    },
  };
  const options: BrowserSessionOptions = { binding, stateRoot,
    runtime: { executablePath, version: "synthetic-browser-1", sha256: sha("synthetic browser bytes; never run") },
    environment: { DISPLAY: ":99", XAUTHORITY: "/synthetic/xauth", SECRET_TOKEN: "denied", PATH: "/custom/bin" } };
  const create = (overrides: Partial<BrowserSessionOptions> = {}, system = host) => { const port = createBrowserSession({ ...options, ...overrides } as BrowserSessionOptions, system); ports.push(port); return port; };
  const stop = (port: BrowserSessionPort, milliseconds = 1000) => port.close({ binding: port.binding, deadlineMs: milliseconds });
  cleanups.push(async () => { for (const kid of kids) kid.finish(); for (const port of ports) await stop(port, 1000).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const sessionDir = join(stateRoot, "browser-sessions", binding.provider, binding.accountId);
  return { root, stateRoot, options, create, host, spawns, signals, stop, kids, kid: (index = kids.length - 1) => kids[index]!,
    sessionDir, profileDir: join(sessionDir, "profile") };
}
function expectStopped(result: Awaited<ReturnType<BrowserSessionPort["close"]>>, expected = binding) {
  expect(result).toEqual({ binding: expected, processExited: true, processGroupStopped: true, stdoutEnded: true, stderrEnded: true, gracefulExit: true });
}

test("launches the admitted executable with the account profile, a fixed argv, and a closed environment", async () => {
  const f = await fixture(), port = f.create({ url: "https://provider.example/login" }); await port.ready;
  const request = f.spawns[0]!;
  expect(request.executable).toBe(f.options.runtime.executablePath);
  expect(request.args).toEqual(browserSessionArgv({ executable: f.options.runtime.executablePath, profile: f.profileDir, url: "https://provider.example/login" }));
  expect(request.args[0]).toBe(f.options.runtime.executablePath);
  expect(request.args[1]).toBe(`--user-data-dir=${f.profileDir}`);
  expect(request.args).toContain("--password-store=basic"); expect(request.args).toContain("--disable-sync");
  expect(request.args.at(-1)).toBe("https://provider.example/login");
  expect(request.detached).toBe(true); expect(request.stdio).toEqual(["pipe", "pipe", "pipe"]);
  expect(request.env.DISPLAY).toBe(":99"); expect(request.env.PATH).toBe("/custom/bin");
  expect("SECRET_TOKEN" in request.env).toBe(false);
  expect(request.env.HOME!.startsWith(f.sessionDir)).toBe(true); expect(request.env.TMPDIR!.startsWith(f.sessionDir)).toBe(true);
  expect(request.cwd.startsWith(f.sessionDir)).toBe(true);
  expect(port.receipt()).toMatchObject({ productionQualified: false, phase: "running", launchAttempted: true, pid: 42001, pgid: 42001 });
  await writeFile(join(f.profileDir, "Cookies"), "synthetic cookie jar; never read", { mode: 0o600 });
  expectStopped(await f.stop(port));
  const receipt = port.receipt();
  expect(receipt).toMatchObject({ phase: "closed", lockReleased: true, rootExited: true, groupAbsent: true, gracefulExit: true });
  // The persistent profile and its cookies survive a clean close; scratch does not.
  expect(await readFile(join(f.profileDir, "Cookies"), "utf8")).toBe("synthetic cookie jar; never read");
  expect((await readdir(f.sessionDir)).sort()).toEqual(["binding.json", "profile", "runs"]);
  const runDirs = await readdir(join(f.sessionDir, "runs"));
  expect(runDirs).toHaveLength(1);
  expect(await readdir(join(f.sessionDir, "runs", runDirs[0]!))).toEqual(["custody.jsonl"]);
  // A returning account reuses exactly the same profile — cookies carry over.
  const next = f.create({ binding: { ...binding, processGeneration: 4 } }); await next.ready;
  expect(f.spawns[1]!.args[1]).toBe(`--user-data-dir=${f.profileDir}`);
  expectStopped(await f.stop(next), next.binding);
});

test("the custody journal is hash-chained and terminal proof precedes lock release", async () => {
  const f = await fixture(), port = f.create(); await port.ready;
  expectStopped(await f.stop(port));
  const lines = (await readFile(port.receipt().journalPath!, "utf8")).trim().split("\n");
  let previous: string | null = null;
  for (let index = 0; index < lines.length; index++) { const record = JSON.parse(lines[index]!); expect(record.sequence).toBe(index); expect(record.previousSha256).toBe(previous); previous = sha(lines[index]! + "\n"); }
  expect(JSON.parse(lines.at(-1)!).snapshot).toMatchObject({ phase: "closed", rootExited: true, groupAbsent: true, lockReleased: false });
  expect(JSON.stringify(port.receipt())).not.toContain("synthetic cookie");
});

test("a held lock refuses takeover and recovery requires an independent stop proof", async () => {
  const f = await fixture(), port = f.create(); await port.ready;
  const contender = f.create({ binding: { ...binding, owner: "contender", leaseGeneration: 9, processGeneration: 9 } });
  await expect(contender.ready).rejects.toThrow("BROWSER_SESSION_RECOVERY_REQUIRED");
  expect(f.spawns).toHaveLength(1); expect(f.signals).toHaveLength(0);
  // Recovery refuses while the recorded process may still be alive.
  await expect(recoverBrowserSession({ stateRoot: f.stateRoot, provider: binding.provider, accountId: binding.accountId, proveStopped: () => Promise.resolve(false) }))
    .rejects.toThrow("BROWSER_SESSION_PROCESS_STOP_UNPROVEN");
  expectStopped(await f.stop(port));
});

test("recovery removes the stale lock and singleton trio but never the cookies", async () => {
  const f = await fixture(), port = f.create(); await port.ready; expectStopped(await f.stop(port));
  await writeFile(join(f.profileDir, "Cookies"), "synthetic cookie jar", { mode: 0o600 });
  // A crashed later launch left its durable lock and the browser singletons.
  const lockPath = join(f.sessionDir, "lock.json");
  await writeFile(lockPath, JSON.stringify({ schema: "xcb.browser-session-lock.v1", binding, journalPath: join(f.sessionDir, "runs", "crashed", "custody.jsonl") }) + "\n", { mode: 0o600 });
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) await writeFile(join(f.profileDir, name), "stale", { mode: 0o600 });
  const contender = f.create({ binding: { ...binding, processGeneration: 4 } });
  await expect(contender.ready).rejects.toThrow("BROWSER_SESSION_RECOVERY_REQUIRED");
  const result = await recoverBrowserSession({ stateRoot: f.stateRoot, provider: binding.provider, accountId: binding.accountId, proveStopped: held => { expect(held).toEqual(binding); return Promise.resolve(true); } });
  expect(result).toEqual({ recovered: true });
  await expect(lstat(lockPath)).rejects.toThrow();
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) await expect(lstat(join(f.profileDir, name))).rejects.toThrow();
  expect(await readFile(join(f.profileDir, "Cookies"), "utf8")).toBe("synthetic cookie jar");
  expect(await readFile(join(f.sessionDir, "binding.json"), "utf8")).toContain("synthetic-account");
  const next = f.create({ binding: { ...binding, processGeneration: 4 } }); await next.ready; expectStopped(await f.stop(next), next.binding);
});

test("recovery refuses an absent or malformed lock and never guesses", async () => {
  const f = await fixture();
  await expect(recoverBrowserSession({ stateRoot: f.stateRoot, provider: binding.provider, accountId: binding.accountId, proveStopped: () => Promise.resolve(true) }))
    .rejects.toThrow("BROWSER_SESSION_RECOVERY_UNNEEDED");
  const port = f.create(); await port.ready; expectStopped(await f.stop(port));
  // A forged marker over a closed session is not a recoverable lock.
  await writeFile(join(f.sessionDir, "lock.json"), "{\"schema\":\"forged\"}\n", { mode: 0o600 });
  await expect(recoverBrowserSession({ stateRoot: f.stateRoot, provider: binding.provider, accountId: binding.accountId, proveStopped: () => Promise.resolve(true) }))
    .rejects.toThrow("BROWSER_SESSION_RECOVERY_UNNEEDED");
  // A syntactically valid lock still demands an independent stop proof.
  await writeFile(join(f.sessionDir, "lock.json"), JSON.stringify({ schema: "xcb.browser-session-lock.v1", binding, journalPath: join(f.sessionDir, "runs", "x", "custody.jsonl") }) + "\n", { mode: 0o600 });
  await expect(recoverBrowserSession({ stateRoot: f.stateRoot, provider: binding.provider, accountId: binding.accountId, proveStopped: () => Promise.resolve(false) }))
    .rejects.toThrow("BROWSER_SESSION_PROCESS_STOP_UNPROVEN");
  expect(await recoverBrowserSession({ stateRoot: f.stateRoot, provider: binding.provider, accountId: binding.accountId, proveStopped: () => Promise.resolve(true) })).toEqual({ recovered: true });
});

test("purge destroys the profile as a unit only after stop proof", async () => {
  const f = await fixture(), port = f.create(); await port.ready;
  await writeFile(join(f.profileDir, "Cookies"), "synthetic cookie jar", { mode: 0o600 });
  await expect(purgeBrowserSession({ stateRoot: f.stateRoot, provider: binding.provider, accountId: binding.accountId, proveStopped: () => Promise.resolve(false) }))
    .rejects.toThrow("BROWSER_SESSION_PROCESS_STOP_UNPROVEN");
  expect(await readFile(join(f.profileDir, "Cookies"), "utf8")).toBe("synthetic cookie jar");
  expectStopped(await f.stop(port));
  expect(await purgeBrowserSession({ stateRoot: f.stateRoot, provider: binding.provider, accountId: binding.accountId, proveStopped: () => Promise.resolve(true) })).toEqual({ purged: true });
  await expect(lstat(f.sessionDir)).rejects.toThrow();
  expect(await purgeBrowserSession({ stateRoot: f.stateRoot, provider: binding.provider, accountId: "absent-account", proveStopped: () => Promise.resolve(true) })).toEqual({ purged: true });
});

test("rejects a drifting binding marker rather than inheriting another account's profile", async () => {
  const f = await fixture(), port = f.create(); await port.ready; expectStopped(await f.stop(port));
  await writeFile(join(f.sessionDir, "binding.json"), JSON.stringify({ schema: "xcb.browser-session-binding.v1", provider: binding.provider, accountId: "other-account" }) + "\n", { mode: 0o600 });
  const port2 = f.create({ binding: { ...binding, processGeneration: 4 } });
  await expect(port2.ready).rejects.toThrow("BROWSER_SESSION_UNAVAILABLE");
  // Never launched and never locked: there is nothing to prove or recover.
  expect(await f.stop(port2)).toMatchObject({ processGroupStopped: true, processExited: true });
  expect(await readFile(join(f.sessionDir, "binding.json"), "utf8")).toContain("other-account");
});

test("accounts never share a profile root", async () => {
  const f = await fixture();
  const first = f.create(); await first.ready;
  const second = f.create({ binding: { ...binding, accountId: "other-account" } }); await second.ready;
  expect(f.spawns[0]!.args[1]).not.toBe(f.spawns[1]!.args[1]);
  expect(f.spawns[1]!.args[1]).toContain("other-account");
  expectStopped(await f.stop(first)); expectStopped(await f.stop(second), second.binding);
});

test("close requires the exact session binding", async () => {
  const f = await fixture(), port = f.create(); await port.ready;
  for (const changed of [{ accountId: "other" }, { owner: "other" }, { provider: "other" }, { leaseGeneration: 9 }, { processGeneration: 9 }])
    expect(() => port.close({ binding: { ...binding, ...changed }, deadlineMs: 1000 })).toThrow("BROWSER_SESSION_CLOSE_BINDING_MISMATCH");
  expect(() => port.close({ binding, deadlineMs: 1000, extra: true } as never)).toThrow("BROWSER_SESSION_UNKNOWN_FIELD");
  expect(f.signals).toHaveLength(0); expectStopped(await f.stop(port));
});

test.each(["http://provider.example", "https://user:pw@provider.example", "ftp://provider.example"])("refuses non-conforming navigation %s", async url => {
  const f = await fixture();
  expect(() => f.create({ url })).toThrow("BROWSER_SESSION_URL_INVALID");
  expect(f.spawns).toHaveLength(0);
});

test("rejects executable drift, symlinked paths, and a shared state root", async () => {
  const f = await fixture();
  const pin = f.create({ runtime: { ...f.options.runtime, sha256: sha("wrong") } });
  await expect(pin.ready).rejects.toThrow("BROWSER_SESSION_UNAVAILABLE"); expect(f.spawns).toHaveLength(0);
  const link = join(f.root, "browser-link"); await symlink(f.options.runtime.executablePath, link);
  const linked = f.create({ runtime: { ...f.options.runtime, executablePath: link } });
  await expect(linked.ready).rejects.toThrow("BROWSER_SESSION_UNAVAILABLE");
  const stateLink = join(f.root, "state-link"); await symlink(f.stateRoot, stateLink);
  const linkedState = f.create({ stateRoot: stateLink });
  await expect(linkedState.ready).rejects.toThrow("BROWSER_SESSION_UNAVAILABLE");
  await chmod(f.stateRoot, 0o755);
  const shared = f.create();
  await expect(shared.ready).rejects.toThrow("BROWSER_SESSION_UNAVAILABLE");
  expect(f.spawns).toHaveLength(0);
});

test("an uncertain spawn retains custody and cannot authorize a new generation", async () => {
  const f = await fixture({ onSpawn() { throw new Error("private native error detail"); } }), port = f.create();
  await expect(port.ready).rejects.toThrow("BROWSER_SESSION_UNAVAILABLE");
  expect((await f.stop(port)).processGroupStopped).toBe(false);
  expect(port.receipt()).toMatchObject({ phase: "recovery-required", launchAttempted: true, pid: null, lockReleased: false });
  expect(JSON.stringify(port.receipt())).not.toContain("private native error detail");
  const before = readFileSync(join(f.sessionDir, "lock.json"), "utf8");
  const next = f.create({ binding: { ...binding, leaseGeneration: 99, processGeneration: 99 } });
  await expect(next.ready).rejects.toThrow("BROWSER_SESSION_RECOVERY_REQUIRED");
  expect(readFileSync(join(f.sessionDir, "lock.json"), "utf8")).toBe(before); expect(f.spawns).toHaveLength(1);
  await recoverBrowserSession({ stateRoot: f.stateRoot, provider: binding.provider, accountId: binding.accountId, proveStopped: () => Promise.resolve(true) });
});

test("a spawn error with no PID proves no process only after child and streams close", async () => {
  const f = await fixture({ spawnFailsBeforePid: true }), port = f.create();
  await expect(port.ready).rejects.toThrow("BROWSER_SESSION_UNAVAILABLE");
  expectStopped(await f.stop(port));
  expect(port.receipt()).toMatchObject({ launchAttempted: true, pid: null, groupAbsent: true, lockReleased: true, phase: "closed" });
  expect(f.signals).toHaveLength(0);
});

test("root exit and a claimed close cannot release custody while native streams remain open", async () => {
  const f = await fixture({ stop: "root-and-close" }), port = f.create(); await port.ready;
  expect((await f.stop(port, 40)).processGroupStopped).toBe(false);
  expect(port.receipt()).toMatchObject({ rootExited: true, groupAbsent: true, lockReleased: false, phase: "recovery-required" });
  expect(readFileSync(join(f.sessionDir, "lock.json"), "utf8")).toContain("synthetic-account");
  f.kid().closeStreams();
  const result = await f.stop(port); expect(result).toMatchObject({ processExited: true, processGroupStopped: true, gracefulExit: true });
});

test("a group present after root exit retains custody until absent", async () => {
  const f = await fixture({ stop: "exit-only" }), port = f.create(); await port.ready;
  expect((await f.stop(port, 40)).processGroupStopped).toBe(false);
  expect(f.signals).toContain("SIGTERM"); expect(f.signals).not.toContain("SIGKILL");
  expect(port.receipt()).toMatchObject({ rootExited: true, lockReleased: false, phase: "recovery-required" });
  f.kid().finish(); expectStopped(await f.stop(port));
});

test("an unproven detached group cannot be replaced with root-only kill proof", async () => {
  const f = await fixture({ pgid: 999 }), port = f.create(); await expect(port.ready).rejects.toThrow("BROWSER_SESSION_UNAVAILABLE");
  const result = await f.stop(port); expect(result.processExited).toBe(true); expect(result.processGroupStopped).toBe(false);
  expect(port.receipt().lockReleased).toBe(false); expect(f.signals).toContain("SIGTERM");
});

test("a browser that ignores SIGTERM is force-killed and never recorded as graceful", async () => {
  const f = await fixture({ stop: "kill-only" }), port = f.create(); await port.ready;
  // The deadline must outlive the fixed five-second graceful SIGTERM window.
  const result = await f.stop(port, 10_000);
  expect(result).toMatchObject({ processExited: true, processGroupStopped: true, gracefulExit: false });
  expect(f.signals).toEqual(["SIGTERM", "SIGKILL", 0]);
  expect(port.receipt()).toMatchObject({ forcedExit: true, gracefulExit: false, lockReleased: true, phase: "closed" });
}, 15_000);

test("output beyond the bound closes the session and records the failure", async () => {
  const f = await fixture(), port = f.create(); await port.ready;
  f.kid().stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1));
  const result = await port.closed;
  expect(result).toMatchObject({ processExited: true, processGroupStopped: true });
  expect(port.receipt().failures).toContain("stdout-bound");
  expect(f.signals).toContain("SIGTERM");
});

test("immediate close prevents launch and shares one result", async () => {
  const f = await fixture(), port = f.create(), first = f.stop(port), second = f.stop(port);
  expect(first).toBe(second); expect((await first).processExited).toBe(true);
  await expect(port.ready).rejects.toThrow("BROWSER_SESSION_UNAVAILABLE"); expect(f.spawns).toHaveLength(0);
});

test("the environment helper keeps only the GUI allowlist and overrides HOME and TMPDIR", () => {
  const env = browserSessionEnvironment(
    { DISPLAY: ":7", SECRET: "denied", OAUTH_TOKEN: "denied", HOME: "/ambient", TMPDIR: "/ambient-tmp", PATH: "/a" },
    { home: "/private/home", tmp: "/private/tmp" });
  expect(env).toEqual({ DISPLAY: ":7", PATH: "/a", HOME: "/private/home", TMPDIR: "/private/tmp" });
});
