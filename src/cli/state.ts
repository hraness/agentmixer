import { constants } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { boundedText } from "../validation.ts";

export const CLI_STATE_ENV = "AGENTMIXER_STATE";
const STATE_DIRNAME = ".agentmixer";

/** Resolve the CLI state root without creating it. AGENTMIXER_STATE wins when it
 * names an absolute path; otherwise the root is ~/.agentmixer. */
export function cliStateRootPath(env: (name: string) => string | undefined = (name) => process.env[name]): string {
  const override = env(CLI_STATE_ENV);
  if (override !== undefined) {
    if (typeof override !== "string" || !isAbsolute(override) || resolve(override) !== override || /[\x00-\x1f\x7f]/u.test(override)) {
      throw new Error("AGENTMIXER_STATE_INVALID");
    }
    return override;
  }
  const home = homedir();
  if (typeof home !== "string" || !isAbsolute(home)) throw new Error("AGENTMIXER_HOME_UNAVAILABLE");
  return join(home, STATE_DIRNAME);
}

/** Open an existing physical directory owned by this user with mode 0700. */
export async function privateDirectory(path: string): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/u.test(path)) {
    throw new Error("AGENTMIXER_DIRECTORY_INVALID");
  }
  const actual = await realpath(path);
  const stat = await lstat(path);
  if (actual !== path || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("AGENTMIXER_DIRECTORY_NOT_PRIVATE");
  }
  return actual;
}

/** Create the state root and the named child, both physical and mode 0700. */
export async function ensureCliState(child?: string): Promise<{ root: string; path: string }> {
  const root = await mkdir(cliStateRootPath(), { mode: 0o700, recursive: true }).then(async () => await privateDirectory(cliStateRootPath()));
  if (child === undefined) return { root, path: root };
  const name = boundedText(child, 64);
  if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new Error("AGENTMIXER_STATE_CHILD_INVALID");
  const path = join(root, name);
  await mkdir(path, { mode: 0o700, recursive: true });
  return { root, path: await privateDirectory(path) };
}

export { constants as fsConstants };
