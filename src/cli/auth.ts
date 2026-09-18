import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { privateDirectory } from "./state.ts";
import type { CliBinaryInspection } from "./binaries.ts";

const fail = (code: string): never => { throw new Error(code); };

/** Managed, mode-0700 config/auth directories for one provider. Provider CLI
 * state lands here — never inside a model-writable workspace. */
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

const TOKEN_PATH = (stateRoot: string) => join(stateRoot, "claude-oauth-token");

/** Host-owned subscription token custody: `agentmixer auth claude` runs
 * `claude setup-token`, which mints a one-year OAuth token using an existing
 * Claude Code login or a fresh browser flow. The token is stored mode-0600 in
 * the private state root — not the shared login keychain — and reaches the
 * provider only as CLAUDE_CODE_OAUTH_TOKEN env inside its sandbox. */
async function storeToken(stateRoot: string, token: string): Promise<void> {
  await privateDirectory(stateRoot);
  const file = await open(TOKEN_PATH(stateRoot), "w", 0o600);
  try { await file.writeFile(token + "\n"); } finally { await file.close(); }
}

/** Read the stored subscription token, or null when absent/malformed. */
export async function readClaudeOAuthToken(stateRoot: string): Promise<string | null> {
  try {
    const text = await readFile(TOKEN_PATH(stateRoot), "utf8");
    if (text.length > 2048) return null;
    const token = text.trim();
    return /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{16,1024}$/u.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** Remove the stored subscription token. Idempotent. */
export async function clearClaudeOAuthToken(stateRoot: string): Promise<void> {
  await rm(TOKEN_PATH(stateRoot), { force: true });
}

/** Interactive sign-in: mint a long-lived subscription token via
 * `claude setup-token` and store it under host custody. stdout is captured so
 * the token can be extracted; it is tee'd to the console for the OAuth flow's
 * progress output, with the token line masked. */
export async function claudeLogin(stateRoot: string, inspection: CliBinaryInspection): Promise<void> {
  if (!inspection.versionMatches) fail("CLAUDE_VERSION_MISMATCH");
  const { config, home } = await providerAuthDirs(stateRoot, "claude");
  await mkdir(join(home, "tmp"), { mode: 0o700, recursive: true });
  const env = managedLoginEnv(home, config);
  const setupToken = (): Promise<{ code: number; captured: string }> => new Promise((resolve) => {
    let captured = "";
    const child = spawn(inspection.executablePath, ["setup-token"], {
      stdio: ["inherit", "pipe", "inherit"], env, detached: false,
    });
    child.stdout.on("data", (chunk: Buffer) => {
      captured += chunk.toString("utf8");
      if (captured.length > 64 * 1024) { child.kill(); return; }
      // Mask the token wherever it appears, including continuation lines that
      // consist solely of token characters from cosmetic output wrapping.
      process.stdout.write(chunk.toString("utf8")
        .replaceAll(/sk-ant-oat\S+/gu, "<token captured>")
        .replaceAll(/^[ \t]*[A-Za-z0-9_-]{40,}[ \t]*$/gmu, "<token captured>"));
    });
    child.on("error", () => resolve({ code: 1, captured }));
    child.on("exit", (status) => resolve({ code: status ?? 1, captured }));
  });
  // A fresh machine may have no Claude session for setup-token to mint from;
  // fall back to an interactive `auth login` (browser OAuth) and retry.
  let result = await setupToken();
  if (result.code !== 0) {
    const login = await new Promise<number>((resolve) => {
      const child = spawn(inspection.executablePath, ["auth", "login"], {
        stdio: "inherit", env, detached: false,
      });
      child.on("error", () => resolve(1));
      child.on("exit", (status) => resolve(status ?? 1));
    });
    if (login === 0) result = await setupToken();
  }
  const { code, captured } = result;
  // setup-token may wrap the token across lines inside its cosmetic output;
  // only continuation lines consisting solely of token characters join it.
  const text = captured.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/gu, "");
  const raw = text.match(/sk-ant-oat\d{2}-[A-Za-z0-9_-]+(?:\n[ \t]*[A-Za-z0-9_-]+[ \t]*(?=\n|$))*/u)?.[0]
    ?.replaceAll(/\s+/gu, "");
  if (code !== 0) fail("CLAUDE_LOGIN_FAILED");
  const token = raw !== undefined && /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{16,1024}$/u.test(raw) ? raw : fail("CLAUDE_LOGIN_FAILED");
  await storeToken(stateRoot, token);
}

export type ClaudeAuthStatus = Readonly<{ loggedIn: boolean; authMethod: string | null }>;

/** Bounded auth probe: a well-formed host-stored subscription token counts as
 * signed in; revocation surfaces at the next provider call. */
export async function claudeAuthStatus(stateRoot: string): Promise<ClaudeAuthStatus> {
  const token = await readClaudeOAuthToken(stateRoot);
  return Object.freeze({ loggedIn: token !== null, authMethod: token === null ? null : "subscription-token" });
}
