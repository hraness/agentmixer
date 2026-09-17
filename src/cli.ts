#!/usr/bin/env node
import { resolve } from "node:path";
import { join } from "node:path";

import { openAccountDatabase } from "./sqlite-port.ts";
import { SqliteAccountLeases } from "./accounts.ts";
import { createPublicWeb } from "./public-web.ts";
import { boundedText } from "./validation.ts";

import { ensureCliState } from "./cli/state.ts";
import { inspectCliBinary, CLI_CODEX_ENV, CLI_CLAUDE_ENV, type CliProviderName } from "./cli/binaries.ts";
import { claudeLogin, claudeAuthStatus, clearClaudeOAuthToken } from "./cli/auth.ts";
import { seatbeltAvailable } from "./cli/sandbox.ts";
import type { ClaudeTaskEvents } from "./claude-task-adapter.ts";
import { admitCliProvider, openCliProvider, CLI_CLAUDE_DEFAULT_MODEL, CLI_CODEX_DEFAULT_MODEL } from "./cli/provider.ts";
import { CliSessionStore } from "./cli/sessions.ts";
import { createCliWorkspace, createCliWorkspaceProfile } from "./cli/workspace.ts";
import { runCliTurn } from "./cli/run.ts";
import { runCliChat } from "./cli/chat.ts";
import { dim, green, red, yellow, printRemainingText } from "./cli/tui.ts";

const VERSION = "0.3.0";

const USAGE = `agentmixer — unified interface to your coding-agent subscriptions

Usage:
  agentmixer [path]            open the chat in a workspace (default: .)
  agentmixer auth claude       sign in with your Claude subscription
  agentmixer auth status       show stored sign-in state
  agentmixer auth logout       remove the stored credential
  agentmixer doctor            inspect provider binaries and admit this runtime
  agentmixer sessions          list local sessions
  agentmixer resume [id]       continue a session (default: most recent)
  agentmixer run [-p text]     run one task headlessly (or pipe the task on stdin)
  agentmixer --version

Options:
  --provider <claude|codex>    pick the provider for run/chat/resume (default claude)
  --model <id>                 model for this run or session
  --cwd <path>                 workspace for run (default: current directory)

Environment:
  ${CLI_CLAUDE_ENV}    pin an exact claude executable path
  ${CLI_CODEX_ENV}     pin an exact codex executable path
  AGENTMIXER_STATE     override the state root (default ~/.agentmixer)
`;

function parseFlags(args: readonly string[]): { provider: CliProviderName; model: string | undefined; positional: string[]; prompt: string | undefined; cwd: string | undefined } {
  const positional: string[] = [];
  let provider: CliProviderName = "claude", model: string | undefined, prompt: string | undefined, cwd: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--provider" || arg === "--model" || arg === "-p" || arg === "--cwd") {
      const value = args[++i];
      if (value === undefined) fail(`option ${arg} requires a value`);
      if (arg === "--provider") {
        if (value !== "claude" && value !== "codex") fail(`unknown provider ${value} — supported: claude, codex`);
        provider = value as CliProviderName;
      } else if (arg === "--model") model = boundedText(value, 160);
      else if (arg === "--cwd") cwd = value;
      else prompt = boundedText(value, 512 * 1024);
      continue;
    }
    if (arg.startsWith("--")) fail(`unknown option ${arg}`);
    positional.push(arg);
  }
  return { provider, model, positional, prompt, cwd };
}

const fail = (message: string): never => {
  process.stderr.write(`${red("agentmixer:")} ${message}\n`);
  process.exit(2);
};

async function cliProfileFor(workspace: string) {
  const resolved = resolve(workspace);
  let actual: string;
  try {
    actual = await import("node:fs/promises").then((fs) => fs.realpath(resolved));
  } catch {
    fail(`workspace path does not exist: ${resolved}`);
  }
  const ws = createCliWorkspace(actual!);
  const web = createPublicWeb();
  const profile = createCliWorkspaceProfile(ws, { fetch: (url, signal) => web.fetchPublic(url, 256 * 1024, signal).then((r) => ({ text: r.text })) });
  return { profile, workspace: ws };
}

