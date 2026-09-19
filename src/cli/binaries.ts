import { statSync } from "node:fs";
import { chmod, lstat, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

import { claudeCodeVersionAdmitted } from "../claude-sdk.ts";
import { CODEX_NATIVE_SHA256, CODEX_NATIVE_VERSION } from "../codex-process.ts";
import { devinCliVersionMatches } from "./devin.ts";
import { boundedText } from "../validation.ts";
import { assertPrivateStat, canonicalizePrivatePath, matchesPrivateStat, openPrivateRead, PRIVATE_CONTROL_REJECT } from "../private-file.ts";

export const CLI_CODEX_ENV = "XCB_CODEX";
export const CLI_CLAUDE_ENV = "XCB_CLAUDE";
export const CLI_DEVIN_ENV = "XCB_DEVIN";
/** Pre-0.4.0 pin names, honored only when the XCB_* variable is unset. */
const LEGACY_CLI_CODEX_ENV = "AGENTMIXER_CODEX";
const LEGACY_CLI_CLAUDE_ENV = "AGENTMIXER_CLAUDE";
const LEGACY_CLI_DEVIN_ENV = "AGENTMIXER_DEVIN";

export type CliProviderName = "codex" | "claude" | "devin";
export type CliBinaryInspection = Readonly<{
  provider: CliProviderName;
  executablePath: string;
  version: string;
  sha256: string;
  pinnedSha256: string | null;
  versionMatches: boolean;
  digestMatches: boolean;
}>;

const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;

/** Absolute, physical, user-owned executable file; bounded read for hashing. */
export async function inspectCliExecutable(rawPath: unknown): Promise<{ executablePath: string; sha256: string; bytes: Uint8Array }> {
  const canonical = canonicalizePrivatePath(rawPath, { code: "XCB_EXECUTABLE_INVALID", resolved: false, reject: PRIVATE_CONTROL_REJECT, maxLength: Infinity });
  const executablePath = await realpath(canonical);
  const stat = await lstat(executablePath);
  assertPrivateStat(stat, { kind: "file", noSymlink: true, links: "single", owner: "selfOrRoot",
    mode: [{ mask: 0o022, equals: 0 }, { mask: 0o111, notEquals: 0 }, { mask: 0o6000, equals: 0 }],
    size: { min: 1, max: MAX_EXECUTABLE_BYTES } }, "XCB_EXECUTABLE_INVALID");
  const handle = await openPrivateRead(executablePath, { nonblock: false });
  try {
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_EXECUTABLE_BYTES) throw new Error("XCB_EXECUTABLE_INVALID");
    return { executablePath, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: new Uint8Array(bytes) };
  } finally {
    await handle.close();
  }
}

function executableExists(path: string): boolean {
  try {
    // Discovery may legitimately meet a shim symlink (bun/npm global bins); the
    // strict target check happens in inspectCliExecutable on the resolved path.
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function pathEntries(env: (name: string) => string | undefined): string[] {
  const raw = env("PATH");
  if (typeof raw !== "string") return [];
  return raw.split(delimiter).filter((entry) => isAbsolute(entry) && entry.length <= 512).slice(0, 64);
}

/** Closed discovery order: explicit env pin, PATH, then known install locations. */
const PROVIDER_ENV: Record<CliProviderName, string> = { claude: CLI_CLAUDE_ENV, codex: CLI_CODEX_ENV, devin: CLI_DEVIN_ENV };
const LEGACY_PROVIDER_ENV: Record<CliProviderName, string> = { claude: LEGACY_CLI_CLAUDE_ENV, codex: LEGACY_CLI_CODEX_ENV, devin: LEGACY_CLI_DEVIN_ENV };

export function cliBinaryCandidates(provider: CliProviderName, env: (name: string) => string | undefined = (name) => process.env[name]): readonly string[] {
  const pinned = env(PROVIDER_ENV[provider]) ?? env(LEGACY_PROVIDER_ENV[provider]);
  const command = provider;
  const home = homedir();
  const known = provider === "claude"
    ? [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")]
    : provider === "codex"
      ? [join(home, ".codex", "bin", "codex"), join(home, ".local", "bin", "codex")]
      : [join(home, ".local", "bin", "devin"), join(home, ".devin", "bin", "devin")];
  const found = [
    ...(pinned !== undefined ? [pinned] : []),
    ...pathEntries(env).map((entry) => join(entry, command)),
    ...known,
  ];
  return Object.freeze([...new Set(found)].filter((path) => isAbsolute(path) && path.length <= 512).slice(0, 32));
}

function reportedVersion(executablePath: string): string | null {
  let result;
  try {
    result = spawnSync(executablePath, ["--version"], {
      timeout: 15_000, encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: homedir(), LANG: "en_US.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const match = /(?:^|\s)(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:[-+.][0-9A-Za-z.-]*)?/u.exec(result.stdout.trim());
  return match === null ? null : boundedText(match[0].trim(), 160);
}

/** Explicit admission-time repair only: tighten a user-owned discovered
 * executable to 0755 so it passes the strict file-shape check. Never applied to
 * root-owned or foreign-owned files and never loosens anything. */
export async function repairCliExecutableMode(rawPath: unknown): Promise<boolean> {
  if (typeof rawPath !== "string" || !isAbsolute(rawPath)) return false;
  let resolved: string;
  try {
    resolved = await realpath(rawPath);
  } catch {
    return false;
  }
  try {
    const stat = await lstat(resolved);
    if (!matchesPrivateStat(stat, { kind: "file", noSymlink: true, links: "single", owner: "self", mode: [{ mask: 0o6000, equals: 0 }] })) return false;
    if ((stat.mode & 0o022) === 0) return false;
    await chmod(resolved, 0o755);
    return true;
  } catch {
    return false;
  }
}

/** Inspect a discovered provider binary. Fails closed on any shape, ownership,
 * or version mismatch; the digest pin is reported separately because Claude's
 * is host-admitted rather than source-pinned. */
export async function inspectCliBinary(provider: CliProviderName, env: (name: string) => string | undefined = (name) => process.env[name], repair = false): Promise<CliBinaryInspection | null> {
  for (const candidate of cliBinaryCandidates(provider, env)) {
    if (!executableExists(candidate)) continue;
    let inspected;
    try {
      inspected = await inspectCliExecutable(candidate);
    } catch {
      if (!repair || !(await repairCliExecutableMode(candidate))) continue;
      try {
        inspected = await inspectCliExecutable(candidate);
      } catch {
        continue;
      }
    }
    const version = reportedVersion(inspected.executablePath);
    if (version === null) continue;
    const versionMatches = provider === "codex" ? version === CODEX_NATIVE_VERSION
      : provider === "claude" ? claudeCodeVersionAdmitted(version)
        : devinCliVersionMatches(version);
    const pinnedSha256 = provider === "codex" ? CODEX_NATIVE_SHA256 : null;
    return Object.freeze({
      provider, executablePath: inspected.executablePath, version, sha256: inspected.sha256,
      pinnedSha256, versionMatches,
      digestMatches: pinnedSha256 === null ? true : inspected.sha256 === pinnedSha256,
    });
  }
  return null;
}
