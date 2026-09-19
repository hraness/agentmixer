import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openAccountDatabase, type SqliteDatabase } from "../sqlite-port.ts";
import { privateDirectory } from "./state.ts";
import { assertPrivateStat, canonicalizePrivatePath, matchesPrivateStat, sameFileIdentity, writeFileOnce, PRIVATE_CONTROL_REJECT } from "../private-file.ts";

const WAIT_MS = 5_000;
const queues = new Map<string, { tail: Promise<void>; count: number }>();
const inside = (path: string, root: string) => {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
};
const busy = (error: unknown) => error instanceof Error && /database (?:is )?locked|SQLITE_BUSY|SQLITE_LOCKED/u.test(error.message);

export function workspaceCoordinationRoot(): string {
  return process.env.XCB_COORDINATION_ROOT ?? join(homedir(), ".local", "share", "xcb-coordination");
}

export async function withWorkspaceWriteLock<T>(workspace: string, directory: string, action: () => Promise<T>): Promise<T> {
  canonicalizePrivatePath(directory, { code: "WORKSPACE_COORDINATION_LAYOUT_INVALID", reject: PRIVATE_CONTROL_REJECT, maxLength: Infinity });
  if (inside(directory, workspace) || inside(workspace, directory)) throw new Error("WORKSPACE_COORDINATION_LAYOUT_INVALID");
  if (await realpath(workspace) !== workspace || !(await lstat(workspace)).isDirectory()) throw new Error("WORKSPACE_ROOT_CHANGED");
  const path = join(directory, `${createHash("sha256").update(workspace).digest("hex")}.sqlite`);
  const prior = queues.get(path);
  if ((prior?.count ?? 0) >= 128) throw new Error("WORKSPACE_WRITER_QUEUE_FULL");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const previous = prior?.tail ?? Promise.resolve();
  const ticket = { tail: previous.then(() => gate), count: (prior?.count ?? 0) + 1 };
  queues.set(path, ticket);
  void ticket.tail.then(() => { if (queues.get(path) === ticket) queues.delete(path); });
  const deadline = performance.now() + WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let database: SqliteDatabase | undefined;
  try {
    await Promise.race([previous, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("WORKSPACE_WRITER_BUSY")), WAIT_MS); })]);
    clearTimeout(timer);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await privateDirectory(directory);
    try {
      await writeFileOnce(path, "", { syncFile: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const before = await lstat(path, { bigint: true });
    assertPrivateStat(before, { kind: "file", noSymlink: true, links: "single", owner: "self",
      mode: [{ mask: 0o077, equals: 0 }], size: { max: 64n * 1024n } }, "WORKSPACE_COORDINATION_NOT_PRIVATE");
    for (;;) {
      if (performance.now() >= deadline) throw new Error("WORKSPACE_WRITER_BUSY");
      try {
        database = await openAccountDatabase(path, "DELETE");
        database.exec("PRAGMA busy_timeout=0");
        database.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        database?.close(); database = undefined;
        if (!busy(error)) throw error;
        await delay(5);
      }
    }
    const after = await lstat(path, { bigint: true });
    if (!matchesPrivateStat(after, { kind: "file", links: "single", mode: [{ mask: 0o077, equals: 0 }] })
      || !sameFileIdentity(after, before, ["dev", "ino", "uid"])) throw new Error("WORKSPACE_COORDINATION_CHANGED");
    if (await realpath(workspace) !== workspace) throw new Error("WORKSPACE_ROOT_CHANGED");
    return await action();
  } finally {
    clearTimeout(timer);
    try { database?.exec("ROLLBACK"); }
    finally {
      try { database?.close(); }
      finally {
        release();
        const current = queues.get(path);
        if (current !== undefined) current.count--;
      }
    }
  }
}
