import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBwrapOsSandbox, createSandboxedProviderProcessFactory, createSeatbeltOsSandbox, planBwrapPolicy, planSeatbeltPolicy, verifyOsSandboxExecutable, type OsSandboxSpec } from "../src/os-sandbox.ts";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentmixer-os-sandbox-test-")));
  const scratch = join(root, "scratch"), accountHome = join(root, "account"), policyPath = join(root, "policy.sb");
  const executable = join(root, "runtime", "provider");
  return { root, scratch, accountHome, policyPath, executable,
    spec(overrides: Record<string, unknown> = {}): OsSandboxSpec {
      return { executable, scratch, accountHome, network: "denied", policyPath, ...overrides } as OsSandboxSpec;
    },
    async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

describe("os-sandbox spec validation", () => {
  test("rejects non-object and undeclared-key specs", async () => {
    const f = await fixture();
    try {
      expect(() => planSeatbeltPolicy(null as never, "(deny default)")).toThrow("OS_SANDBOX_OBJECT_INVALID");
      expect(() => planSeatbeltPolicy(f.spec({ extra: 1 }), "(deny default)")).toThrow("OS_SANDBOX_UNKNOWN_FIELD");
    } finally { await f.cleanup(); }
  });
  test("rejects relative and overlong paths", async () => {
    const f = await fixture();
    try {
      expect(() => planSeatbeltPolicy(f.spec({ executable: "relative/exe" }), "(deny default)")).toThrow("OS_SANDBOX_PATH_INVALID");
      expect(() => planSeatbeltPolicy(f.spec({ executable: `/tmp/${"x".repeat(5000)}` }), "(deny default)")).toThrow("OS_SANDBOX_PATH_INVALID");
    } finally { await f.cleanup(); }
  });
  test("rejects an executable inside a writable root", async () => {
    const f = await fixture();
    try {
      expect(() => planSeatbeltPolicy(f.spec({ executable: join(f.scratch, "exe") }), "(deny default)")).toThrow("OS_SANDBOX_LAYOUT_INVALID");
      expect(() => planSeatbeltPolicy(f.spec({ executable: join(f.accountHome, "exe") }), "(deny default)")).toThrow("OS_SANDBOX_LAYOUT_INVALID");
      expect(() => planSeatbeltPolicy(f.spec({ executable: f.scratch }), "(deny default)")).toThrow("OS_SANDBOX_LAYOUT_INVALID");
    } finally { await f.cleanup(); }
  });
  test("rejects overlapping writable roots", async () => {
    const f = await fixture();
    try {
      expect(() => planSeatbeltPolicy(f.spec({ accountHome: join(f.scratch, "acct") }), "(deny default)")).toThrow("OS_SANDBOX_LAYOUT_INVALID");
      expect(() => planSeatbeltPolicy(f.spec({ scratch: join(f.accountHome, "scr") }), "(deny default)")).toThrow("OS_SANDBOX_LAYOUT_INVALID");
    } finally { await f.cleanup(); }
  });
  test("rejects a policy artifact inside a writable root", async () => {
    const f = await fixture();
    try {
      expect(() => planSeatbeltPolicy(f.spec({ policyPath: join(f.scratch, "sandbox.sb") }), "(deny default)")).toThrow("OS_SANDBOX_LAYOUT_INVALID");
    } finally { await f.cleanup(); }
  });
  test("rejects an unknown network policy", async () => {
    const f = await fixture();
    try {
      expect(() => planSeatbeltPolicy(f.spec({ network: "egress-any" }), "(deny default)")).toThrow("OS_SANDBOX_NETWORK_INVALID");
    } finally { await f.cleanup(); }
  });
});

describe("os-sandbox seatbelt planning", () => {
  test("wraps argv byte-identically to the launchers it replaces", async () => {
    const f = await fixture();
    try {
      const policy = "(version 1)(deny default)(allow file-write* (subpath \"/scratch\"))";
      const plan = planSeatbeltPolicy(f.spec({ network: "provider-tcp443-dns" }), policy);
      expect(plan.backend).toBe("seatbelt");
      expect(plan.executable).toBe("/usr/bin/sandbox-exec");
      expect(plan.policy).toBe(policy);
      expect(plan.policySha256).toBe(sha256(policy));
      const wrapped = plan.wrap({ args: ["app-server", "--listen", "stdio://"], env: Object.freeze({ HOME: "/h", CODEX_HOME: "/c" }), cwd: "/work" });
      expect([...wrapped.args]).toEqual(["-f", f.policyPath, f.executable, "app-server", "--listen", "stdio://"]);
      expect(wrapped.env).toEqual({ HOME: "/h", CODEX_HOME: "/c" });
    } finally { await f.cleanup(); }
  });
  test("policy digest is stable and input-independent", async () => {
    const f = await fixture();
    try {
      const policy = "(version 1)(deny default)";
      const a = planSeatbeltPolicy(f.spec(), policy), b = planSeatbeltPolicy(f.spec(), policy);
      expect(a.policySha256).toBe(b.policySha256);
      expect(planSeatbeltPolicy(f.spec(), `${policy} `).policySha256).not.toBe(a.policySha256);
    } finally { await f.cleanup(); }
  });
  test("wrap rejects undeclared keys, relative cwd, and NUL env values", async () => {
    const f = await fixture();
    try {
      const plan = planSeatbeltPolicy(f.spec(), "(deny default)");
      expect(() => plan.wrap({ args: [], env: {}, cwd: "/x", extra: 1 } as never)).toThrow("OS_SANDBOX_UNKNOWN_FIELD");
      expect(() => plan.wrap({ args: [], env: {}, cwd: "relative" })).toThrow("OS_SANDBOX_PATH_INVALID");
      expect(() => plan.wrap({ args: [], env: { "BAD NAME": "x" }, cwd: "/x" })).toThrow("OS_SANDBOX_WRAP_INVALID");
      expect(() => plan.wrap({ args: [], env: { K: "a\0b" }, cwd: "/x" })).toThrow("OS_SANDBOX_WRAP_INVALID");
      expect(() => plan.wrap({ args: ["a\0b"], env: {}, cwd: "/x" })).toThrow("OS_SANDBOX_WRAP_INVALID");
    } finally { await f.cleanup(); }
  });
  test("backend gates on platform and rejects an invalid generator", async () => {
    expect(() => createSeatbeltOsSandbox({} as never)).toThrow("OS_SANDBOX_GENERATOR_INVALID");
    expect(() => createSeatbeltOsSandbox({ generateProfile: () => "(deny default)", extra: 1 } as never)).toThrow("OS_SANDBOX_UNKNOWN_FIELD");
    const backend = createSeatbeltOsSandbox({ generateProfile: () => "(deny default)" });
    expect(backend.name).toBe("seatbelt");
    const f = await fixture();
    try {
      const result = backend.plan(f.spec());
      if (process.platform === "darwin") {
        const plan = await result;
        expect(plan.executable).toBe("/usr/bin/sandbox-exec");
      } else {
        await expect(result).rejects.toThrow("OS_SANDBOX_PLATFORM_UNSUPPORTED");
      }
    } finally { await f.cleanup(); }
  });
  test("backend rejects an oversized or empty generated policy", async () => {
    if (process.platform !== "darwin") return;
    const f = await fixture();
    try {
      await expect(createSeatbeltOsSandbox({ generateProfile: () => "" }).plan(f.spec())).rejects.toThrow("OS_SANDBOX_POLICY_INVALID");
      await expect(createSeatbeltOsSandbox({ generateProfile: () => "x".repeat(70 * 1024) }).plan(f.spec())).rejects.toThrow("OS_SANDBOX_POLICY_INVALID");
    } finally { await f.cleanup(); }
  });
});

describe("os-sandbox bwrap planning", () => {
  test("builds private-namespace argv with clearenv and sorted setenv", async () => {
    const f = await fixture();
    try {
      const plan = planBwrapPolicy(f.spec({ readOnlyPaths: [join(f.root, "lib.so")] }), join(f.root, "bwrap"));
      expect(plan.backend).toBe("bwrap");
      expect(plan.executable).toBe(join(f.root, "bwrap"));
      const wrapped = plan.wrap({ args: ["run"], env: Object.freeze({ Z_VAR: "z", A_VAR: "a" }), cwd: "/inside" });
      const args = [...wrapped.args];
      expect(args.slice(0, 3)).toEqual(["--unshare-all", "--new-session", "--die-with-parent"]);
      expect(args).toContain("--clearenv");
      expect(args).toContain("--ro-bind");
      expect(args).toContain("--bind");
      const sep = args.indexOf("--");
      expect(args[sep + 1]).toBe(f.executable);
      expect(args.slice(sep + 2)).toEqual(["run"]);
      const setenvOrder = args.flatMap((value, index) => value === "--setenv" ? [args[index + 1]] : []);
      expect(setenvOrder).toEqual(["A_VAR", "Z_VAR"]);
      expect(args[args.indexOf("--chdir") + 1]).toBe("/inside");
      // The wrapper environment is minimal; the closed env rides --setenv only.
      expect(wrapped.env).toEqual({ PATH: "/usr/bin:/bin" });
    } finally { await f.cleanup(); }
  });
  test("binds executable and read-only paths ro, scratch and account rw", async () => {
    const f = await fixture();
    try {
      const plan = planBwrapPolicy(f.spec(), join(f.root, "bwrap"));
      const args = [...plan.wrap({ args: [], env: {}, cwd: "/" }).args];
      const pairs = (flag: string) => args.flatMap((value, index) => value === flag ? [args[index + 1]] : []);
      expect(pairs("--ro-bind")).toContain(f.executable);
      expect(pairs("--bind")).toContain(f.scratch);
      expect(pairs("--bind")).toContain(f.accountHome);
      const policy = JSON.parse(plan.policy);
      expect(policy.schema).toBe("agentmixer.os-sandbox-bwrap.v1");
      expect(policy.binds.find((b: { target: string }) => b.target === f.scratch).mode).toBe("rw");
      expect(policy.binds.find((b: { target: string }) => b.target === f.executable).mode).toBe("ro");
      expect(plan.policySha256).toBe(sha256(plan.policy));
    } finally { await f.cleanup(); }
  });
  test("rejects every network policy but denied", async () => {
    const f = await fixture();
    try {
      expect(() => planBwrapPolicy(f.spec({ network: "loopback" }), join(f.root, "bwrap"))).toThrow("OS_SANDBOX_NETWORK_UNSUPPORTED");
      expect(() => planBwrapPolicy(f.spec({ network: "provider-tcp443-dns" }), join(f.root, "bwrap"))).toThrow("OS_SANDBOX_NETWORK_UNSUPPORTED");
    } finally { await f.cleanup(); }
  });
  test("policy digest tracks bind-set changes", async () => {
    const f = await fixture();
    try {
      const a = planBwrapPolicy(f.spec(), join(f.root, "bwrap"));
      const b = planBwrapPolicy(f.spec({ readOnlyPaths: [join(f.root, "extra")] }), join(f.root, "bwrap"));
      expect(a.policySha256).not.toBe(b.policySha256);
      expect(planBwrapPolicy(f.spec(), join(f.root, "bwrap")).policySha256).toBe(a.policySha256);
    } finally { await f.cleanup(); }
  });
  test("backend gates on platform and re-verifies the wrapper artifact", async () => {
    const f = await fixture();
    try {
      const wrapper = join(f.root, "bwrap");
      await writeFile(wrapper, "synthetic-bwrap");
      await chmod(wrapper, 0o500);
      const backend = createBwrapOsSandbox({ executable: wrapper, sha256: sha256("synthetic-bwrap") });
      expect(backend.name).toBe("bwrap");
      const result = backend.plan(f.spec());
      if (process.platform === "linux") {
        await expect(result).resolves.toMatchObject({ backend: "bwrap" });
        const wrongDigest = createBwrapOsSandbox({ executable: wrapper, sha256: sha256("other") });
        await expect(wrongDigest.plan(f.spec())).rejects.toThrow("OS_SANDBOX_EXECUTABLE_CHANGED");
      } else {
        await expect(result).rejects.toThrow("OS_SANDBOX_PLATFORM_UNSUPPORTED");
      }
    } finally { await f.cleanup(); }
  });
});

describe("verifyOsSandboxExecutable", () => {
  test("accepts an exact digest and rejects drift, symlinks and absence", async () => {
    const f = await fixture();
    try {
      const exe = join(f.root, "exe");
      await writeFile(exe, "admitted-bytes"); await chmod(exe, 0o500);
      await verifyOsSandboxExecutable(exe, sha256("admitted-bytes"), 1024n);
      await expect(verifyOsSandboxExecutable(exe, sha256("tampered"), 1024n)).rejects.toThrow("OS_SANDBOX_EXECUTABLE_CHANGED");
      await expect(verifyOsSandboxExecutable(exe, sha256("admitted-bytes"), 4n)).rejects.toThrow("OS_SANDBOX_EXECUTABLE_INVALID");
      const link = join(f.root, "link"); await symlink(exe, link);
      await expect(verifyOsSandboxExecutable(link, sha256("admitted-bytes"), 1024n)).rejects.toThrow();
      await expect(verifyOsSandboxExecutable(join(f.root, "missing"), sha256("x"), 1024n)).rejects.toThrow("OS_SANDBOX_EXECUTABLE_INVALID");
      await chmod(exe, 0o600); await writeFile(exe, "admitted-bytes-plus"); await chmod(exe, 0o500);
      await expect(verifyOsSandboxExecutable(exe, sha256("admitted-bytes"), 1024n)).rejects.toThrow("OS_SANDBOX_EXECUTABLE_CHANGED");
    } finally { await f.cleanup(); }
  });
});

describe("createSandboxedProviderProcessFactory", () => {
  test("rewrites argv through the plan and preserves bounded custody", async () => {
    const f = await fixture();
    try {
      // A synthetic plan whose wrapper is the real executable: `sh -c` records
      // the rewritten argv/env, proving composition end to end.
      const seen = join(f.scratch, "seen");
      await mkdir(f.scratch, { mode: 0o700 });
      const sh = "/bin/sh";
      const plan = { backend: "seatbelt" as const, policy: "p", policySha256: sha256("p"), executable: sh,
        wrap: (input: { args: readonly string[]; env: Readonly<Record<string, string>>; cwd: string }) =>
          ({ args: ["-c", `printf '%s' "$MARK" > ${seen}`, ...input.args], env: input.env }) };
      const factory = createSandboxedProviderProcessFactory(plan as never);
      const handle = factory({ executable: sh, args: [], env: { MARK: "wrapped" }, cwd: f.scratch,
        onViolation: () => {}, binding: { runId: "run", accountId: "acct", workspaceId: "ws" } });
      expect(handle.isStopped()).toBe(false);
      await new Promise<void>(resolve => handle.process.once("exit", () => resolve()));
      await handle.stopAndJoin();
      expect(handle.isStopped()).toBe(true);
      expect(await Bun.file(seen).text()).toBe("wrapped");
    } finally { await f.cleanup(); }
  });
});