async function commandDoctor(stateRoot: string): Promise<number> {
  const { profile } = await cliProfileFor(process.cwd());
  let admitted = 0;
  for (const provider of ["claude", "codex"] as const) {
    const admission = await admitCliProvider(stateRoot, provider, profile);
    if (admission.inspection === null) {
      process.stdout.write(`${dim("○")} ${provider}: not found (checked ${dim("$" + (provider === "claude" ? CLI_CLAUDE_ENV : CLI_CODEX_ENV))}, PATH, known locations)\n`);
      continue;
    }
    const detail = admission.record !== null ? green(admission.detail) : yellow(admission.detail);
    process.stdout.write(`${admission.record !== null ? green("✓") : yellow("!")} ${provider}: ${admission.inspection.version} ${dim(admission.inspection.sha256.slice(0, 16) + "…")} — ${detail}\n`);
    if (admission.record !== null) admitted += 1;
  }
  if (process.platform === "darwin") {
    const seatbelt = await seatbeltAvailable();
    process.stdout.write(`${seatbelt ? green("✓") : yellow("!")} sandbox: seatbelt ${seatbelt ? "available" : "unavailable"} ${dim("(claude runs confined; availability is not attestation)")}\n`);
  }
  // Doctor succeeds when at least one provider is admitted; an absent optional
  // provider is a diagnostic line, not a failure.
  return admitted > 0 ? 0 : 1;
}

async function commandAuth(provider: string, stateRoot: string): Promise<number> {
  if (provider === "codex") return fail("codex managed sign-in is not yet available in the CLI — see `agentmixer doctor`.");
  if (provider !== "claude") return fail(`unknown provider ${provider} — supported: claude`);
  const inspection = await inspectCliBinary("claude");
  if (inspection === null) return fail("claude binary not found — install Claude Code, then retry.");
  if (!inspection.versionMatches) return fail(`claude ${inspection.version} found; this build admits only the pinned version — run \`agentmixer doctor\`.`);
  process.stdout.write(`${dim("Opening Claude sign-in (credentials are stored under ~/.agentmixer only)…")}\n`);
  await claudeLogin(stateRoot, inspection);
  const status = await claudeAuthStatus(stateRoot);
  if (!status.loggedIn) return fail("sign-in did not produce credentials — re-run `agentmixer auth claude`.");
  process.stdout.write(`${green("✓")} signed in (${status.authMethod ?? "claude.ai"})\n`);
  return 0;
}

async function commandAuthStatus(stateRoot: string): Promise<number> {
  const status = await claudeAuthStatus(stateRoot);
  if (!status.loggedIn) {
    process.stdout.write(`claude: signed out\n`);
    return 1;
  }
  process.stdout.write(`claude: signed in (${status.authMethod ?? "claude.ai"})\n`);
  return 0;
}

async function commandAuthLogout(stateRoot: string): Promise<number> {
  await clearClaudeOAuthToken(stateRoot);
  process.stdout.write(`claude: signed out\n`);
  return 0;
}

async function latestSessionId(stateRoot: string): Promise<string | undefined> {
  const sessions = await CliSessionStore.open(join(stateRoot, "sessions"));
  try {
    return sessions.list(1)[0]?.id;
  } finally {
    sessions.close();
  }
}

async function commandSessions(stateRoot: string): Promise<number> {
  const sessions = await CliSessionStore.open(join(stateRoot, "sessions"));
  try {
    for (const session of sessions.list(64)) {
      process.stdout.write(`${session.id}  ${dim(session.provider)}  ${dim(session.model)}  ${session.title || "(untitled)"}  ${dim(new Date(session.lastActiveAt).toISOString())}\n`);
    }
  } finally {
    sessions.close();
  }
  return 0;
}

