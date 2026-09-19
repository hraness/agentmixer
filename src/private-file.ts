import { constants, openSync, type BigIntStats, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Private-file custody primitives. This module is the single audited home for
 * the checks every private-state owner re-implemented: canonical path grammar,
 * owner-only directory assertion, held-descriptor stat shape checks, stable
 * file identity comparison, bounded held-fd reads, atomic create-once durable
 * writes, and directory fsync. It is deliberately not exported through
 * `index.ts`; public seams keep their names and delegate here.
 *
 * Every predicate takes its caller's error code so each site's observable
 * contract is unchanged — the same checks fire under the same conditions and
 * report through the same `new Error(code)`. Call order inside each helper
 * preserves the syscall order of the site it replaced (lstat before realpath
 * or the reverse, stats collected before or after a content check). Helpers
 * that revalidate an opened file always take the live `FileHandle` or a stat
 * snapshot: they never close and reopen, so the before/after fstat-diff keeps
 * pinning the exact object that was opened.
 *
 * Deliberately out of scope: ordering/state machines (journals, lock
 * lifecycles, scratch tree walks) stay in the calling modules, as do workspace
 * ports whose files are intentionally not owner-only.
 */

const fail = (code: string): never => { throw new Error(code); };

/** Canonical path ceiling shared by the private-state modules. */
export const PRIVATE_PATH_MAX_LENGTH = 4096;
/** Path byte rejection for custody paths: C0 controls, DEL, `"` and `\`. */
export const PRIVATE_PATH_REJECT = /[\x00-\x1f\x7f"\\]/u;
/** Control-byte-only rejection (C0 + DEL) for paths that permit `"` and `\`. */
export const PRIVATE_CONTROL_REJECT = /[\x00-\x1f\x7f]/u;
/** C0-only rejection for sites that historically allowed DEL as well. */
export const PRIVATE_C0_REJECT = /[\x00-\x1f]/u;

/** Canonical path grammar: absolute, lexically resolved, length-capped and
 * control-clean. `resolved: false` keeps only the absolute check for sites
 * that canonicalize through `realpath` instead of the lexical form; `reject:
 * null` drops the character check; `maxLength: Infinity` drops the cap;
 * `measureBytes` counts UTF-8 bytes instead of UTF-16 units (codex-host). */
export function canonicalizePrivatePath(value: unknown, rule: Readonly<{
  code: string;
  resolved?: boolean;
  reject?: RegExp | null;
  maxLength?: number;
  measureBytes?: boolean;
}>): string {
  assertAbsolutePrivatePath(value, rule.code);
  const reject = rule.reject === undefined ? PRIVATE_PATH_REJECT : rule.reject;
  if ((rule.resolved !== false && resolve(value) !== value)
    || (rule.measureBytes === true ? Buffer.byteLength(value) : value.length) > (rule.maxLength ?? PRIVATE_PATH_MAX_LENGTH)
    || (reject !== null && reject.test(value))) fail(rule.code);
  return value;
}

/** The absolute-path half of a split-code site: grammar failures and physical
 * custody failures report different codes, so they stay two calls. */
export function assertAbsolutePrivatePath(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value)) fail(code);
}

/** Ownership expectation for a private file or directory. `"self"` requires
 * the current uid and fails the site code when `getuid` is unavailable;
 * `"selfOrThrow"` calls `getuid!()` so an absent uid check throws exactly as
 * the replaced site did; the `OrRoot` variants additionally admit uid 0 (a
 * root-owned system artifact is at least as tamper-evident as a user file);
 * a number, bigint, or list is an exact uid set resolved by the caller. */
export type PrivateOwner = "self" | "selfOrThrow" | "selfOrRoot" | "selfOrRootOrThrow" | number | bigint | readonly (number | bigint)[];

function ownerAccepted(owner: PrivateOwner, uid: number | bigint): boolean {
  if (typeof owner === "number" || typeof owner === "bigint") return BigInt(uid) === BigInt(owner);
  if (Array.isArray(owner)) return (owner as readonly (number | bigint)[]).some(accepted => BigInt(uid) === BigInt(accepted));
  const allowRoot = owner === "selfOrRoot" || owner === "selfOrRootOrThrow";
  const self = owner === "selfOrThrow" || owner === "selfOrRootOrThrow" ? process.getuid!() : process.getuid?.();
  return (allowRoot && BigInt(uid) === 0n) || (self !== undefined && BigInt(uid) === BigInt(self));
}

