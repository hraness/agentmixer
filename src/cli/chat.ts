import { isAbsolute, resolve } from "node:path";
import { mkdir, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";

import { openAccountDatabase } from "../sqlite-port.ts";
import { SqliteAccountLeases } from "../accounts.ts";
import { createPublicWeb } from "../public-web.ts";
import { boundedText } from "../validation.ts";

import { assertWorkspaceStateSeparation, ensureCliState } from "./state.ts";
import { CliSessionStore, type CliSession, type CliTranscriptEntry } from "./sessions.ts";
import { createCliWorkspace, createCliWorkspaceProfile } from "./workspace.ts";
import { openCliProvider, CLI_CLAUDE_DEFAULT_MODEL, CLI_CODEX_DEFAULT_MODEL, CLI_DEVIN_DEFAULT_MODEL } from "./provider.ts";
import type { ClaudeTaskEvents } from "../claude-task-adapter.ts";
import { inspectCliBinary, type CliProviderName } from "./binaries.ts";
import { runCliTurn } from "./run.ts";
import { LineEditor, bold, cyan, dim, green, red, startSpinner, printTool, printRemainingText, yellow } from "./tui.ts";
import { claudeAuthStatus } from "./auth.ts";
import { codexAuthStatus } from "./codex.ts";
import { devinAuthStatus } from "./devin.ts";

const ACCOUNT_ID = "local";

async function resolveWorkspace(raw: string): Promise<string> {
  const path = isAbsolute(raw) ? raw : resolve(raw);
  try {
    const actual = await realpath(path);
    const stat = await lstat(actual);
    if (!stat.isDirectory()) throw new Error("WORKSPACE_INVALID");
    return actual;
  } catch (error) {
    if (error instanceof Error && error.message === "WORKSPACE_INVALID") throw new Error(`not a directory: ${path}`);
    throw new Error(`workspace path does not exist: ${path}`);
  }
}

const HELP = `Commands:
  /help       show this help
  /new        start a new session
  /sessions   list local sessions
  /model <id> switch model (current session only)
  /quit       exit

Anything else is sent to the provider as a task. Ctrl-C cancels a running turn;
Ctrl-D exits. Files stay inside the opened directory; the provider can only
list, read, search and write through the brokered workspace tools.`;

function describe(state: Awaited<ReturnType<typeof openCliProvider>>, provider: CliProviderName): string {
  if (state.status === "ready") return "";
  if (state.status === "binary-missing") return `${provider} binary not found — install the provider CLI and run \`xcb doctor\`.`;
  if (state.status === "version-mismatch") return `${provider} ${state.inspection?.version} found but this build requires the pinned version — run \`xcb doctor\`.`;
  if (state.status === "sandbox-unavailable") return "linux confinement unavailable — needs bubblewrap (`bwrap`) plus unprivileged user namespaces (Ubuntu 23.10+: `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`). Refusing to run unsandboxed.";
  return `provider not admitted — run \`xcb doctor\`, then \`xcb auth ${provider}\` if needed.`;
}

export async function runCliChat(options: { workspace: string; sessionId?: string; provider?: CliProviderName; model?: string }): Promise<number> {
  const { path: stateRoot } = await ensureCliState();
  const sessions = await CliSessionStore.open(join(stateRoot, "sessions"));
  // A resumed session reopens the workspace it was recorded against, not cwd.
  let workspacePath: string;
  let resumed: CliSession | null = null;
  if (options.sessionId !== undefined) {
    resumed = sessions.get(options.sessionId);
    if (resumed === null) {
      process.stderr.write(`${red("xcb:")} session not found.\n`);
      sessions.close();
      return 2;
    }
    try {
      workspacePath = await resolveWorkspace(resumed.workspace);
    } catch {
      process.stderr.write(`${red("xcb:")} session workspace is gone: ${resumed.workspace}\n`);
      sessions.close();
      return 2;
    }
  } else {
    try {
      workspacePath = await resolveWorkspace(options.workspace);
    } catch (error) {
      process.stderr.write(`${red("xcb:")} ${error instanceof Error ? error.message : "invalid workspace"}\n`);
      sessions.close();
      return 2;
    }
  }
  try { assertWorkspaceStateSeparation(workspacePath, stateRoot); }
  catch (error) { sessions.close(); throw error; }
  await mkdir(join(stateRoot, "runs"), { mode: 0o700, recursive: true });
  const leases = new SqliteAccountLeases(await openAccountDatabase(join(stateRoot, "account-leases.sqlite")));
  const web = createPublicWeb();
  const workspace = createCliWorkspace(workspacePath);
  const profile = createCliWorkspaceProfile(workspace, { fetch: (url, signal) => web.fetchPublic(url, 256 * 1024, signal).then((r) => ({ text: r.text })) });
  const providerName: CliProviderName = options.provider ?? "claude";
  const events: ClaudeTaskEvents = {};
  const opened = await openCliProvider(stateRoot, providerName, profile, events, { workspaceRoot: workspace.root });
  if (opened.status !== "ready") {
    process.stderr.write(`${red("xcb:")} ${describe(opened, providerName)}\n`);
    sessions.close();
    return 2;
  }
  if (providerName === "claude") {
    const auth = await claudeAuthStatus(stateRoot);
    if (!auth.loggedIn) {
      process.stderr.write(`${red("xcb:")} not signed in — run ${bold("xcb auth claude")} first.\n`);
      sessions.close();
      return 2;
    }
  }
  if (providerName === "codex") {
    const codexInspection = await inspectCliBinary("codex");
    if (codexInspection !== null) {
      const codex = await codexAuthStatus(stateRoot, codexInspection);
      if (!codex.loggedIn) {
        process.stderr.write(`${red("xcb:")} not signed in — run ${bold("xcb auth codex")} first.\n`);
        sessions.close();
        return 2;
      }
    }
  }
  if (providerName === "devin") {
    const devinInspection = await inspectCliBinary("devin");
    if (devinInspection !== null) {
      const devin = await devinAuthStatus(stateRoot, devinInspection);
      if (!devin.loggedIn) {
        process.stderr.write(`${red("xcb:")} not signed in — run ${bold("xcb auth devin")} first.\n`);
        sessions.close();
        return 2;
      }
    }
  }
  const model = boundedText(options.model ?? (providerName === "claude" ? CLI_CLAUDE_DEFAULT_MODEL
    : providerName === "devin" ? CLI_DEVIN_DEFAULT_MODEL : CLI_CODEX_DEFAULT_MODEL), 160);
  let session: CliSession;
  if (resumed !== null) {
    if (resumed.provider !== providerName) {
      process.stderr.write(`${red("xcb:")} session ${resumed.id} belongs to provider ${resumed.provider} — resume with \`--provider ${resumed.provider}\`.\n`);
      sessions.close();
      return 2;
    }
    session = resumed;
  } else {
    session = await sessions.create({ provider: providerName, accountId: ACCOUNT_ID, workspace: workspacePath, model, now: Date.now() });
  }
  const editor = new LineEditor();
  const turn = { controller: null as AbortController | null };
  editor.onInterrupt(() => turn.controller?.abort());
  let currentModel = session.model;
  process.stdout.write(`${bold("xcb")} ${dim("·")} ${cyan(providerName)} ${dim(currentModel)} ${dim("·")} ${workspacePath}\n`);
  process.stdout.write(dim(`session ${session.id} — /help for commands, Ctrl-D to exit\n\n`));
  try {
    for (;;) {
      const line = await editor.readLine("");
      if (line === null) break;
      const text = line.trim();
      if (text === "") continue;
      if (text.startsWith("/")) {
        const [command, ...rest] = text.slice(1).split(/\s+/u);
        if (command === "quit" || command === "exit") break;
        if (command === "help") { process.stdout.write(`${HELP}\n\n`); continue; }
        if (command === "new") {
          session = await sessions.create({ provider: providerName, accountId: ACCOUNT_ID, workspace: workspacePath, model: currentModel, now: Date.now() });
          process.stdout.write(dim(`session ${session.id}\n\n`));
          continue;
        }
        if (command === "sessions") {
          for (const item of sessions.list(20)) {
            process.stdout.write(`${item.id === session.id ? green("→") : " "} ${item.id}  ${dim(item.provider)}  ${dim(item.title || "(untitled)")}  ${dim(new Date(item.lastActiveAt).toISOString())}\n`);
          }
          process.stdout.write("\n");
          continue;
        }
        if (command === "model") {
          const next = rest.join(" ").trim();
          if (next === "") { process.stdout.write(dim(`model: ${currentModel}\n\n`)); continue; }
          currentModel = boundedText(next, 160);
          process.stdout.write(dim(`model: ${currentModel} (new sessions keep their recorded model)\n\n`));
          continue;
        }
        process.stdout.write(`${yellow("?")} unknown command /${boundedText(command ?? "", 32)} — /help\n\n`);
        continue;
      }
      const controller = new AbortController();
      turn.controller = controller;
      const spinner = startSpinner(() => `${providerName} is thinking`);
      let toolCalls = 0;
      let streamedAll = "";
      let streamedLast = "";
      let providerError: string | null = null;
      events.onAssistantText = (block) => {
        spinner.stop();
        if (!process.stdout.isTTY) return;
        streamedAll += (streamedAll === "" ? "" : "\n") + block;
        streamedLast = block;
        process.stdout.write(`${block}\n`);
      };
      events.onProviderError = (text) => { providerError = text; };
      try {
        const prior = await sessions.transcript(session.id);
        const { result, output } = await runCliTurn({
          adapter: opened.adapter, leases, profile,
          accountId: ACCOUNT_ID, workspaceId: session.id, model: currentModel,
          prompt: text, prior, signal: controller.signal,
          onTool: (name, input) => { toolCalls += 1; if (toolCalls <= 40) { spinner.stop(); printTool(name, input); } },
        });
        spinner.stop();
        const entries: CliTranscriptEntry[] = [{ role: "user" as const, text, at: Date.now() }];
        if (output !== null) entries.push({ role: "assistant" as const, text: output, at: Date.now() });
        session = await sessions.record(session, entries, Date.now());
        if (result.outcome.status !== "completed") {
          process.stdout.write(`${red("✗")} ${dim(boundedText(result.outcome.code ?? "run failed", 120))}\n`);
          if (providerError !== null) process.stdout.write(`${dim(providerError)}\n`);
          process.stdout.write("\n");
        } else {
          // Streamed blocks were already printed; emit only what the final
          // result adds beyond them.
          printRemainingText(output, streamedAll, streamedLast);
          process.stdout.write("\n");
        }
      } catch (error) {
        spinner.stop();
        const code = error instanceof Error ? boundedText(error.message, 160) : "CLI_RUN_FAILED";
        process.stdout.write(`${red("✗")} ${dim(controller.signal.aborted ? "cancelled" : code)}\n`);
        if (providerError !== null) process.stdout.write(`${dim(providerError)}\n`);
        process.stdout.write("\n");
      } finally {
        turn.controller = null;
        events.onAssistantText = undefined;
        events.onProviderError = undefined;
      }
    }
  } finally {
    editor.close();
    if (opened.status === "ready" && opened.close !== undefined) await opened.close().catch(() => {});
    sessions.close();
  }
  return 0;
}
