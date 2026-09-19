import { createHash } from "node:crypto";
import { type BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { assertFileStable, assertPrivateStat, canonicalizePrivatePath, openPrivateRead, streamFdContent, PRIVATE_CONTROL_REJECT } from "./private-file.ts";

export const CODEX_HOST_BUN_VERSION = "1.3.14";
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
export type CodexParentRuntimeBinding = Readonly<{
  /** Supplied by an independently admitted distribution, never derived here or from contact/owner JSON. */
  expectedSha256: string;
}>;
export type CodexHostPlatform = "darwin" | "linux";
export type CodexHostArch = "arm64" | "x64";
export type CodexHostRuntime = Readonly<{
  executablePath: string; version: "1.3.14"; platform: CodexHostPlatform; arch: CodexHostArch; sha256: string;
}>;
type RuntimeFacts = Readonly<{
  version: string | undefined; reportedVersion: string | undefined; platform: string; arch: string;
  uid: number | undefined; effectiveUid: number | undefined;
}>;

function admittedDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("CODEX_HOST_PIN_INVALID");
  return value;
}

function bindingDigest(value: CodexParentRuntimeBinding): string {
  if (value === null || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== 1) throw new Error("CODEX_HOST_BINDING_INVALID");
  const descriptor = Object.getOwnPropertyDescriptor(value, "expectedSha256");
  if (!descriptor || !("value" in descriptor)) throw new Error("CODEX_HOST_BINDING_INVALID");
  return admittedDigest(descriptor.value);
}

/** Pure internal validation seam. The actual entrypoint supplies these facts itself. */
export function assertCodexHostRuntimeFacts(facts: RuntimeFacts): void {
  if (facts.version !== CODEX_HOST_BUN_VERSION || facts.reportedVersion !== CODEX_HOST_BUN_VERSION
    || (facts.platform !== "darwin" && facts.platform !== "linux") || (facts.arch !== "arm64" && facts.arch !== "x64")
    || !Number.isSafeInteger(facts.uid) || Number(facts.uid) < 0 || facts.uid !== facts.effectiveUid) {
    throw new Error("CODEX_HOST_RUNTIME_UNSUPPORTED");
  }
}

function executableMetadata(value: BigIntStats, uid: number): void {
  assertPrivateStat(value, { kind: "file", noSymlink: true, links: "single", owner: [0n, BigInt(uid)],
    mode: [{ mask: 0o022, equals: 0 }, { mask: 0o111, notEquals: 0 }, { mask: 0o6000, equals: 0 }],
    size: { min: 1n, max: BigInt(MAX_EXECUTABLE_BYTES) } }, "CODEX_HOST_EXECUTABLE_INVALID");
}

/** Internal file-race predicate; alone this never admits a runtime or a digest. */
export function assertCodexHostFileStable(before: BigIntStats, ...observed: readonly BigIntStats[]): void {
  assertFileStable(before, observed, { code: "CODEX_HOST_EXECUTABLE_CHANGED", requirePlainFile: true,
    fields: ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtime", "ctime"] });
}

/** File-only verification for synthetic fixtures; no runtime identity or qualification is asserted. */
export async function inspectCodexHostExecutable(executablePath: string, expectedSha256: string): Promise<Readonly<{ executablePath: string; sha256: string }>> {
  const pin = admittedDigest(expectedSha256), uid = process.getuid?.();
  canonicalizePrivatePath(executablePath, { code: "CODEX_HOST_PATH_INVALID", measureBytes: true, reject: PRIVATE_CONTROL_REJECT });
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) throw new Error("CODEX_HOST_RUNTIME_UNSUPPORTED");
  try {
    if (await realpath(executablePath) !== executablePath) throw new Error("CODEX_HOST_PATH_INVALID");
    const initial = await lstat(executablePath, { bigint: true });
    executableMetadata(initial, uid!);
    const handle = await openPrivateRead(executablePath);
    try {
      const before = await handle.stat({ bigint: true });
      executableMetadata(before, uid!);
      assertCodexHostFileStable(initial, before);
      const digest = createHash("sha256");
      // One extra byte detects growth; the fixed buffer avoids allocating from unchecked file metadata.
      const readBytes = await streamFdContent(handle, before.size, { code: "CODEX_HOST_EXECUTABLE_CHANGED", onChunk: chunk => { digest.update(chunk); } });
      const after = await handle.stat({ bigint: true });
      if (await realpath(executablePath) !== executablePath) throw new Error("CODEX_HOST_EXECUTABLE_CHANGED");
      const current = await lstat(executablePath, { bigint: true }), final = await handle.stat({ bigint: true });
      assertCodexHostFileStable(before, after, current, final);
      if (readBytes !== Number(before.size)) throw new Error("CODEX_HOST_EXECUTABLE_CHANGED");
      const sha256 = digest.digest("hex");
      if (sha256 !== pin) throw new Error("CODEX_HOST_PIN_MISMATCH");
      return Object.freeze({ executablePath, sha256 });
    } finally { await handle.close(); }
  } catch (error) {
    // Do not copy platform errors containing local paths into bounded custody diagnostics.
    if (error instanceof Error && /^CODEX_HOST_(?:PATH_INVALID|EXECUTABLE_INVALID|EXECUTABLE_CHANGED|PIN_MISMATCH)$/u.test(error.message)) throw error;
    throw new Error("CODEX_HOST_FILE_IO_FAILED");
  }
}

/**
 * Match the actual parent Bun executable to a previously admitted artifact pin.
 * There is no executable/facts override, discovery, subprocess, or self-admission path.
 * This records filesystem/runtime identity at inspection time; it is not a provenance
 * proof, inspection of already loaded machine code, or a sandbox qualification.
 */
export async function inspectCodexHostRuntime(binding: CodexParentRuntimeBinding): Promise<CodexHostRuntime> {
  const expectedSha256 = bindingDigest(binding), executablePath = process.execPath;
  const facts = {
    version: typeof Bun === "undefined" ? undefined : Bun.version, reportedVersion: process.versions.bun,
    platform: process.platform, arch: process.arch, uid: process.getuid?.(), effectiveUid: process.geteuid?.(),
  };
  assertCodexHostRuntimeFacts(facts);
  const executable = await inspectCodexHostExecutable(executablePath, expectedSha256);
  return Object.freeze({ ...executable, version: CODEX_HOST_BUN_VERSION,
    platform: facts.platform as CodexHostPlatform, arch: facts.arch as CodexHostArch });
}