/** One mode-predicate rule: `(mode & mask)` must equal `equals` and/or differ
 * from `notEquals`. Examples: exact-0600 is `{ mask: 0o7777, equals: 0o600 }`;
 * "some execute bit" is `{ mask: 0o111, notEquals: 0 }`. */
export type PrivateModeRule = Readonly<{ mask: number | bigint; equals?: number | bigint; notEquals?: number | bigint }>;

/** The shape a private file or directory must have. `links: "single"` is the
 * nlink===1 no-hardlink rule; `noSymlink` rejects an lstat symlink result (an
 * O_NOFOLLOW open can never produce one, so it applies to lstat snapshots);
 * `size.min` is an inclusive floor (`min: 1` is the nonempty check). */
export type PrivateStatShape = Readonly<{
  kind?: "file" | "directory";
  owner?: PrivateOwner;
  links?: "single";
  mode?: readonly PrivateModeRule[];
  size?: Readonly<{ min?: number | bigint; max?: number | bigint; equals?: number | bigint }>;
  noSymlink?: boolean;
}>;

/** Boolean form of the private-stat predicate, for sites whose contract is a
 * yes/no answer (mode repair, best-effort probes) rather than a thrown code. */
export function matchesPrivateStat(metadata: Stats | BigIntStats, shape: PrivateStatShape): boolean {
  if (shape.kind === "file" && !metadata.isFile()) return false;
  if (shape.kind === "directory" && !metadata.isDirectory()) return false;
  if (shape.noSymlink === true && metadata.isSymbolicLink()) return false;
  if (shape.owner !== undefined && !ownerAccepted(shape.owner, metadata.uid)) return false;
  if (shape.links === "single" && BigInt(metadata.nlink) !== 1n) return false;
  for (const rule of shape.mode ?? []) {
    const actual = BigInt(metadata.mode) & BigInt(rule.mask);
    if (rule.equals !== undefined && actual !== BigInt(rule.equals)) return false;
    if (rule.notEquals !== undefined && actual === BigInt(rule.notEquals)) return false;
  }
  if (shape.size !== undefined) {
    const size = BigInt(metadata.size);
    if (shape.size.equals !== undefined && size !== BigInt(shape.size.equals)) return false;
    if (shape.size.min !== undefined && size < BigInt(shape.size.min)) return false;
    if (shape.size.max !== undefined && size > BigInt(shape.size.max)) return false;
  }
  return true;
}

/** Throwing form of the shape predicate; `code` is the site's own error. */
export function assertPrivateStat(metadata: Stats | BigIntStats, shape: PrivateStatShape, code: string): void {
  if (!matchesPrivateStat(metadata, shape)) fail(code);
}

/** Comparable stat fields. `mtime`/`ctime` map to `mtimeNs`/`ctimeNs` on
 * BigIntStats and `mtimeMs`/`ctimeMs` on Stats, preserving each site's
 * original precision. The default set is the nine-field identity every
 * custody module compared; sites with a narrower drift set pass a subset. */
export type PrivateIdentityField = "dev" | "ino" | "uid" | "gid" | "mode" | "nlink" | "size" | "mtime" | "ctime";
export const PRIVATE_IDENTITY_FIELDS: readonly PrivateIdentityField[] = Object.freeze(["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtime", "ctime"]);

function statField(metadata: Stats | BigIntStats, field: PrivateIdentityField): number | bigint {
  if (field === "mtime") return "mtimeNs" in metadata ? metadata.mtimeNs : (metadata as Stats).mtimeMs;
  if (field === "ctime") return "ctimeNs" in metadata ? metadata.ctimeNs : (metadata as Stats).ctimeMs;
  return metadata[field];
}

/** Exact field equality between two stat snapshots of the same type. Mixed
 * Stats/BigIntStats pairs compare only the type-shared fields; a mismatched
 * timestamp precision reports unequal (fails closed as drift). */
export function sameFileIdentity(a: Stats | BigIntStats, b: Stats | BigIntStats, fields: readonly PrivateIdentityField[] = PRIVATE_IDENTITY_FIELDS): boolean {
  const bigint = "mtimeNs" in a;
  return fields.every(field => {
    if ((field === "mtime" || field === "ctime") && bigint !== ("mtimeNs" in b)) return false;
    const va = statField(a, field), vb = statField(b, field);
    return typeof va === "bigint" || typeof vb === "bigint" ? BigInt(va) === BigInt(vb) : va === vb;
  });
}

/** The held-fd before/after revalidation: every `observed` snapshot must keep
 * `before`'s identity fields. `requirePlainFile` additionally demands each
 * observed value stay a plain non-symlink file (the codex-host rule). All
 * snapshots come from callers that hold the descriptor open — this predicate
 * never opens, closes, or reopens anything. */
