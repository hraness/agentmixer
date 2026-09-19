#!/usr/bin/env node
import { resolve } from "node:path";
import { join } from "node:path";

import { openAccountDatabase } from "./sqlite-port.ts";
import { SqliteAccountLeases } from "./accounts.ts";
import { createPublicWeb } from "./public-web.ts";
import { boundedText } from "./validation.ts";

import { assertWorkspaceStateSeparation, ensureCliState, migrateLegacyState } from "./cli/state.ts";
import { inspectCliBinary, CLI_CODEX_ENV, CLI_CLAUDE_ENV, CLI_DEVIN_ENV, type CliProviderName } from "./cli/binaries.ts";
import { claudeLogin, claudeAuthStatus, clearClaudeOAuthToken } from "./cli/auth.ts";
import { codexAuthStatus, codexLogin, codexLogout } from "./cli/codex.ts";
import { CLI_DEVIN_MIN_VERSION, devinAuthStatus, devinLogin, devinLogout } from "./cli/devin.ts";
import { resolveJudge, resolveJudgeKey, storeJudgeKey, removeJudgeKey, hasJudgeKey,
  JUDGE_KEY_ENV, JUDGE_KEY_VENDOR_ENV, JUDGE_TOKEN_FILE, type JudgeAnswers } from "./judge.ts";
import { readCliQualification } from "./cli/qualification.ts";
import { seatbeltAvailable } from "./cli/sandbox.ts";
import type { ClaudeTaskEvents } from "./claude-task-adapter.ts";
import { admitCliProvider, openCliProvider, CLI_CLAUDE_DEFAULT_MODEL, CLI_CODEX_DEFAULT_MODEL, CLI_DEVIN_DEFAULT_MODEL } from "./cli/provider.ts";
import { CliSessionStore } from "./cli/sessions.ts";
import { createCliWorkspace, createCliWorkspaceProfile } from "./cli/workspace.ts";
import { runCliTurn } from "./cli/run.ts";
import { runCliChat } from "./cli/chat.ts";
import { dim, green, red, yellow, printRemainingText } from "./cli/tui.ts";

const VERSION = "0.4.0";

const USAGE = `xcb — unified interface to your coding-agent subscriptions

Usage:
  xcb [path]            open the chat in a workspace (default: .)
  xcb auth claude       sign in with your Claude subscription
  xcb auth codex        sign in with your ChatGPT subscription
  xcb auth devin        sign in with your Devin account
  xcb auth status       show stored sign-in state
  xcb auth logout [p]   remove the stored credential (default: claude)
  xcb doctor            inspect provider binaries and admit this runtime
  xcb sessions          list local sessions
  xcb sessions rm <id>  remove one session and its transcript
  xcb sessions prune    remove sessions idle over 30 days (or N days)
  xcb resume [id]       continue a session (default: most recent)
  xcb run [-p text]     run one task headlessly (or pipe the task on stdin)
  xcb judge [status]    show judgment-provider (jev) state
  xcb judge token       store the jev API key read from stdin (piped, never echoed)
  xcb judge logout      remove the stored jev API key
  xcb judge test        ask the judge one bounded question (live call)
  xcb migrate           copy legacy AgentMixer state into ~/.xcb (keeps the original)
  xcb --version

Options:
  --provider <claude|codex|devin|auto>  pick the provider for run/chat/resume (default claude)
  --model <id>                 model for this run or session
  --cwd <path>                 workspace for run (default: current directory)

Environment:
  ${CLI_CLAUDE_ENV}    pin an exact claude executable path
  ${CLI_CODEX_ENV}     pin an exact codex executable path
  ${CLI_DEVIN_ENV}     pin an exact devin executable path
  ${JUDGE_KEY_ENV}   jev API key (also ${JUDGE_KEY_VENDOR_ENV}); overrides the vaulted key
  XCB_STATE     override the state root (default ~/.xcb)
`;

