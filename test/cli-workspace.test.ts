import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCliWorkspace, createCliWorkspaceProfile } from "../src/cli/workspace.ts";
import { createCapabilityBroker } from "../src/capabilities.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentmixer-t-")));
  return { root, workspace: createCliWorkspace(root) };
}

describe("cli workspace", () => {
  test("rejects non-absolute or non-canonical roots", async () => {
    expect(() => createCliWorkspace("relative/path")).toThrow("WORKSPACE_ROOT_INVALID");
    expect(() => createCliWorkspace("/tmp/../tmp")).toThrow("WORKSPACE_ROOT_INVALID");
  });

  test("reads files with a revision and writes conditionally", async () => {
    const { root, workspace } = await fixture();
    await writeFile(join(root, "a.txt"), "hello", { mode: 0o600 });
    const read = await workspace.readRevision(join(root, "a.txt"));
    expect(read.text).toBe("hello");
    expect(read.revision).toMatch(/^[a-f0-9]{32}$/u);

    await expect(workspace.writeRevision(join(root, "b.txt"), "new", "stale")).rejects.toThrow("WORKSPACE_FILE_MISSING");
    const created = await workspace.writeRevision(join(root, "b.txt"), "new", null);
    expect(created.revision).toMatch(/^[a-f0-9]{32}$/u);

    await expect(workspace.writeRevision(join(root, "b.txt"), "bad", read.revision)).rejects.toThrow("WORKSPACE_REVISION_MISMATCH");
    const updated = await workspace.writeRevision(join(root, "b.txt"), "next", created.revision);
    expect(updated.revision).not.toBe(created.revision);
  });

  test("rejects escaping, absolute and symlinked paths", async () => {
    const { root, workspace } = await fixture();
    await writeFile(join(root, "inside.txt"), "x", { mode: 0o600 });
    const outside = await realpath(await mkdtemp(join(tmpdir(), "agentmixer-t-")));
    await writeFile(join(outside, "secret.txt"), "secret", { mode: 0o600 });
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));

    await expect(workspace.readRevision(join(root, "link.txt"))).rejects.toThrow("WORKSPACE_PATH_LINK");
    await expect(workspace.readRevision(join(outside, "secret.txt"))).rejects.toThrow("WORKSPACE_PATH_ESCAPES");
    await expect(workspace.writeRevision(join(root, "..", "escape.txt"), "x", null)).rejects.toThrow();
  });

  test("lists entries without leaking symlinked names beyond the root", async () => {
    const { root, workspace } = await fixture();
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "f.txt"), "x", { mode: 0o600 });
    await symlink("/nonexistent-target", join(root, "dangling"));
    const entries = await workspace.listEntries(root);
    expect(entries).toEqual(["dir/", "f.txt"]);
  });

  test("profile tools enforce confinement through the broker", async () => {
    const { root, workspace } = await fixture();
    const profile = createCliWorkspaceProfile(workspace);
    const broker = createCapabilityBroker({ profile, workspaceId: "ws", runId: "run", isActive: () => true });
    const outside = join(root, "..", `outside-${process.pid}.txt`);
    await expect(broker.invoke("workspace.read", { path: outside })).rejects.toThrow();
    await expect(broker.invoke("workspace.read", { path: "/etc/passwd" })).rejects.toThrow();
    await writeFile(join(root, "ok.txt"), "content", { mode: 0o600 });
    const read = await broker.invoke("workspace.read", { path: "ok.txt" }) as { text: string; revision: string };
    expect(read.text).toBe("content");
    const wrote = await broker.invoke("workspace.write", { path: "ok.txt", text: "changed", expectedRevision: read.revision }) as { revision: string };
    expect(wrote.revision).not.toBe(read.revision);
    await expect(broker.invoke("workspace.write", { path: "ok.txt", text: "x", expectedRevision: read.revision })).rejects.toThrow();
    await broker.close();
  });

  test("web.fetch is absent without a host web port", async () => {
    const { workspace } = await fixture();
    const profile = createCliWorkspaceProfile(workspace);
    expect(profile.tools.map((tool) => tool.name)).not.toContain("web.fetch");
    const withWeb = createCliWorkspaceProfile(workspace, { fetch: async () => ({ text: "ok" }) });
    expect(withWeb.tools.map((tool) => tool.name)).toContain("web.fetch");
  });
});