export function assertFileStable(before: Stats | BigIntStats, observed: readonly (Stats | BigIntStats)[], rule: Readonly<{
  code: string;
  fields?: readonly PrivateIdentityField[];
  requirePlainFile?: boolean;
}>): void {
  for (const value of observed) {
    if ((rule.requirePlainFile === true && (!value.isFile() || value.isSymbolicLink()))
      || !sameFileIdentity(before, value, rule.fields ?? PRIVATE_IDENTITY_FIELDS)) fail(rule.code);
  }
}

/** Assert an existing directory is canonical, physical, owner-only and
 * private. `canonical: "self"` (default) requires `realpath(path) === path`;
 * `"resolved"` accepts a noncanonical input whose physical form equals
 * `resolve(path)` (codex-process). `mode: "exact"` is `(mode & 0o7777) ===
 * 0o700` including suid/sgid/sticky rejection; `"perms"` masks only 0o777;
 * `"ownerOnly"` accepts any mode with no group/other bits. `statOrder` keeps
 * the site's lstat-vs-realpath call order so a missing path reports from the
 * same syscall it used to. `metadataFirst` preserves the one short-circuiting
 * site that rejected unsafe metadata before calling realpath. `stats: "number"`
 * preserves the ordinary-Stats precision of its caller; bigint is the default.
 * Returns the metadata and realpath. */
type PrivateDirectoryRule = Readonly<{
  code: string;
  owner?: PrivateOwner;
  mode?: "exact" | "perms" | "ownerOnly";
  canonical?: "self" | "resolved";
  statOrder?: "lstatFirst" | "realpathFirst";
  metadataFirst?: boolean;
  stats?: "number";
}>;
export async function assertPrivateDirectory(path: string, rule: PrivateDirectoryRule & { stats: "number" }): Promise<Readonly<{ metadata: Stats; physical: string }>>;
export async function assertPrivateDirectory(path: string, rule: PrivateDirectoryRule): Promise<Readonly<{ metadata: BigIntStats; physical: string }>>;
export async function assertPrivateDirectory(path: string, rule: PrivateDirectoryRule): Promise<Readonly<{ metadata: Stats | BigIntStats; physical: string }>> {
  const canonical = rule.canonical ?? "self";
  const mode = rule.mode ?? "exact";
  const metadataOk = (metadata: Stats | BigIntStats): boolean => {
    const bits = BigInt(metadata.mode);
    const modeOk = mode === "perms" ? (bits & 0o777n) === 0o700n
      : mode === "ownerOnly" ? (bits & 0o077n) === 0n
      : (bits & 0o7777n) === 0o700n;
    return metadata.isDirectory() && ownerAccepted(rule.owner ?? "self", metadata.uid) && modeOk;
  };
  const stat = async (): Promise<Stats | BigIntStats> => rule.stats === "number" ? await lstat(path) : await lstat(path, { bigint: true });
  let physical: string, metadata: Stats | BigIntStats, metadataAccepted: boolean | undefined;
  if (rule.statOrder === "realpathFirst") {
    physical = await realpath(path); metadata = await stat();
  } else {
    metadata = await stat();
    if (rule.metadataFirst === true) {
      metadataAccepted = metadataOk(metadata);
      if (!metadataAccepted) fail(rule.code);
    }
    physical = await realpath(path);
  }
  const expected = canonical === "resolved" ? resolve(path) : path;
  if (physical !== expected || !(metadataAccepted ?? metadataOk(metadata))) fail(rule.code);
  return Object.freeze({ metadata, physical });
}

/** Open a directory read-only+no-follow and fsync it — the durability proof
 * for a create/unlink/rename inside it. */
export async function fsyncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}

/** Create `path` mode 0700 if missing, fsync the parent on creation, then
 * apply `assertPrivateDirectory` — a preexisting directory is re-verified,
 * never trusted. */
