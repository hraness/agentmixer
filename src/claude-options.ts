import type { Options } from "@anthropic-ai/claude-agent-sdk";

const BUILT_INS = ["Agent", "Task", "Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "Skill", "ToolSearch", "LSP", "Computer", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
  "TodoWrite", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "CronCreate", "CronDelete", "CronList"];

type HostInputs = Pick<Options, "abortController" | "cwd" | "env" | "model" | "maxTurns" | "maxBudgetUsd"
  | "pathToClaudeCodeExecutable" | "spawnClaudeCodeProcess" | "mcpServers"> & { brokerToolNames: readonly string[]; systemPrompt?: string };

const DEFAULT_SYSTEM_PROMPT = "You are a contact-scoped assistant. Use only the provided broker tools. File paths are relative to this contact's folder. Messaging tools stage intentions; the host applies disclosure and decides delivery. Return the requested JSON only.";

/** Shared with the explicit native qualification harness; never accepts model configuration. */
export function restrictedClaudeOptions({ brokerToolNames, systemPrompt, ...host }: HostInputs): Options {
  return {
    ...host, tools: [], disallowedTools: [...BUILT_INS], allowedTools: [...brokerToolNames],
    permissionMode: "dontAsk", permissionPrompts: "none", settingSources: [], strictMcpConfig: true,
    agents: {}, skills: [], plugins: [], persistSession: false, enableFileCheckpointing: false,
    settings: JSON.stringify({ disableAllHooks: true, disableClaudeAiConnectors: true, autoMemoryEnabled: false,
      disableBundledSkills: true, disableSkillShellExecution: true, enableWorkflows: false, workflowKeywordTriggerEnabled: false, skillOverrides: { doctor: "off", checkup: "off" } }),
    systemPrompt: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    stderr: () => {},
  };
}

/** Keep task text out of the native CLI's slash/bang command parser. */
export function literalClaudePrompt(prompt: string): string {
  return `xcb task, supplied as plain text:\n\n${prompt}`;
}
