import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { DEVIN_ACP_PROTOCOL_VERSION } from "../devin-acp.ts";
import { boundedText } from "../validation.ts";
import type { CliBinaryInspection } from "./binaries.ts";
import { providerAuthDirs } from "./auth.ts";

const fail = (code: string): never => { throw new Error(code); };

/** Earliest Devin CLI generation this build admits: the ACP v1 handshake,
 * session modes, `session/set_config_option` model selection and the
 * `auth status/login/logout` surface were verified against the 3000.10.x
 * line. Admission still binds the exact executable SHA-256 per version —
 * the floor only rejects generations too old to speak the protocol. */
export const CLI_DEVIN_MIN_VERSION = "3000.10.27";
export const CLI_DEVIN_MAX_MAJOR = 3000;

function versionTuple(version: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  if (match === null) return null;
  return Object.freeze([Number(match[1]), Number(match[2]), Number(match[3])] as const);
}

/** `devin --version` reports `devin 3000.10.31 (<sha>)`; inspection extracts
 * the semver. The matcher enforces the admitted generation window, never a
 * downgrade to an unverified major line. */
export function devinCliVersionMatches(version: string): boolean {
  const got = versionTuple(version), min = versionTuple(CLI_DEVIN_MIN_VERSION);
  if (got === null || min === null || got[0] !== CLI_DEVIN_MAX_MAJOR) return false;
  for (let index = 0; index < 3; index += 1) {
    if (got[index] !== min[index]) return got[index]! > min[index]!;
  }
  return true;
}

/** The adapter's stable runtime identity for one inspected binary. Mirrors
 * `claudeTaskRuntimeIdentity`: qualification records bind this digest. */
export function cliDevinRuntimeIdentity(input: Readonly<{ executableSha256: string; cliVersion: string }>): Readonly<{ version: string; digest: string }> {
  const version = `devin-acp/${DEVIN_ACP_PROTOCOL_VERSION};devin-cli/${input.cliVersion};task`;
  return Object.freeze({ version, digest: createHash("sha256")
    .update(JSON.stringify({ runtimeVersion: version, executableSha256: input.executableSha256, authentication: "subscription" }))
    .digest("hex") });
}

/** Closed environment for the managed Devin home: credentials, session state
 * and caches resolve inside `home` only — the user's real
 * `~/.local/share/devin` is never read or written. */
export function devinManagedEnv(home: string): Readonly<Record<string, string>> {
  return Object.freeze({
    HOME: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(home, "tmp"),
    PATH: "/usr/bin:/bin:/usr/local/bin",
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
  });
}

/** The managed env plus a guaranteed tmp root. */
async function managedAuthContext(stateRoot: string): Promise<Readonly<{ home: string; env: Readonly<Record<string, string>> }>> {
  const { home } = await providerAuthDirs(stateRoot, "devin");
  await mkdir(join(home, "tmp"), { mode: 0o700, recursive: true });
  return Object.freeze({ home, env: devinManagedEnv(home) });
}

export type DevinAuthStatus = Readonly<{ loggedIn: boolean; planType: string | null }>;

/** Bounded auth probe against the managed home: `devin auth status` exit
 * output is parsed, never trusted by exit code alone. */
export async function devinAuthStatus(stateRoot: string, inspection: CliBinaryInspection): Promise<DevinAuthStatus> {
  const { env } = await managedAuthContext(stateRoot);
  const result = spawnSync(inspection.executablePath, ["auth", "status"], {
    env: { ...env }, timeout: 20_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (typeof result.stdout !== "string") return Object.freeze({ loggedIn: false, planType: null });
  const text = boundedText(result.stdout, 16 * 1024, true);
  const loggedIn = /^Logged in\b/mu.test(text);
  const plan = /^\s*Plan:\s*(.+)$/mu.exec(text)?.[1]?.trim();
  return Object.freeze({ loggedIn, planType: loggedIn && plan !== undefined && plan !== "" ? boundedText(plan, 64) : null });
}

/** Interactive sign-in through Devin's own flow under the managed home:
 * `devin auth login` drives the browser/localhost redirect itself; SSH users
 * can re-run the same command under the managed HOME directly for the CLI's
 * `--force-manual-token-flow`. */
export async function devinLogin(stateRoot: string, inspection: CliBinaryInspection): Promise<void> {
  const { env } = await managedAuthContext(stateRoot);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(inspection.executablePath, ["auth", "login"], { stdio: "inherit", env: { ...env }, detached: false });
    child.on("error", () => resolve(1));
    child.on("exit", (status) => resolve(status ?? 1));
  });
  if (code !== 0) fail("DEVIN_LOGIN_FAILED");
}

/** Remove the managed credential via Devin's own logout. Idempotent — a
 * signed-out or absent credential still reports signed out afterwards. */
export async function devinLogout(stateRoot: string, inspection: CliBinaryInspection): Promise<void> {
  const { env } = await managedAuthContext(stateRoot);
  await new Promise<number>((resolve) => {
    const child = spawn(inspection.executablePath, ["auth", "logout"], { stdio: "inherit", env: { ...env }, detached: false });
    child.on("error", () => resolve(0));
    child.on("exit", (status) => resolve(status ?? 0));
  });
}
