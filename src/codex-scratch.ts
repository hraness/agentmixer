import { createHash } from "node:crypto";
import { type BigIntStats } from "node:fs";
import { lstat, opendir, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { assertPrivateStat, canonicalizePrivatePath, openPrivateRead, readFdExact, sameFileIdentity, PRIVATE_C0_REJECT } from "./private-file.ts";

const MAX_CONFIGURATION_BYTES = 256 * 1024;
const directories = ["", "home", "state", "tmp", "work"] as const;
type Directory = typeof directories[number];
type EntryPath = Directory | "state/config.toml";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export type CodexScratchEntry = Readonly<{
  path: EntryPath; kind: "directory" | "file"; device: string; inode: string;
  uid: number; mode: number; links: number; size: string; modifiedNs: string; changedNs: string;
}>;
export type CodexScratchInspection = Readonly<{
  schema: "xcb.codex-scratch.v1";
  configurationSha256: string; configurationBytes: number;
  /** Content/layout identity, independent of the newly allocated directory inodes. */
  contentSha256: string;
  /** Exact inspected physical root, relative entries, and stable filesystem metadata. */
  identitySha256: string;
  entries: readonly CodexScratchEntry[];
}>;

function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
const sameIdentity = sameFileIdentity;
function privateEntry(metadata: BigIntStats, directory: boolean, uid: number) {
  assertPrivateStat(metadata, { kind: directory ? "directory" : "file", owner: uid,
    mode: [{ mask: 0o7777, equals: directory ? 0o700 : 0o600 }], ...(directory ? {} : { links: "single" as const }) }, "CODEX_SCRATCH_ENTRY_UNSAFE");
}
function entry(path: EntryPath, metadata: BigIntStats): CodexScratchEntry {
  check(metadata.uid <= BigInt(Number.MAX_SAFE_INTEGER) && metadata.nlink <= BigInt(Number.MAX_SAFE_INTEGER), "CODEX_SCRATCH_METADATA_BOUND");
  return Object.freeze({ path, kind: metadata.isDirectory() ? "directory" : "file", device: String(metadata.dev), inode: String(metadata.ino),
    uid: Number(metadata.uid), mode: Number(metadata.mode & 0o7777n), links: Number(metadata.nlink), size: String(metadata.size),
    modifiedNs: String(metadata.mtimeNs), changedNs: String(metadata.ctimeNs) });
}
async function checkNames(path: string, relative: Directory) {
  const expected: readonly string[] = relative === "" ? ["home", "state", "tmp", "work"] : relative === "state" ? ["config.toml"] : [];
  const found: string[] = [], iterator = await opendir(path, { bufferSize: 8 });
  try {
    for (;;) {
      const item = await iterator.read(); if (!item) break;
      check(found.length < expected.length && expected.includes(item.name), "CODEX_SCRATCH_UNEXPECTED_ENTRY");
      found.push(item.name);
    }
  } finally { await iterator.close(); }
  check(JSON.stringify(found.sort()) === JSON.stringify(expected), "CODEX_SCRATCH_LAYOUT_INVALID");
}

/** Inspect only a newly created host scratch tree, immediately before launch.
 * Model/tool-written paths must never be supplied to this host-only function.
 * No contact data, aliases, credentials, plugins, or extra files belong here.
 * This is a checked snapshot, not a filesystem lease: a hostile same-UID host
 * or root racing preparation is excluded. The launcher must retain that trust
 * boundary after inspection; the result alone does not qualify a provider. */
export async function inspectCodexScratch(input: { scratch: string; configuration: string | Uint8Array }): Promise<CodexScratchInspection> {
  // Copy caller-owned bytes and primitive input before the first await.
  const scratch = input.scratch, configuration = input.configuration;
  canonicalizePrivatePath(scratch, { code: "CODEX_SCRATCH_ABSOLUTE_PHYSICAL_PATH_REQUIRED", reject: PRIVATE_C0_REJECT, maxLength: Infinity });
  check(typeof configuration === "string" || configuration instanceof Uint8Array, "CODEX_SCRATCH_CONFIGURATION_REQUIRED");
  const bytes = typeof configuration === "string" ? Buffer.byteLength(configuration, "utf8") : configuration.byteLength;
  check(bytes > 0 && bytes <= MAX_CONFIGURATION_BYTES, "CODEX_SCRATCH_CONFIGURATION_BOUND");
  const expected = typeof configuration === "string" ? Buffer.from(configuration, "utf8") : Buffer.from(configuration);
  check(expected.length === bytes, "CODEX_SCRATCH_CONFIGURATION_BOUND");
  const uid = process.getuid?.(); check(uid !== undefined, "CODEX_SCRATCH_OWNER_REQUIRED");
  const handles: FileHandle[] = [];
  const inspected: { relative: EntryPath; path: string; handle: FileHandle; metadata: BigIntStats }[] = [];
  let failed = false;
  try {
    for (const relative of directories) {
      const path = relative ? join(scratch, relative) : scratch;
      check(await realpath(path) === path, "CODEX_SCRATCH_ABSOLUTE_PHYSICAL_PATH_REQUIRED");
      const handle = await openPrivateRead(path, { directory: true }); handles.push(handle);
      const metadata = await handle.stat({ bigint: true }); privateEntry(metadata, true, uid);
      check(sameIdentity(metadata, await lstat(path, { bigint: true })), "CODEX_SCRATCH_IDENTITY_CHANGED");
      inspected.push({ relative, path, handle, metadata });
      await checkNames(path, relative);
    }
    const path = join(scratch, "state", "config.toml");
    const handle = await openPrivateRead(path); handles.push(handle);
    const metadata = await handle.stat({ bigint: true }); privateEntry(metadata, false, uid);
    check(metadata.size === BigInt(expected.length) && metadata.size <= BigInt(MAX_CONFIGURATION_BYTES), "CODEX_SCRATCH_CONFIGURATION_MISMATCH");
    // The extra byte detects growth without an unbounded readFile allocation.
    await readFdExact(handle, expected.length, { code: "CODEX_SCRATCH_CONFIGURATION_MISMATCH", contents: expected, growth: true, loop: true });
    inspected.push({ relative: "state/config.toml", path, handle, metadata });

    // All directory/config FDs remain open while names and path identities are
    // rechecked. Realpath and no-follow stat prevent admitting a replaced alias.
    for (const item of inspected) {
      if (item.relative !== "state/config.toml") await checkNames(item.path, item.relative);
      check(await realpath(item.path) === item.path && sameIdentity(item.metadata, await lstat(item.path, { bigint: true }))
        && sameIdentity(item.metadata, await item.handle.stat({ bigint: true })), "CODEX_SCRATCH_IDENTITY_CHANGED");
    }
    const entries = Object.freeze(inspected.map(item => entry(item.relative, item.metadata)));
    const configurationSha256 = hash(expected);
    const contentSha256 = hash(JSON.stringify({ schema: "xcb.codex-scratch-content.v1", configurationSha256, configurationBytes: expected.length,
      entries: entries.map(item => ({ path: item.path, kind: item.kind, mode: item.mode })) }));
    const identitySha256 = hash(JSON.stringify({ schema: "xcb.codex-scratch-identity.v1", physicalRootSha256: hash(scratch), contentSha256, entries }));
    return Object.freeze({ schema: "xcb.codex-scratch.v1", configurationSha256, configurationBytes: expected.length, contentSha256, identitySha256, entries });
  } catch (error) {
    failed = true;
    if (error instanceof Error && /^CODEX_SCRATCH_[A-Z0-9_]+$/u.test(error.message)) throw error;
    throw new Error("CODEX_SCRATCH_INSPECTION_FAILED");
  } finally {
    const closed = await Promise.allSettled(handles.map(handle => handle.close()));
    if (!failed && closed.some(result => result.status === "rejected")) throw new Error("CODEX_SCRATCH_HANDLE_CLOSE_FAILED");
  }
}
