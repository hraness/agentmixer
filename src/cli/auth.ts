import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

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

function loginOutput(write: (text: string) => void, hidden: () => boolean, hide: () => void) {
  const decoder = new StringDecoder("utf8"), prefix = "sk-ant-";
  let held = "", matched = 0, escape = 0;
  const render = (text: string) => {
    let visible = "";
    for (const character of text) {
      if (hidden()) break;
      if (escape === 1) { escape = character === "[" ? 2 : character === "]" ? 3 : 0; continue; }
      if (escape === 2) { if (character >= "@" && character <= "~") escape = 0; continue; }
      if (escape === 3) { if (character === "\x07") escape = 0; else if (character === "\x1b") escape = 4; continue; }
      if (escape === 4) { escape = character === "\\" ? 0 : character === "\x1b" ? 4 : 3; continue; }
      if (character === "\x1b") { escape = 1; continue; }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(character)) continue;
      if (matched > 0 && /\s/u.test(character)) { held += character; continue; }
      if (character === prefix[matched]) {
        held += character;
        if (++matched === prefix.length) { hide(); held = ""; visible += "<token captured>\n"; }
      } else {
        visible += held;
        held = character === prefix[0] ? character : "";
        matched = held.length;
        if (held === "") visible += character;
      }
    }
    if (visible !== "") write(visible);
  };
  return {
    push(chunk: Buffer): string { const text = decoder.write(chunk); render(text); return text; },
    end(): string {
      const text = decoder.end(); render(text);
      if (!hidden() && held !== "") write(held);
      held = "";
      return text;
    },
  };
}

/** Host-owned subscription token custody: `xcb auth claude` runs
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
  const setupToken = (args = ["setup-token"]): Promise<{ code: number; captured: string }> => new Promise((resolve) => {
    let captured = "", hidden = false, bytes = 0, oversized = false;
    const child = spawn(inspection.executablePath, args, {
      stdio: ["inherit", "pipe", "pipe"], env, detached: false, timeout: 600_000, killSignal: "SIGKILL",
    });
    const hide = () => { hidden = true; };
    const stdout = loginOutput(text => { process.stdout.write(text); }, () => hidden, hide);
    const stderr = loginOutput(text => { process.stderr.write(text); }, () => hidden, hide);
    const bounded = (chunk: Buffer): boolean => {
      bytes += chunk.byteLength;
      if (bytes <= 64 * 1024) return true;
      oversized = true; hide(); child.kill("SIGKILL"); return false;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (!bounded(chunk)) return;
      // Mask the token wherever it appears, including continuation lines that
      // consist solely of token characters from cosmetic output wrapping.
      captured += stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (bounded(chunk)) stderr.push(chunk); });
    child.on("error", () => resolve({ code: 1, captured: "" }));
    child.on("close", (status) => {
      captured += stdout.end(); stderr.end();
      resolve({ code: oversized ? 1 : status ?? 1, captured });
    });
  });
  // A fresh machine may have no Claude session for setup-token to mint from;
  // fall back to an interactive `auth login` (browser OAuth) and retry.
  let result = await setupToken();
  if (result.code !== 0) {
    const login = await setupToken(["auth", "login"]);
    if (login.code === 0) result = await setupToken();
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
