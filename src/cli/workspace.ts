import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { link, lstat, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { createCapabilityProfile, type CapabilityContext, type CapabilityJson, type CapabilityObject, type CapabilityProfile } from "../capabilities.ts";
import { boundedText } from "../validation.ts";
import { withWorkspaceWriteLock, workspaceCoordinationRoot } from "./write-coordination.ts";
import { assertPrivateStat, canonicalizePrivatePath, fsyncDirectory, matchesPrivateStat, openPrivateRead, openPrivateWrite, PRIVATE_CONTROL_REJECT } from "../private-file.ts";

export const CLI_WORKSPACE_PROFILE_ID = "xcb.workspace";
export const CLI_WORKSPACE_PROFILE_VERSION = 1;

const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES = 512;
const MAX_DEPTH = 12;

const fail = (code: string): never => { throw new Error(code); };

function workspacePath(root: string, rawPath: unknown, { allowRoot = false } = {}): string {
  const text = boundedText(rawPath, 1024);
  if (text.includes("\0") || isAbsolute(text)) fail("WORKSPACE_PATH_INVALID");
  const resolved = resolve(root, text);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || (rel === "" && !allowRoot)) fail("WORKSPACE_PATH_ESCAPES");
  if (rel !== "" && rel.split(sep).length > MAX_DEPTH) fail("WORKSPACE_PATH_DEPTH");
  return resolved;
}

/** Reject any symlink component inside the workspace root before an effect. */
function assertNoLinks(root: string, target: string, { allowLeafMissing = false } = {}): void {
  const rel = relative(root, target);
  const parts = rel.split(sep);
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && (index === parts.length - 1 ? allowLeafMissing : false)) return;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("WORKSPACE_PATH_MISSING");
      throw error;
    }
    if (stat.isSymbolicLink()) fail("WORKSPACE_PATH_LINK");
    if (index < parts.length - 1 && !stat.isDirectory()) fail("WORKSPACE_PATH_INVALID");
  }
}

function revisionOf(stat: { size: number | bigint; mtimeNs?: bigint; mtimeMs?: number; ino?: number | bigint; dev?: number | bigint }): string {
  const mtime = stat.mtimeNs !== undefined ? stat.mtimeNs : BigInt(Math.trunc(Number(stat.mtimeMs ?? 0) * 1e6));
  return createHash("sha256").update(`${String(stat.dev ?? 0)}:${String(stat.ino ?? 0)}:${String(stat.size)}:${String(mtime)}`).digest("hex").slice(0, 32);
}

/** Physical workspace port for the CLI profile. Reads and writes stay inside the
 * resolved root; every write is conditional on the revision observed by the last
 * read (or an explicit null for a new file), preserving the broker's
 * read-before-write contract. */
