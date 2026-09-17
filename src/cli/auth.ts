import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { privateDirectory } from "./state.ts";
import type { CliBinaryInspection } from "./binaries.ts";

const fail = (code: string): never => { throw new Error(code); };

/** Managed, mode-0700 config/auth directories for one provider. Credentials the
 * provider CLI writes land here — never inside a model-writable workspace. */
export async function providerAuthDirs(stateRoot: string, provider: string): Promise<{ config: string; home: string }> {
  const root = await privateDirectory(stateRoot);
  for (const name of [`${provider}-auth`, `${provider}-home`]) {
    await mkdir(join(root, name), { mode: 0o700, recursive: true });
  }
  return { config: await privateDirectory(join(root, `${provider}-auth`)), home: await privateDirectory(join(root, `${provider}-home`)) };
}

function managedLoginEnv(home: string, config: string): NodeJS.ProcessEnv {
  return {
    HOME: home, CLAUDE_CONFIG_DIR: config, TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin:/usr/local/bin",
    LANG: "en_US.UTF-8", NO_COLOR: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** Interactive `claude auth login` against the managed config directory. The
 * user's browser/OAuth flow is untouched; only the credential destination is
 * redirected into the private state root. */
export async function claudeLogin(stateRoot: string, inspection: CliBinaryInspection): Promise<void> {
  if (!inspection.versionMatches) fail("CLAUDE_VERSION_MISMATCH");
  const { config, home } = await providerAuthDirs(stateRoot, "claude");
  await mkdir(join(home, "tmp"), { mode: 0o700, recursive: true });
  const code = await new Promise<number>((resolve) => {
    const child = spawn(inspection.executablePath, ["auth", "login"], {
      stdio: "inherit", env: managedLoginEnv(home, config), detached: false,
    });
    child.on("error", () => resolve(1));
    child.on("exit", (status) => resolve(status ?? 1));
  });
  if (code !== 0) fail("CLAUDE_LOGIN_FAILED");
}

export type ClaudeAuthStatus = Readonly<{ loggedIn: boolean; authMethod: string | null }>;

/** Bounded, non-interactive auth probe against the managed config directory. */
export async function claudeAuthStatus(stateRoot: string, inspection: CliBinaryInspection): Promise<ClaudeAuthStatus> {
  const { config, home } = await providerAuthDirs(stateRoot, "claude");
  const result = spawnSync(inspection.executablePath, ["auth", "status"], {
    timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: managedLoginEnv(home, config),
  });
  if (result.status !== 0 || typeof result.stdout !== "string" || result.stdout.length > 16 * 1024) {
    return Object.freeze({ loggedIn: false, authMethod: null });
  }
  try {
    const raw: unknown = JSON.parse(result.stdout);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("CLAUDE_STATUS_INVALID");
    const record = raw as Record<string, unknown>;
    return Object.freeze({
      loggedIn: record.loggedIn === true,
      authMethod: typeof record.authMethod === "string" ? record.authMethod : null,
    });
  } catch {
    return Object.freeze({ loggedIn: false, authMethod: null });
  }
}