export async function ensurePrivateDirectory(path: string, rule: Omit<PrivateDirectoryRule, "stats">): Promise<BigIntStats> {
  try { await mkdir(path, { mode: 0o700 }); await fsyncDirectory(dirname(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return (await assertPrivateDirectory(path, rule)).metadata;
}

type PrivateReadOptions = Readonly<{
  directory?: boolean;
  nonblock?: boolean;
  missingOk?: boolean;
  openErrorCode?: string;
}>;

/** Open `path` `O_RDONLY | O_NOFOLLOW` — the stable-read descriptor every
 * held-fd check starts from. `nonblock` defaults on (every custody site);
 * `directory` adds O_DIRECTORY; `missingOk` maps ENOENT to null; an
 * `openErrorCode` collapses any open failure (including ELOOP) to the site's
 * invalid-shape code. The caller owns and must close the handle. */
export async function openPrivateRead(path: string, options: PrivateReadOptions & { missingOk: true }): Promise<FileHandle | null>;
export async function openPrivateRead(path: string, options?: PrivateReadOptions): Promise<FileHandle>;
export async function openPrivateRead(path: string, options?: PrivateReadOptions): Promise<FileHandle | null> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW
    | (options?.directory === true ? constants.O_DIRECTORY : 0)
    | (options?.nonblock === false ? 0 : constants.O_NONBLOCK);
  try {
    return await open(path, flags);
  } catch (error) {
    if (options?.missingOk === true && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (options?.openErrorCode !== undefined) fail(options.openErrorCode);
    throw error;
  }
}

type PrivateWriteOptions = Readonly<{
  mode?: number;
  exclusive?: boolean;
  nofollow?: boolean;
  append?: boolean;
  truncate?: boolean;
  create?: boolean;
}>;

function privateWriteFlags(options?: PrivateWriteOptions): number {
  return constants.O_WRONLY
    | (options?.create === false ? 0 : constants.O_CREAT)
    | (options?.nofollow === false ? 0 : constants.O_NOFOLLOW)
    | (options?.exclusive === false ? 0 : constants.O_EXCL)
    | (options?.append === true ? constants.O_APPEND : 0)
    | (options?.truncate === true ? constants.O_TRUNC : 0);
}

/** Open `path` `O_WRONLY | O_CREAT` for a private write. `exclusive` (default)
 * adds O_EXCL — atomic create-once; `nofollow` (default) adds O_NOFOLLOW;
 * `append` adds O_APPEND (append-only journals); `truncate` adds O_TRUNC for
 * the staged-temp rewrite pattern; `create: false` drops O_CREAT so reopening
 * an already-durable journal still asserts the inode exists. The caller owns
 * and must close the handle. */
export async function openPrivateWrite(path: string, options?: PrivateWriteOptions): Promise<FileHandle> {
  return await open(path, privateWriteFlags(options), options?.mode ?? 0o600);
}

/** Synchronous `openPrivateWrite` for the journal descriptors held across a
 * launch: custody must be provable inside synchronous state machines. */
export function openPrivateWriteSync(path: string, options?: PrivateWriteOptions): number {
  return openSync(path, privateWriteFlags(options), options?.mode ?? 0o600);
}

/** Atomic create-once durable write: O_EXCL no-follow create at `mode`
 * (default 0600), the contents, an optional file fsync, close, and an
 * optional parent-directory fsync. `nofollow`/`truncate`/`append` forward to
 * the same flag grammar as `openPrivateWrite` (Node's `"wx"` flag is
 * `nofollow: false, truncate: true`). Callers whose ownership flag must flip
 * between open and write use `openPrivateWrite` directly. */
export async function writeFileOnce(path: string, contents: string | Uint8Array, options?: PrivateWriteOptions & Readonly<{
  syncFile?: boolean;
  syncParent?: boolean;
}>): Promise<void> {
  const fd = await openPrivateWrite(path, options);
  try { await fd.writeFile(contents); if (options?.syncFile === true) await fd.sync(); } finally { await fd.close(); }
  if (options?.syncParent === true) await fsyncDirectory(dirname(path));
}

/** Bounded position-zero read through a held descriptor. `growth` sizes the
 * allocation one byte larger; `loop` retries short reads to EOF/capacity;
 * `into` preserves a caller-owned buffer and its zeroization semantics. No
 * exact-size verdict is made here because several sites collect post-read
 * stats before that verdict. */
export async function readFdBounded(fd: FileHandle, size: number | bigint, options?: Readonly<{
  growth?: boolean;
  loop?: boolean;
  into?: Buffer;
}>): Promise<Readonly<{ buffer: Buffer; bytesRead: number }>> {
  const total = Number(size);
  const buffer = options?.into ?? Buffer.alloc(total + (options?.growth === true ? 1 : 0));
  let bytesRead = 0;
  if (options?.loop === true) {
    while (bytesRead < buffer.length) {
      const part = await fd.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
  } else {
    bytesRead = (await fd.read(buffer, 0, buffer.length, 0)).bytesRead;
  }
  return Object.freeze({ buffer, bytesRead });
}

/** `readFdBounded` plus an immediate exact-size and optional byte-equality
 * verdict. Returns exactly `size` verified bytes. */
export async function readFdExact(fd: FileHandle, size: number | bigint, options: Readonly<{
  code: string;
  contents?: Uint8Array;
  growth?: boolean;
  loop?: boolean;
  into?: Buffer;
}>): Promise<Buffer> {
  const read = await readFdBounded(fd, size, options);
  if (read.bytesRead !== Number(size)
    || (options.contents !== undefined && !read.buffer.subarray(0, read.bytesRead).equals(Buffer.from(options.contents)))) fail(options.code);
  return read.buffer.subarray(0, read.bytesRead);
}

/** Stream at most `size`+1 bytes from position 0 through `onChunk`. Reads are
 * bounded by `size`+1 so growth is always detectable; the return value is the
 * consumed count and the caller compares it at its own verdict position —
 * sites disagree on where that verdict lands relative to their post-read
 * stats, so it is deliberately not asserted here. `earlyGrowth` fails `code`
 * inside the loop (sites whose replaced loop asserted `read <= size`
 * mid-loop); out-of-range reads always fail `code`. The descriptor stays
 * open and owned by the caller. */
export async function streamFdContent(fd: FileHandle, size: number | bigint, options: Readonly<{
  code: string;
  onChunk: (chunk: Buffer) => void | Promise<void>;
  chunkBytes?: number;
  earlyGrowth?: boolean;
}>): Promise<number> {
  const total = Number(size);
  const buffer = Buffer.alloc(Math.min(options.chunkBytes ?? 64 * 1024, total + 1));
  let count = 0;
  while (count <= total) {
    const limit = Math.min(buffer.length, total + 1 - count);
    const part = await fd.read(buffer, 0, limit, count);
    if (!Number.isSafeInteger(part.bytesRead) || part.bytesRead < 0 || part.bytesRead > limit) fail(options.code);
    if (part.bytesRead === 0) break;
    count += part.bytesRead;
    if (options.earlyGrowth === true && count > total) fail(options.code);
    await options.onChunk(buffer.subarray(0, part.bytesRead));
  }
  return count;
}

/** The exact-content private file: optionally durable-create when absent
 * (EEXIST tolerated — a prior run may have left it), then open no-follow,
 * require a 0600 single-link self-owned file of exactly `contents`' length,
 * read and byte-compare it through the held descriptor, and revalidate the
 * identity against a post-read fstat and fresh lstat. `statsEarly` collects
 * those two snapshots before the content check (the browser/account order);
 * `stableCode`/`stablePlainFile` model the codex-host stability predicate
 * where identity drift reports a different code than content drift. */
export async function readExactPrivateFile(path: string, contents: string, options: Readonly<{
  invalidCode: string;
  changedCode: string;
  create?: boolean;
  loop?: boolean;
  statsEarly?: boolean;
  stableCode?: string;
  stablePlainFile?: boolean;
}>): Promise<void> {
  if (options.create === true) {
    try { await writeFileOnce(path, contents, { syncFile: true, syncParent: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const fd = await openPrivateRead(path);
  try {
    const before = await fd.stat({ bigint: true });
    assertPrivateStat(before, { kind: "file", owner: "selfOrThrow", links: "single",
      mode: [{ mask: 0o7777, equals: 0o600 }], size: { equals: Buffer.byteLength(contents) } }, options.invalidCode);
    if (options.statsEarly === true) {
      // Browser/account order: one bounded read, then collect both snapshots,
      // then the combined content+identity assertion under the changed code.
      const read = Buffer.alloc(Buffer.byteLength(contents) + 1);
      const result = await fd.read(read, 0, read.length, 0);
      const after = await fd.stat({ bigint: true }), named = await lstat(path, { bigint: true });
      if (result.bytesRead !== read.length - 1 || !read.subarray(0, result.bytesRead).equals(Buffer.from(contents))) fail(options.changedCode);
      assertFileStable(before, [after, named], { code: options.stableCode ?? options.changedCode, ...(options.stablePlainFile === true ? { requirePlainFile: true } : {}) });
    } else {
      await readFdExact(fd, Buffer.byteLength(contents), { code: options.changedCode, contents: Buffer.from(contents), growth: true, ...(options.loop === true ? { loop: true } : {}) });
      assertFileStable(before, [await fd.stat({ bigint: true }), await lstat(path, { bigint: true })],
        { code: options.stableCode ?? options.changedCode, ...(options.stablePlainFile === true ? { requirePlainFile: true } : {}) });
    }
  } finally { await fd.close(); }
}