function parseFlags(args: readonly string[]): { provider: CliProviderName | "auto"; model: string | undefined; positional: string[]; prompt: string | undefined; cwd: string | undefined } {
  const positional: string[] = [];
  let provider: CliProviderName | "auto" = "claude", model: string | undefined, prompt: string | undefined, cwd: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--provider" || arg === "--model" || arg === "-p" || arg === "--cwd") {
      const value = args[++i];
      if (value === undefined) fail(`option ${arg} requires a value`);
      if (arg === "--provider") {
        if (value !== "claude" && value !== "codex" && value !== "devin" && value !== "auto") {
          fail(`unknown provider ${value} — supported: claude, codex, devin, auto`);
        }
        provider = value as CliProviderName | "auto";
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
  process.stderr.write(`${red("xcb:")} ${message}\n`);
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

const PROVIDER_PIN_ENV: Record<CliProviderName, string> = { claude: CLI_CLAUDE_ENV, codex: CLI_CODEX_ENV, devin: CLI_DEVIN_ENV };

async function commandDoctor(stateRoot: string): Promise<number> {
  const { profile } = await cliProfileFor(process.cwd());
  let admitted = 0;
  for (const provider of ["claude", "codex", "devin"] as const) {
    const admission = await admitCliProvider(stateRoot, provider, profile);
    if (admission.inspection === null) {
      process.stdout.write(`${dim("○")} ${provider}: not found (checked ${dim("$" + PROVIDER_PIN_ENV[provider])}, PATH, known locations)\n`);
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
  const judgeKey = await resolveJudgeKey(stateRoot).catch(() => null);
  process.stdout.write(`${judgeKey === null ? dim("○") : green("✓")} judge: ${judgeKey === null
    ? `no jev key — ${dim(`--provider auto\` needs one; pipe it into \`xcb judge token\``)}`
    : `key from ${judgeKey.source} — ${dim("\`--provider auto\` can route")}`}\n`);
  // Doctor succeeds when at least one provider is admitted; an absent optional
  // provider is a diagnostic line, not a failure.
  return admitted > 0 ? 0 : 1;
}

async function commandAuth(provider: string, stateRoot: string): Promise<number> {
  if (provider === "codex") {
    const inspection = await inspectCliBinary("codex");
    if (inspection === null) return fail("codex binary not found — install Codex CLI, then retry.");
    if (!inspection.versionMatches) return fail(`codex ${inspection.version} found; this build admits only the pinned version — run \`xcb doctor\`.`);
    const status = await codexAuthStatus(stateRoot, inspection);
    if (!status.admitted) return fail("codex is not admitted — run `xcb doctor` first.");
    if (status.loggedIn) { process.stdout.write(`${green("✓")} codex: already signed in (${status.planType ?? "ChatGPT"})\n`); return 0; }
    process.stdout.write(`${dim("Starting Codex device-code sign-in…")}\n`);
    const snapshot = await codexLogin(stateRoot, inspection, (challenge) => {
      if (challenge.type === "chatgptDeviceCode") {
        process.stdout.write(`\nOpen ${challenge.verificationUrl} and enter code: ${challenge.userCode}\n\n`);
      } else {
        process.stdout.write(`\nOpen ${challenge.authUrl} to sign in.\n\n`);
      }
    });
    process.stdout.write(`${green("✓")} codex: signed in (${snapshot.planType ?? "ChatGPT"})\n`);
    return 0;
  }
  if (provider === "devin") {
    const inspection = await inspectCliBinary("devin");
    if (inspection === null) return fail("devin binary not found — install the Devin CLI, then retry.");
    if (!inspection.versionMatches) return fail(`devin ${inspection.version} found; this build requires devin >= ${CLI_DEVIN_MIN_VERSION} — run \`xcb doctor\`.`);
    const existing = await devinAuthStatus(stateRoot, inspection);
    if (existing.loggedIn) { process.stdout.write(`${green("✓")} devin: already signed in (${existing.planType ?? "Devin"})\n`); return 0; }
    process.stdout.write(`${dim("Opening Devin sign-in (credentials are stored under ~/.xcb only)…")}\n`);
    await devinLogin(stateRoot, inspection);
    const status = await devinAuthStatus(stateRoot, inspection);
    if (!status.loggedIn) return fail("sign-in did not produce credentials — re-run `xcb auth devin`.");
    process.stdout.write(`${green("✓")} devin: signed in (${status.planType ?? "Devin"})\n`);
    return 0;
  }
  if (provider !== "claude") return fail(`unknown provider ${provider} — supported: claude, codex, devin`);
  const inspection = await inspectCliBinary("claude");
  if (inspection === null) return fail("claude binary not found — install Claude Code, then retry.");
  if (!inspection.versionMatches) return fail(`claude ${inspection.version} found; this build admits only the pinned version — run \`xcb doctor\`.`);
  process.stdout.write(`${dim("Opening Claude sign-in (credentials are stored under ~/.xcb only)…")}\n`);
  await claudeLogin(stateRoot, inspection);
  const status = await claudeAuthStatus(stateRoot);
  if (!status.loggedIn) return fail("sign-in did not produce credentials — re-run `xcb auth claude`.");
  process.stdout.write(`${green("✓")} signed in (${status.authMethod ?? "claude.ai"})\n`);
  return 0;
}

async function commandAuthStatus(stateRoot: string): Promise<number> {
  let any = false;
  const claude = await claudeAuthStatus(stateRoot);
  process.stdout.write(`claude: ${claude.loggedIn ? `signed in (${claude.authMethod ?? "claude.ai"})` : "signed out"}\n`);
  if (claude.loggedIn) any = true;
  const codexInspection = await inspectCliBinary("codex");
  if (codexInspection !== null) {
    try {
      const codex = await codexAuthStatus(stateRoot, codexInspection);
      process.stdout.write(`codex: ${codex.loggedIn ? `signed in (${codex.planType ?? "ChatGPT"})` : codex.admitted ? "signed out" : "not admitted"}\n`);
      if (codex.loggedIn) any = true;
    } catch {
      process.stdout.write(`codex: error checking status\n`);
    }
  }
  const devinInspection = await inspectCliBinary("devin");
  if (devinInspection !== null) {
    try {
      const devin = await devinAuthStatus(stateRoot, devinInspection);
      process.stdout.write(`devin: ${devin.loggedIn ? `signed in (${devin.planType ?? "Devin"})` : "signed out"}\n`);
      if (devin.loggedIn) any = true;
    } catch {
      process.stdout.write(`devin: error checking status\n`);
    }
  }
  return any ? 0 : 1;
}

async function commandAuthLogout(provider: string | undefined, stateRoot: string): Promise<number> {
  if (provider === "codex") {
    const inspection = await inspectCliBinary("codex");
    if (inspection === null) return fail("codex binary not found.");
    await codexLogout(stateRoot, inspection);
    process.stdout.write(`codex: signed out\n`);
    return 0;
  }
  if (provider === "devin") {
    const inspection = await inspectCliBinary("devin");
    if (inspection === null) return fail("devin binary not found.");
    await devinLogout(stateRoot, inspection);
    process.stdout.write(`devin: signed out\n`);
    return 0;
  }
  if (provider !== undefined && provider !== "claude") return fail(`unknown provider ${provider} — supported: claude, codex, devin`);
  await clearClaudeOAuthToken(stateRoot);
  process.stdout.write(`claude: signed out\n`);
  return 0;
}

/** `xcb judge` — the judgment-provider vault and a live connectivity probe.
 * The key resolves environment-first; the file lives in the private state
 * root like every other credential. Nothing here ever prints the key. */
async function commandJudge(sub: string | undefined, stateRoot: string): Promise<number> {
  if (sub === "token") {
    if (process.stdin.isTTY) fail("usage: pipe the jev API key on stdin — e.g. `pbpaste | xcb judge token` (never a command argument).");
    const key = (await readStdin()).trim();
    if (key === "") fail("empty input — pipe the jev API key on stdin.");
    await storeJudgeKey(stateRoot, key).catch((error) => {
      if (error instanceof Error && error.message === "JUDGE_KEY_EXISTS") {
        fail("a jev key is already stored — run `xcb judge logout` first to replace it.");
      }
      if (error instanceof Error && error.message === "JUDGE_KEY_INVALID") {
        fail("that does not look like a jev API key — check the copied value.");
      }
      throw error;
    });
    process.stdout.write(`${green("✓")} judge key stored in ${join(stateRoot, JUDGE_TOKEN_FILE)} (mode 0600)\n`);
    return 0;
  }
  if (sub === "logout") {
    const removed = await removeJudgeKey(stateRoot);
    process.stdout.write(removed ? `judge key removed\n` : `no stored judge key\n`);
    return 0;
  }
  if (sub === "test") {
    const judge = await resolveJudge({ stateRoot, enabled: true });
    if (judge === null) {
      return fail(`no jev API key — pipe one into \`xcb judge token\` or set ${JUDGE_KEY_ENV}.`);
    }
    const started = Date.now();
    const answers = await judge.ask("xcb judge connectivity probe", {
      probe: { type: "noul", instructions: "Is the sky blue on a clear day?" },
      pick: { type: "choice", instructions: "Which option names a color?", criteria: { red: "a color", spoon: "not a color" } },
      rate: { type: "score", instructions: "Rate the claim that water is wet.", criteria: ["factual accuracy"] },
    });
    const probe = answers.answers.probe, pick = answers.answers.pick, rate = answers.answers.rate;
    if (probe?.type !== "noul" || pick?.type !== "choice" || rate?.type !== "score") {
      return fail("judge returned a malformed answer shape.");
    }
    process.stdout.write(`${green("✓")} judge answered in ${Date.now() - started}ms ${dim(`(model ${answers.model ?? "unknown"}, p=${probe.noul.toFixed(3)}, choice=${pick.choice}@${pick.confidence.toFixed(3)}, score=${rate.score.toFixed(3)}@${rate.confidence.toFixed(3)})`)}\n`);
    return 0;
  }
  if (sub !== undefined && sub !== "status") return fail("usage: xcb judge [status|token|logout|test]");
  const key = await resolveJudgeKey(stateRoot).catch(() => null);
  const vaulted = await hasJudgeKey(stateRoot);
  const source = key === null ? "none" : key.source === "env" ? "environment" : "vault";
  process.stdout.write(`judge: ${key === null ? "no key configured" : `key from ${source}`}${vaulted && key?.source !== "vault" ? dim(" (vault file also present)") : ""}\n`);
  process.stdout.write(`${dim("  env: ")}${JUDGE_KEY_ENV} or ${JUDGE_KEY_VENDOR_ENV}${dim("  vault: ")}${join(stateRoot, JUDGE_TOKEN_FILE)}\n`);
  process.stdout.write(`${dim("  use --provider auto on \`xcb run\` to route a task through the judge")}\n`);
  return key === null ? 1 : 0;
}

async function latestSessionId(stateRoot: string): Promise<string | undefined> {
  const sessions = await CliSessionStore.open(join(stateRoot, "sessions"));
  try {
    return sessions.list(1)[0]?.id;
  } finally {
    sessions.close();
  }
}

async function commandSessions(stateRoot: string, rest: readonly string[]): Promise<number> {
  const [sub, ...args] = rest;
  const sessions = await CliSessionStore.open(join(stateRoot, "sessions"));
  try {
    if (sub === undefined) {
      for (const session of sessions.list(64)) {
        process.stdout.write(`${session.id}  ${dim(session.provider)}  ${dim(session.model)}  ${session.title || "(untitled)"}  ${dim(new Date(session.lastActiveAt).toISOString())}\n`);
      }
      return 0;
    }
    if (sub === "rm") {
      if (args.length !== 1) return fail("usage: xcb sessions rm <id>");
      if (!await sessions.remove(args[0]!)) return fail(`session not found: ${args[0]}`);
      process.stdout.write(`removed ${args[0]}\n`);
      return 0;
    }
    if (sub === "prune") {
      if (args.length > 1) return fail("usage: xcb sessions prune [days]");
      const days = args[0] === undefined ? 30 : Number(args[0]);
      if (!Number.isInteger(days) || days < 1 || days > 3650) return fail(`invalid days: ${args[0]}`);
      const removed = await sessions.prune(Date.now() - days * 86_400_000);
      process.stdout.write(`pruned ${removed} session${removed === 1 ? "" : "s"} idle over ${days} day${days === 1 ? "" : "s"}\n`);
      return 0;
    }
    return fail(`unknown sessions subcommand ${sub} — supported: rm, prune`);
  } finally {
    sessions.close();
  }
}

/** Providers a judgment call may pick among: admitted binary, matching
 * qualification record, signed-in credentials. The judge only orders this
 * list — `openCliProvider` re-verifies the winner before anything runs. */
async function autoProviderCandidates(stateRoot: string): Promise<Readonly<{ provider: CliProviderName; label: string }>[]> {
  const candidates: { provider: CliProviderName; label: string }[] = [];
  for (const provider of ["claude", "devin", "codex"] as const) {
    const inspection = await inspectCliBinary(provider);
    if (inspection === null || !inspection.versionMatches) continue;
    const record = await readCliQualification(stateRoot, provider);
    if (record === null || record.executableSha256 !== inspection.sha256 || record.executablePath !== inspection.executablePath) continue;
    const authed = provider === "claude" ? (await claudeAuthStatus(stateRoot)).loggedIn
      : provider === "devin" ? (await devinAuthStatus(stateRoot, inspection)).loggedIn
      : (await codexAuthStatus(stateRoot, inspection)).loggedIn;
    if (authed) candidates.push({ provider, label: `${provider} ${inspection.version}` });
  }
  return candidates;
}

/** `--provider auto`: judge a `choice` over eligible providers; the flag is
 * the opt-in — one candidate skips the network call entirely. */
async function routeAutoProvider(stateRoot: string, prompt: string): Promise<CliProviderName> {
  const candidates = await autoProviderCandidates(stateRoot);
  if (candidates.length === 0) fail("no admitted, signed-in providers — run `xcb doctor` and `xcb auth <provider>` first.");
  if (candidates.length === 1) return candidates[0]!.provider;
  const judge = await resolveJudge({ stateRoot, enabled: true });
  if (judge === null) {
    return fail(`--provider auto needs a jev API key — pipe one into \`xcb judge token\` or set ${JUDGE_KEY_ENV}.`);
  }
  const criteria: Record<string, string> = {};
  candidates.forEach((candidate, index) => { criteria[`route_${index}`] = candidate.label; });
  let answers: JudgeAnswers;
  try {
    answers = await judge.ask({ task: boundedText(prompt, 32 * 1024) }, {
      route: {
        type: "choice",
        instructions: "Choose the best coding-agent provider for this task. " +
          "Consider reliability for the task's apparent complexity. Return exactly one option key.",
        criteria,
      },
    });
  } catch (error) {
    return fail(`judge routing failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const answer = answers.answers.route;
  if (answer === undefined || answer.type !== "choice" || !(answer.choice in criteria)) {
    return fail("judge routing failed: the judge returned no usable choice — pick a provider explicitly.");
  }
  const winner = candidates[Number(answer.choice.slice("route_".length))]!;
  process.stderr.write(`${dim(`judge routed to ${winner.provider} (${winner.label})`)}\n`);
  return winner.provider;
}

async function commandRun(prompt: string, workspace: string, stateRoot: string, provider: CliProviderName | "auto", model: string | undefined): Promise<number> {
  const prepared = await cliProfileFor(workspace);
  assertWorkspaceStateSeparation(prepared.workspace.root, stateRoot);
  const { profile, workspace: ws } = prepared;
  if (provider === "auto") provider = await routeAutoProvider(stateRoot, prompt);
  const events: ClaudeTaskEvents = {};
  const opened = await openCliProvider(stateRoot, provider, profile, events, { workspaceRoot: ws.root });
  if (opened.status !== "ready") return fail(`provider not admitted — run \`xcb doctor\` and \`xcb auth ${provider}\` first.`);
  if (provider === "claude") {
    const auth = await claudeAuthStatus(stateRoot);
    if (!auth.loggedIn) return fail("not signed in — run `xcb auth claude` first.");
  }
  if (provider === "codex") {
    const inspection = await inspectCliBinary("codex");
    if (inspection !== null) {
      const codex = await codexAuthStatus(stateRoot, inspection);
      if (!codex.loggedIn) return fail("not signed in — run `xcb auth codex` first.");
    }
  }
  if (provider === "devin") {
    const inspection = await inspectCliBinary("devin");
    if (inspection !== null) {
      const devin = await devinAuthStatus(stateRoot, inspection);
      if (!devin.loggedIn) return fail("not signed in — run `xcb auth devin` first.");
    }
  }
  const leases = new SqliteAccountLeases(await openAccountDatabase(join(stateRoot, "account-leases.sqlite")));
  const sessions = await CliSessionStore.open(join(stateRoot, "sessions"));
  const runModel = model ?? (provider === "claude" ? CLI_CLAUDE_DEFAULT_MODEL
    : provider === "devin" ? CLI_DEVIN_DEFAULT_MODEL : CLI_CODEX_DEFAULT_MODEL);
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
      process.stderr.write(`${red("xcb:")} ${result.outcome.code ?? "run failed"}${providerError === null ? "" : ` — ${providerError}`}\n`);
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
  if (command === "migrate") {
    if (rest.length !== 0) return fail("usage: xcb migrate");
    const migrated = await migrateLegacyState(stateRoot);
    process.stdout.write(`${green("✓")} migrated ${migrated.entries} entries from ${migrated.source}\n`);
    process.stdout.write(`${dim("the legacy directory was left untouched — remove it yourself when ready")}\n`);
    return 0;
  }
  if (command === "doctor") return await commandDoctor(stateRoot);
  if (command === "auth") {
    const sub = rest[0];
    if (sub === undefined || sub === "status") return await commandAuthStatus(stateRoot);
    if (sub === "logout") return await commandAuthLogout(rest[1], stateRoot);
    if (rest.length > 1) return fail("usage: xcb auth <claude|codex|status|logout [provider]>");
    return await commandAuth(sub, stateRoot);
  }
  if (command === "judge") {
    if (rest.length > 1) return fail("usage: xcb judge [status|token|logout|test]");
    return await commandJudge(rest[0], stateRoot);
  }
  if (command === "sessions") return await commandSessions(stateRoot, rest);
  if (command === "run") {
    const flags = parseFlags(rest);
    let prompt = flags.prompt ?? (flags.positional.length ? flags.positional.join(" ") : undefined);
    if (prompt === undefined || prompt.trim() === "") {
      if (process.stdin.isTTY) fail("usage: xcb run -p <task>  (or pipe the task on stdin)");
      prompt = await readStdin();
    }
    return await commandRun(boundedText(prompt, 512 * 1024), flags.cwd ?? process.cwd(), stateRoot, flags.provider, flags.model);
  }
  if (command === "resume") {
    const flags = parseFlags(rest);
    const provider: CliProviderName = flags.provider === "auto"
      ? fail("--provider auto routes a known task — use it with `xcb run`; a chat session binds one provider up front.")
      : flags.provider;
    if (flags.positional.length > 1) return fail("usage: xcb resume [session-id]");
    const id = flags.positional[0] ?? await latestSessionId(stateRoot);
    if (id === undefined) return fail("no sessions yet — start one with `xcb`");
    return await runCliChat({ workspace: process.cwd(), sessionId: id, provider, ...(flags.model === undefined ? {} : { model: flags.model }) });
  }
  // Default surface is the chat: `xcb`, `xcb chat [path]`,
  // `xcb <path>` or flags first like `xcb --provider claude`.
  const chatArgv = command === "chat" ? rest : argv;
  const flags = parseFlags(chatArgv);
  const provider: CliProviderName = flags.provider === "auto"
    ? fail("--provider auto routes a known task — use it with `xcb run`; a chat session binds one provider up front.")
    : flags.provider;
  if (flags.prompt !== undefined) return fail("-p is only valid with `xcb run`");
  const workspace = flags.positional[0] ?? ".";
  if (flags.positional.length > 1) return fail("usage: xcb [path]");
  return await runCliChat({ workspace, provider, ...(flags.model === undefined ? {} : { model: flags.model }) });
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
  process.stderr.write(`${red("xcb:")} ${error instanceof Error ? error.message : "unexpected failure"}\n`);
  process.exit(1);
});
