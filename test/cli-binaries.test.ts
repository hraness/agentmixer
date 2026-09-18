import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { cliBinaryCandidates, inspectCliExecutable, repairCliExecutableMode, CLI_CLAUDE_ENV } from "../src/cli/binaries.ts";

async function dir() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xcb-t-")));
  return root;
}

describe("cli binary discovery", () => {
  test("env pin wins, then PATH, then known locations", () => {
    const env = (name: string) => name === CLI_CLAUDE_ENV ? "/pinned/claude" : name === "PATH" ? "/bin" : undefined;
    const candidates = cliBinaryCandidates("claude", env);
    expect(candidates[0]).toBe("/pinned/claude");
    expect(candidates).toContain(join("/bin", "claude"));
    expect(candidates.some((c) => c.includes(".local"))).toBe(true);
  });

  test("pre-0.4.0 pin names apply only when the XCB_* variable is unset", () => {
    const env = (name: string) => name === "AGENTMIXER_CLAUDE" ? "/legacy/claude" : undefined;
    expect(cliBinaryCandidates("claude", env)[0]).toBe("/legacy/claude");
    const both = (name: string) => name === CLI_CLAUDE_ENV ? "/new/claude" : name === "AGENTMIXER_CLAUDE" ? "/legacy/claude" : undefined;
    expect(cliBinaryCandidates("claude", both)[0]).toBe("/new/claude");
  });

  test("inspection rejects missing, non-executable and non-regular targets", async () => {
    const root = await dir();
    await writeFile(join(root, "plain"), "not executable", { mode: 0o644 });
    await expect(inspectCliExecutable(join(root, "plain"))).rejects.toThrow("XCB_EXECUTABLE_INVALID");
    await expect(inspectCliExecutable(join(root, "missing"))).rejects.toThrow();
    await expect(inspectCliExecutable("relative/path")).rejects.toThrow("XCB_EXECUTABLE_INVALID");
  });

  test("inspection rejects world-writable executables until repaired", async () => {
    const root = await dir();
    const target = join(root, "claude");
    await writeFile(target, "fake-binary", { mode: 0o600 });
    await chmod(target, 0o777);
    await expect(inspectCliExecutable(target)).rejects.toThrow("XCB_EXECUTABLE_INVALID");
    expect(await repairCliExecutableMode(target)).toBe(true);
    const inspected = await inspectCliExecutable(target);
    expect(inspected.executablePath).toBe(target);
    expect(inspected.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("repair fixes a user-owned resolved target and refuses clean files", async () => {
    const root = await dir();
    const real = join(root, "real");
    const link = join(root, "link");
    await writeFile(real, "x", { mode: 0o600 });
    await chmod(real, 0o777);
    await symlink(real, link);
    expect(await repairCliExecutableMode(link)).toBe(true);
    expect(await lstatMode(real)).toBe("755");
    expect(await repairCliExecutableMode(real)).toBe(false); // already tight
  });

  test("inspection hashes resolved symlink targets", async () => {
    const root = await dir();
    const real = join(root, "real-claude");
    const link = join(root, "claude-link");
    await writeFile(real, "binary-bytes", { mode: 0o755 });
    await symlink(real, link);
    const inspected = await inspectCliExecutable(link);
    expect(inspected.executablePath).toBe(real);
  });
});

async function lstatMode(path: string): Promise<string> {
  const { lstat } = await import("node:fs/promises");
  return (await lstat(path)).mode.toString(8).slice(-3);
}