export function createCliWorkspace(rootInput: string, options: Readonly<{ coordinationRoot?: string }> = {}) {
  const root = canonicalizePrivatePath(rootInput, { code: "WORKSPACE_ROOT_INVALID", reject: PRIVATE_CONTROL_REJECT, maxLength: Infinity });
  const identity = lstatSync(root, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || realpathSync(root) !== root) throw new Error("WORKSPACE_ROOT_INVALID");
  const coordinationRoot = options.coordinationRoot ?? workspaceCoordinationRoot();
  const checkRoot = () => {
    const current = lstatSync(root, { bigint: true });
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino
      || realpathSync(root) !== root) throw new Error("WORKSPACE_ROOT_CHANGED");
  };
  /** The port itself stays confined: every operation requires the resolved
   * target beneath the root even when callers bypass the tool layer. */
  const confined = (target: string, { allowRoot = false } = {}): string => {
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || (rel === "" && !allowRoot)) fail("WORKSPACE_PATH_ESCAPES");
    if (rel !== "" && rel.split(sep).length > MAX_DEPTH) fail("WORKSPACE_PATH_DEPTH");
    return target;
  };
  const readRevision = async (target: string): Promise<{ text: string; revision: string }> => {
    confined(target);
    assertNoLinks(root, target);
    const stat = await lstat(target);
    assertPrivateStat(stat, { kind: "file", links: "single", size: { max: MAX_FILE_BYTES } }, "WORKSPACE_FILE_INVALID");
    const handle = await openPrivateRead(target, { nonblock: false });
    try {
      const stable = await handle.stat();
      assertPrivateStat(stable, { kind: "file", size: { max: MAX_FILE_BYTES } }, "WORKSPACE_FILE_INVALID");
      const bytes = await handle.readFile();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { text, revision: revisionOf(stable) };
    } finally {
      await handle.close();
    }
  };
  const writeRevision = async (target: string, text: string, expectedRevision: string | null): Promise<{ revision: string }> => {
    confined(target);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) fail("WORKSPACE_FILE_LIMIT");
    checkRoot();
    return withWorkspaceWriteLock(root, coordinationRoot, async () => {
      const check = async () => {
        checkRoot();
        assertNoLinks(root, target, { allowLeafMissing: true });
        let stat;
        try { stat = await lstat(target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (stat !== undefined && !matchesPrivateStat(stat, { kind: "file", links: "single", size: { max: MAX_FILE_BYTES } })) fail("WORKSPACE_FILE_INVALID");
        if (expectedRevision === null && stat !== undefined) fail("WORKSPACE_REVISION_REQUIRED");
        if (expectedRevision !== null) {
          if (stat === undefined) fail("WORKSPACE_FILE_MISSING");
          if ((await readRevision(target)).revision !== expectedRevision) fail("WORKSPACE_REVISION_MISMATCH");
        }
        return stat;
      };
      const current = await check();
      const directory = dirname(target);
      const temp = join(directory, `.xcb-write-${randomBytes(16).toString("hex")}.tmp`);
      const staged = await openPrivateWrite(temp);
      try {
        await staged.writeFile(text);
        await staged.chmod(current === undefined ? 0o600 : current.mode & 0o777);
        await staged.sync();
        await check();
        if (expectedRevision === null) {
          await link(temp, target);
          await unlink(temp);
        } else await rename(temp, target);
        await fsyncDirectory(directory);
        return { revision: revisionOf(await lstat(target)) };
      } finally {
        await staged.close();
        await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      }
    });
  };
  const listEntries = async (target: string): Promise<readonly string[]> => {
    confined(target, { allowRoot: true });
    assertNoLinks(root, target);
    const stat = await lstat(target);
    if (!stat.isDirectory()) fail("WORKSPACE_DIRECTORY_INVALID");
    const entries = await readdir(target, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory() && !entry.isFile()) continue;
      names.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
    }
    return Object.freeze(names.sort());
  };
  const search = async (target: string, query: string): Promise<readonly { path: string; line: number; text: string }[]> => {
    boundedText(query, 512);
    if (query.length === 0 || query.includes("\0")) fail("WORKSPACE_QUERY_INVALID");
    const hits: { path: string; line: number; text: string }[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || hits.length >= 128) return;
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.slice(0, MAX_ENTRIES)) {
        if (hits.length >= 128) return;
        if (entry.isSymbolicLink() || entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".xcb-")) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        let stat;
        try {
          stat = lstatSync(path);
        } catch {
          continue;
        }
        if (!matchesPrivateStat(stat, { kind: "file", size: { max: MAX_FILE_BYTES } })) continue;
        let text: string;
        try {
          text = (await readRevision(path)).text;
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (const [index, line] of lines.entries()) {
          if (hits.length >= 128) return;
          if (line.includes(query)) hits.push({ path: relative(root, path).split(sep).join("/"), line: index + 1, text: boundedText(line.trim(), 256) });
        }
      }
    };
    await visit(target === root ? root : confined(target, { allowRoot: true }), 0);
    return Object.freeze(hits);
  };
  return Object.freeze({ root, readRevision, writeRevision, listEntries, search });
}

export type CliWorkspace = ReturnType<typeof createCliWorkspace>;

const objectSchema = (properties: CapabilityObject, required: readonly string[]): CapabilityObject => Object.freeze({
  type: "object", properties, required: [...required], additionalProperties: false,
});

const requireString = (value: CapabilityJson | undefined, code: string): string =>
  typeof value === "string" ? value : fail(code);

/** The agent's complete tool surface inside one CLI workspace: bounded file
 * list/read/conditional-write/search plus the host public-web port. There is no
 * shell, process, or arbitrary-path operation. */
