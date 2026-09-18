import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");

async function stateDir(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "xcb-cli-test-")));
}

/** Run the CLI source under Bun in an isolated state root with provider
 * discovery pinned to paths that cannot exist. */
async function cli(args: readonly string[], input?: string, state?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const root = state ?? await stateDir();
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: ROOT,
    env: {
      ...process.env, XCB_STATE: root, NO_COLOR: "1",
      XCB_CLAUDE: join(root, "no-such-claude"), XCB_CODEX: join(root, "no-such-codex"),
      PATH: join(root, "empty-path"), HOME: root,
    },
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe", stderr: "pipe",
  });
  if (input !== undefined) { child.stdin!.write(input); child.stdin!.end(); }
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe("xcb CLI", () => {
  test("--version prints the package version", async () => {
    const { code, stdout } = await cli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  test("--help prints the command surface", async () => {
    const { code, stdout } = await cli(["--help"]);
    expect(code).toBe(0);
    for (const command of ["auth claude", "auth status", "auth logout", "doctor", "sessions", "resume", "run [-p", "--cwd"]) expect(stdout).toContain(command);
  });

  test("doctor reports missing providers and exits nonzero", async () => {
    const { code, stdout } = await cli(["doctor"]);
    expect(code).toBe(1);
    expect(stdout).toContain("claude: not found");
    expect(stdout).toContain("codex: not found");
  });

  test("auth claude refuses when the pinned binary is absent", async () => {
    const { code, stderr } = await cli(["auth", "claude"]);
    expect(code).toBe(2);
    expect(stderr).toContain("claude binary not found");
  });

  test("auth codex refuses when the pinned binary is absent", async () => {
    const { code, stderr } = await cli(["auth", "codex"]);
    expect(code).toBe(2);
    expect(stderr).toContain("codex binary not found");
  });

  test("run refuses before provider admission", async () => {
    const { code, stderr } = await cli(["run", "-p", "hello"]);
    expect(code).toBe(2);
    expect(stderr).toContain("provider not admitted");
  });

  test("run rejects an unknown provider", async () => {
    const { code, stderr } = await cli(["run", "--provider", "gemini", "-p", "hi"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown provider");
  });

  test("chat refuses before provider admission instead of hanging", async () => {
    const { code, stderr } = await cli([], "hello\n");
    expect(code).toBe(2);
    expect(stderr).toContain("claude binary not found");
  });

  test("chat reports a missing workspace path", async () => {
    const { code, stderr } = await cli(["/definitely/not/a/real/path-xyz"]);
    expect(code).toBe(2);
    expect(stderr).toContain("does not exist");
  });

  test("resume refuses an unknown session id", async () => {
    const { code, stderr } = await cli(["resume", "s_nonexistent"]);
    expect(code).toBe(2);
    expect(stderr).toContain("session not found");
  });

  test("resume without an id reports no sessions on a fresh state root", async () => {
    const { code, stderr } = await cli(["resume"]);
    expect(code).toBe(2);
    expect(stderr).toContain("no sessions yet");
  });

  test("auth status reports signed out on a fresh state root", async () => {
    const { code, stdout } = await cli(["auth", "status"]);
    expect(code).toBe(1);
    expect(stdout).toContain("signed out");
  });

  test("auth logout clears the stored token and status flips", async () => {
    const state = await stateDir();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(state, "claude-oauth-token"), `sk-ant-oat01-${"x".repeat(64)}\n`, { mode: 0o600 });
    const before = await cli(["auth", "status"], undefined, state);
    expect(before.code).toBe(0);
    expect(before.stdout).toContain("signed in");
    const out = await cli(["auth", "logout"], undefined, state);
    expect(out.code).toBe(0);
    const after = await cli(["auth", "status"], undefined, state);
    expect(after.code).toBe(1);
    expect(after.stdout).toContain("signed out");
  });

  test("run --cwd rejects a missing workspace path", async () => {
    const { code, stderr } = await cli(["run", "-p", "hi", "--cwd", "/definitely/not/real-xyz"]);
    expect(code).toBe(2);
    expect(stderr).toContain("does not exist");
  });

  test("auth with extra arguments is a usage error", async () => {
    const { code, stderr } = await cli(["auth", "claude", "extra"]);
    expect(code).toBe(2);
    expect(stderr).toContain("usage:");
  });

  test("sessions prints nothing on a fresh state root", async () => {
    const { code, stdout } = await cli(["sessions"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("sessions rm requires an id and reports a missing session", async () => {
    expect((await cli(["sessions", "rm"])).stderr).toContain("usage:");
    const missing = await cli(["sessions", "rm", "s_nonexistent"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("session not found");
  });

  test("sessions prune validates days and prunes nothing fresh", async () => {
    const empty = await cli(["sessions", "prune"]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("pruned 0 sessions");
    const bad = await cli(["sessions", "prune", "bogus"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("invalid days");
  });

  test("unknown option fails with usage error", async () => {
    const { code, stderr } = await cli(["chat", "--bogus"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown option --bogus");
  });
});
