import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { boundedText } from "../validation.ts";
import { assertPrivateDirectory, canonicalizePrivatePath, PRIVATE_CONTROL_REJECT } from "../private-file.ts";

export const CLI_STATE_ENV = "XCB_STATE";
const STATE_DIRNAME = ".xcb";
/** Pre-0.4.0 locations, read only by `xcb migrate`; never a live default. */
export const LEGACY_STATE_ENV = "AGENTMIXER_STATE";
const LEGACY_STATE_DIRNAME = ".agentmixer";
const MAX_MIGRATION_ENTRIES = 16_384;
const MAX_MIGRATION_BYTES = 4 * 1024 * 1024 * 1024;

/** Resolve the CLI state root without creating it. XCB_STATE wins when it
 * names an absolute path; otherwise the root is ~/.xcb. */
export function cliStateRootPath(env: (name: string) => string | undefined = (name) => process.env[name]): string {
  const override = env(CLI_STATE_ENV);
  if (override !== undefined) {
    return canonicalizePrivatePath(override, { code: "XCB_STATE_INVALID", reject: PRIVATE_CONTROL_REJECT, maxLength: Infinity });
  }
  const home = homedir();
  if (typeof home !== "string" || !isAbsolute(home)) throw new Error("XCB_HOME_UNAVAILABLE");
  return join(home, STATE_DIRNAME);
}

/** Open an existing physical directory owned by this user with mode 0700. */
export async function privateDirectory(path: string): Promise<string> {
  canonicalizePrivatePath(path, { code: "XCB_DIRECTORY_INVALID", reject: PRIVATE_CONTROL_REJECT, maxLength: Infinity });
  return (await assertPrivateDirectory(path, { code: "XCB_DIRECTORY_NOT_PRIVATE", owner: "self",
    mode: "ownerOnly", canonical: "self", statOrder: "realpathFirst", stats: "number" })).physical;
}

/** Create the state root and the named child, both physical and mode 0700. */
export async function ensureCliState(child?: string): Promise<{ root: string; path: string }> {
  const root = await mkdir(cliStateRootPath(), { mode: 0o700, recursive: true }).then(async () => await privateDirectory(cliStateRootPath()));
  if (child === undefined) return { root, path: root };
  const name = boundedText(child, 64);
  if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new Error("XCB_STATE_CHILD_INVALID");
  const path = join(root, name);
  await mkdir(path, { mode: 0o700, recursive: true });
  return { root, path: await privateDirectory(path) };
}

export function assertWorkspaceStateSeparation(workspace: string, stateRoot: string): void {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  if (contains(workspace, stateRoot) || contains(stateRoot, workspace)) {
    throw new Error("workspace overlaps private xcb state; choose a separate workspace or state root");
  }
}

export { constants as fsConstants };

/** Locate pre-0.4.0 state without making it canonical: AGENTMIXER_STATE when
 * set (same validation as XCB_STATE), else ~/.agentmixer. Returns null when no
 * legacy root exists on disk. */
export async function legacyStateRootPath(env: (name: string) => string | undefined = (name) => process.env[name]): Promise<string | null> {
  const override = env(LEGACY_STATE_ENV);
  let candidate = join(homedir(), LEGACY_STATE_DIRNAME);
  if (override !== undefined) {
    candidate = canonicalizePrivatePath(override, { code: "AGENTMIXER_STATE_INVALID", reject: PRIVATE_CONTROL_REJECT, maxLength: Infinity });
  }
  const stat = await lstat(candidate).catch(() => null);
  if (stat === null) return null;
  return await privateDirectory(candidate);
}

/** Explicit one-way copy of a legacy AgentMixer state root into the canonical
 * root. The target must be an existing empty directory; the source is left
 * untouched. SQLite table namespaces migrate lazily at next open. */
export async function migrateLegacyState(targetRoot: string, env: (name: string) => string | undefined = (name) => process.env[name]): Promise<{ source: string; entries: number }> {
  const source = await legacyStateRootPath(env);
  if (source === null) throw new Error("XCB_LEGACY_STATE_ABSENT");
  const target = await privateDirectory(targetRoot);
  if (source === target) throw new Error("XCB_LEGACY_STATE_SAME_AS_TARGET");
  if ((await readdir(target)).length !== 0) throw new Error("XCB_STATE_TARGET_NOT_EMPTY");
  let entries = 0, bytes = 0;
  const copyInto = async (from: string, to: string): Promise<void> => {
    for (const name of await readdir(from)) {
      if (name === "." || name === ".." || name.includes("/") || /[\x00-\x1f\x7f]/u.test(name)) throw new Error("XCB_LEGACY_ENTRY_INVALID");
      const sourcePath = join(from, name);
      const stat = await lstat(sourcePath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("XCB_LEGACY_ENTRY_UNSUPPORTED");
      entries += 1;
      if (entries > MAX_MIGRATION_ENTRIES) throw new Error("XCB_LEGACY_STATE_TOO_LARGE");
      const targetPath = join(to, name);
      if (stat.isDirectory()) {
        if ((stat.mode & 0o077) !== 0) throw new Error("XCB_LEGACY_ENTRY_NOT_PRIVATE");
        await mkdir(targetPath, { mode: 0o700 });
        await copyInto(sourcePath, targetPath);
      } else {
        bytes += stat.size;
        if (bytes > MAX_MIGRATION_BYTES) throw new Error("XCB_LEGACY_STATE_TOO_LARGE");
        await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
        await chmod(targetPath, stat.mode & 0o777);
      }
    }
  };
  await copyInto(source, target);
  return { source, entries };
}