async function commandRun(prompt: string, workspace: string, stateRoot: string, provider: CliProviderName, model: string | undefined): Promise<number> {
  const { profile } = await cliProfileFor(workspace);
  const events: ClaudeTaskEvents = {};
  const opened = await openCliProvider(stateRoot, provider, profile, events);
  if (opened.status !== "ready") return fail(`provider not admitted — run \`agentmixer doctor\`${provider === "claude" ? " and `agentmixer auth claude`" : ""} first.`);
  if (provider === "claude") {
    const auth = await claudeAuthStatus(stateRoot);
    if (!auth.loggedIn) return fail("not signed in — run `agentmixer auth claude` first.");
  }
  const leases = new SqliteAccountLeases(await openAccountDatabase(join(stateRoot, "account-leases.sqlite")));
  const sessions = await CliSessionStore.open(join(stateRoot, "sessions"));
  const runModel = model ?? (provider === "claude" ? CLI_CLAUDE_DEFAULT_MODEL : CLI_CODEX_DEFAULT_MODEL);
  let streamedAll = "", streamedLast = "", providerError: string | null = null;
  events.onAssistantText = (block) => {
    if (!process.stdout.isTTY) return;
    streamedAll += (streamedAll === "" ? "" : "\n") + block;
    streamedLast = block;
    process.stdout.write(`${block}\n`);
  };
  events.onProviderError = (text) => { providerError = text; };
  try {
    const session = await sessions.create({ provider, accountId: "local", workspace: resolve(workspace), model: runModel, now: Date.now() });
    const { result, output } = await runCliTurn({
      adapter: opened.adapter, leases, profile, accountId: "local", workspaceId: session.id,
      model: runModel, prompt, prior: [], signal: AbortSignal.timeout(10 * 60 * 1000),
      onTool: (name) => process.stderr.write(dim(`  ⚙ ${name}\n`)),
    });
    printRemainingText(output, streamedAll, streamedLast);
    if (result.outcome.status !== "completed") {
      process.stderr.write(`${red("agentmixer:")} ${result.outcome.code ?? "run failed"}${providerError === null ? "" : ` — ${providerError}`}\n`);
      return 1;
    }
    await sessions.record(session, [
      { role: "user" as const, text: prompt, at: Date.now() },
      ...(output === null ? [] : [{ role: "assistant" as const, text: output, at: Date.now() }]),
    ], Date.now());
    return 0;
  } finally {
    sessions.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (typeof Bun === "undefined" && (Number(process.versions.node?.split(".")[0]) || 0) < 24) {
    return fail("requires node ≥ 24 or bun ≥ 1.3.14");
  }
  const { path: stateRoot } = await ensureCliState();
  if (command === "doctor") return await commandDoctor(stateRoot);
  if (command === "auth") {
    const sub = rest[0];
    if (sub === undefined || sub === "status") return await commandAuthStatus(stateRoot);
    if (sub === "logout") return await commandAuthLogout(stateRoot);
    if (rest.length > 1) return fail("usage: agentmixer auth <claude|status|logout>");
    return await commandAuth(sub, stateRoot);
  }
  if (command === "sessions") return await commandSessions(stateRoot);
  if (command === "run") {
    const flags = parseFlags(rest);
    let prompt = flags.prompt ?? (flags.positional.length ? flags.positional.join(" ") : undefined);
    if (prompt === undefined || prompt.trim() === "") {
      if (process.stdin.isTTY) fail("usage: agentmixer run -p <task>  (or pipe the task on stdin)");
      prompt = await readStdin();
    }
    return await commandRun(boundedText(prompt, 512 * 1024), flags.cwd ?? process.cwd(), stateRoot, flags.provider, flags.model);
  }
  if (command === "resume") {
    const flags = parseFlags(rest);
    if (flags.positional.length > 1) return fail("usage: agentmixer resume [session-id]");
    const id = flags.positional[0] ?? await latestSessionId(stateRoot);
    if (id === undefined) return fail("no sessions yet — start one with `agentmixer`");
    return await runCliChat({ workspace: process.cwd(), sessionId: id, provider: flags.provider, ...(flags.model === undefined ? {} : { model: flags.model }) });
  }
  // Default surface is the chat: `agentmixer`, `agentmixer chat [path]`,
  // `agentmixer <path>` or flags first like `agentmixer --provider claude`.
  const chatArgv = command === "chat" ? rest : argv;
  const flags = parseFlags(chatArgv);
  if (flags.prompt !== undefined) return fail("-p is only valid with `agentmixer run`");
  const workspace = flags.positional[0] ?? ".";
  if (flags.positional.length > 1) return fail("usage: agentmixer [path]");
  return await runCliChat({ workspace, provider: flags.provider, ...(flags.model === undefined ? {} : { model: flags.model }) });
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
  process.stderr.write(`${red("agentmixer:")} ${error instanceof Error ? error.message : "unexpected failure"}\n`);
  process.exit(1);
});
