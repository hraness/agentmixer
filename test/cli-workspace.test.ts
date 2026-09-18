import { describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCliWorkspace, createCliWorkspaceProfile } from "../src/cli/workspace.ts";
import { createCapabilityBroker } from "../src/capabilities.ts";
import { assertWorkspaceStateSeparation } from "../src/cli/state.ts";

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "xcb-t-")));
  const root = join(base, "work"), coordinationRoot = join(base, "coordination");
  await mkdir(root);
  return { root, coordinationRoot, workspace: createCliWorkspace(root, { coordinationRoot }) };
}

describe("cli workspace", () => {
  test("private state cannot become part of a consumer workspace", () => {
    for (const [workspace, state] of [["/", "/private/state"], ["/work", "/work/state"], ["/private/state/work", "/private/state"], ["/work", "/work"]]) {
      expect(() => assertWorkspaceStateSeparation(workspace!, state!)).toThrow("overlaps private xcb state");
    }
    expect(() => assertWorkspaceStateSeparation("/work/project", "/work/project-state")).not.toThrow();
  });

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
    const outside = await realpath(await mkdtemp(join(tmpdir(), "xcb-t-")));
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

  test("twenty writers cannot create or replace one revision more than once", async () => {
    const { root, workspace } = await fixture();
    for (const existing of [false, true]) {
      const path = join(root, existing ? "existing" : "new");
      if (existing) { await writeFile(path, "original"); await chmod(path, 0o755); }
      const expected = existing ? (await workspace.readRevision(path)).revision : null;
      const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => workspace.writeRevision(path, `writer-${index}`, expected)));
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect((await stat(path)).mode & 0o777).toBe(existing ? 0o755 : 0o600);
    }
  });

  test("coordination refuses workspace overlap and unsafe lock files", async () => {
    const { root } = await fixture();
    const workspace = createCliWorkspace(root, { coordinationRoot: join(root, "locks") });
    await expect(workspace.writeRevision(join(root, "new"), "no effect", null)).rejects.toThrow("WORKSPACE_COORDINATION_LAYOUT_INVALID");
    expect(await stat(join(root, "new")).catch(() => null)).toBeNull();
    for (const kind of ["public", "symlink", "hardlink"]) {
      const fixtureState = await fixture();
      await mkdir(fixtureState.coordinationRoot, { mode: 0o700 });
      const key = createHash("sha256").update(fixtureState.root).digest("hex");
      const path = join(fixtureState.coordinationRoot, `${key}.sqlite`);
      if (kind === "public") { await writeFile(path, ""); await chmod(path, 0o644); }
      else {
        const target = join(fixtureState.coordinationRoot, "target");
        await writeFile(target, "", { mode: 0o600 });
        if (kind === "symlink") await symlink(target, path);
        else await link(target, path);
      }
      await expect(fixtureState.workspace.writeRevision(join(fixtureState.root, "new"), "no effect", null))
        .rejects.toThrow("WORKSPACE_COORDINATION_NOT_PRIVATE");
      expect(await stat(join(fixtureState.root, "new")).catch(() => null)).toBeNull();
    }
  });

  test("web.fetch is absent without a host web port", async () => {
    const { workspace } = await fixture();
    const profile = createCliWorkspaceProfile(workspace);
    expect(profile.tools.map((tool) => tool.name)).not.toContain("web.fetch");
    const withWeb = createCliWorkspaceProfile(workspace, { fetch: async () => ({ text: "ok" }) });
    expect(withWeb.tools.map((tool) => tool.name)).toContain("web.fetch");
  });
});