export function createCliWorkspaceProfile(workspace: CliWorkspace, web?: Readonly<{ fetch(url: string, signal: AbortSignal): Promise<{ text: string }> }>): CapabilityProfile {
  const string = (extra: CapabilityObject = {}): CapabilityObject => Object.freeze({ type: "string", ...extra });
  return createCapabilityProfile({
    id: CLI_WORKSPACE_PROFILE_ID,
    version: CLI_WORKSPACE_PROFILE_VERSION,
    tools: [
      {
        name: "workspace.list",
        description: "List entries of a directory in the workspace. Paths are workspace-relative; directories end with '/'.",
        inputSchema: objectSchema({ path: string({ maxLength: 1024 }) }, ["path"]),
        parseInput(input) {
          return Object.freeze({ path: requireString(input.path, "WORKSPACE_INPUT_INVALID") });
        },
        async execute(input, context) {
          context.assertActive();
          const entries = await workspace.listEntries(workspacePath(workspace.root, (input as { path: string }).path, { allowRoot: true }));
          context.assertActive();
          return { entries: [...entries] };
        },
      },
      {
        name: "workspace.read",
        description: "Read a UTF-8 file in the workspace (max 256 KiB) and its revision. Keep the revision to write the file later.",
        inputSchema: objectSchema({ path: string({ maxLength: 1024 }) }, ["path"]),
        parseInput(input) {
          return Object.freeze({ path: requireString(input.path, "WORKSPACE_INPUT_INVALID") });
        },
        async execute(input, context) {
          context.assertActive();
          const result = await workspace.readRevision(workspacePath(workspace.root, (input as { path: string }).path));
          context.assertActive();
          return { text: result.text, revision: result.revision };
        },
      },
      {
        name: "workspace.write",
        description: "Write a UTF-8 file in the workspace. expectedRevision must be the revision from the last read, or null only for a new file.",
        inputSchema: objectSchema({ path: string({ maxLength: 1024 }), text: string({ maxLength: MAX_FILE_BYTES }), expectedRevision: Object.freeze({ anyOf: [string(), Object.freeze({ type: "null" })] }) }, ["path", "text", "expectedRevision"]),
        parseInput(input) {
          const expectedRevision = input.expectedRevision;
          if (expectedRevision !== null && typeof expectedRevision !== "string") fail("WORKSPACE_INPUT_INVALID");
          return Object.freeze({
            path: requireString(input.path, "WORKSPACE_INPUT_INVALID"),
            text: requireString(input.text, "WORKSPACE_INPUT_INVALID"),
            expectedRevision: expectedRevision ?? null,
          });
        },
        async execute(input, context) {
          context.assertActive();
          const value = input as { path: string; text: string; expectedRevision: string | null };
          const result = await workspace.writeRevision(workspacePath(workspace.root, value.path), boundedText(value.text, MAX_FILE_BYTES, true), value.expectedRevision === null ? null : boundedText(value.expectedRevision, 160));
          context.assertActive();
          return { revision: result.revision };
        },
      },
      {
        name: "workspace.search",
        description: "Find literal text in workspace files (skips .git, node_modules and symlinks; max 128 matches).",
        inputSchema: objectSchema({ path: string({ maxLength: 1024 }), query: string({ minLength: 1, maxLength: 512 }) }, ["path", "query"]),
        parseInput(input) {
          const query = requireString(input.query, "WORKSPACE_INPUT_INVALID");
          if (query.length === 0) fail("WORKSPACE_INPUT_INVALID");
          return Object.freeze({ path: requireString(input.path, "WORKSPACE_INPUT_INVALID"), query });
        },
        async execute(input, context) {
          context.assertActive();
          const value = input as { path: string; query: string };
          const matches = await workspace.search(workspacePath(workspace.root, value.path, { allowRoot: true }), boundedText(value.query, 512));
          context.assertActive();
          return { matches: matches.map((match) => Object.freeze({ ...match })) };
        },
      },
      ...(web === undefined ? [] : [{
        name: "web.fetch",
        description: "Fetch bounded public HTTPS text (256 KiB, 15s). Private addresses and authenticated requests are unavailable.",
        inputSchema: objectSchema({ url: string({ maxLength: 2048 }) }, ["url"]),
        parseInput(input: CapabilityObject) {
          return Object.freeze({ url: requireString(input.url, "WORKSPACE_INPUT_INVALID") });
        },
        async execute(input: CapabilityJson, context: CapabilityContext) {
          context.assertActive();
          const result = await web.fetch(boundedText((input as { url: string }).url, 2048), context.signal);
          context.assertActive();
          return { text: result.text };
        },
      }]),
    ],
  });
}
