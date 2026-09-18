import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import type { SqliteDatabase } from "../sqlite-port.ts";
import { openAccountDatabase } from "../sqlite-port.ts";
import { boundedText, identifier, safeInteger } from "../validation.ts";
import { privateDirectory } from "./state.ts";

export type CliProvider = "codex" | "claude" | "devin";
export type CliSession = Readonly<{
  id: string;
  provider: CliProvider;
  accountId: string | null;
  workspace: string;
  model: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  turns: number;
}>;

export type CliTranscriptEntry = Readonly<{
  role: "user" | "assistant" | "system";
  text: string;
  at: number;
}>;

const MAX_TITLE_BYTES = 200;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 512;
const MAX_ENTRY_BYTES = 256 * 1024;
const TABLE = "xcb_cli_sessions";
const LEGACY_TABLE = "agentmixer_cli_sessions";

const fail = (code: string): never => { throw new Error(code); };
const provider = (value: unknown): CliProvider => (value === "codex" || value === "claude" || value === "devin" ? value : fail("SESSION_PROVIDER_INVALID"));

type SessionRow = Readonly<{ id: string; provider: string; account_id: string | null; workspace: string; model: string; title: string; created_at: number; last_active_at: number; turns: number }>;

function sessionFrom(row: SessionRow): CliSession {
  return Object.freeze({
    id: identifier(row.id), provider: provider(row.provider),
    accountId: row.account_id === null ? null : identifier(row.account_id),
    workspace: boundedText(row.workspace, 4096), model: boundedText(row.model, 160),
    title: boundedText(row.title, MAX_TITLE_BYTES, true),
    createdAt: safeInteger(row.created_at, 0, Number.MAX_SAFE_INTEGER),
    lastActiveAt: safeInteger(row.last_active_at, 0, Number.MAX_SAFE_INTEGER),
    turns: safeInteger(row.turns, 0, Number.MAX_SAFE_INTEGER),
  });
}

function entry(value: unknown): CliTranscriptEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("TRANSCRIPT_ENTRY_INVALID");
  const raw = value as Record<string, unknown>;
  if (Reflect.ownKeys(raw).sort().join(",") !== "at,role,text") fail("TRANSCRIPT_ENTRY_INVALID");
  const role = raw.role === "user" || raw.role === "assistant" || raw.role === "system" ? raw.role : fail("TRANSCRIPT_ENTRY_INVALID");
  return Object.freeze({ role, text: boundedText(raw.text, MAX_ENTRY_BYTES), at: safeInteger(raw.at, 0, Number.MAX_SAFE_INTEGER) });
}

/** Local session registry and transcripts. Sessions persist provider identity,
 * workspace and title; the JSONL transcript is the CLI's own record, not a
 * provider-resumable thread. No cloud or sync surface exists here. */
export class CliSessionStore {
  private constructor(
    private readonly database: SqliteDatabase,
    private readonly directory: string,
  ) {
    const tables = new Set(database.query<Readonly<{ name: string }>, []>(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all().map((row) => row.name));
    if (tables.has(LEGACY_TABLE) && !tables.has(TABLE)) {
      database.exec(`ALTER TABLE ${LEGACY_TABLE} RENAME TO ${TABLE}`);
    }
    database.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, account_id TEXT,
      workspace TEXT NOT NULL, model TEXT NOT NULL, title TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, turns INTEGER NOT NULL
    )`);
  }

  static async open(directory: string): Promise<CliSessionStore> {
    await mkdir(directory, { mode: 0o700, recursive: true });
    const root = await privateDirectory(directory);
    const transcripts = join(root, "transcripts");
    await mkdir(transcripts, { mode: 0o700, recursive: true });
    const database = await openAccountDatabase(join(root, "sessions.sqlite"));
    return new CliSessionStore(database, await privateDirectory(transcripts));
  }

  transcriptPath(id: string): string {
    return join(this.directory, `${identifier(id)}.jsonl`);
  }

  async create(input: { provider: CliProvider; accountId: string | null; workspace: string; model: string; now: number }): Promise<CliSession> {
    const id = `s_${randomBytes(12).toString("hex")}`;
    const workspace = boundedText(input.workspace, 4096);
    const count = this.database.query<Readonly<{ n: number }>, []>("SELECT COUNT(*) AS n FROM xcb_cli_sessions").get();
    if ((count?.n ?? 0) >= MAX_SESSIONS) fail("SESSION_LIMIT");
    const row = this.database.query<SessionRow, [string, string, string | null, string, string, number]>(
      `INSERT INTO xcb_cli_sessions (id, provider, account_id, workspace, model, title, created_at, last_active_at, turns)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, 0) RETURNING *`,
    ).get(id, provider(input.provider), input.accountId === null ? null : identifier(input.accountId),
      workspace, boundedText(input.model, 160), safeInteger(input.now, 0, Number.MAX_SAFE_INTEGER), safeInteger(input.now, 0, Number.MAX_SAFE_INTEGER));
    return row === null ? fail("SESSION_CREATE_FAILED") : sessionFrom(row);
  }

  get(id: string): CliSession | null {
    const row = this.database.query<SessionRow, [string]>("SELECT * FROM xcb_cli_sessions WHERE id=?").get(identifier(id));
    return row === null ? null : sessionFrom(row);
  }

  list(limit = 64): readonly CliSession[] {
    const rows = this.database.query<SessionRow, [number]>(
      "SELECT * FROM xcb_cli_sessions ORDER BY last_active_at DESC LIMIT ?",
    ).all(safeInteger(limit, 1, MAX_SESSIONS));
    return Object.freeze(rows.map(sessionFrom));
  }

  async record(session: CliSession, entries: readonly CliTranscriptEntry[], now: number): Promise<CliSession> {
    const current = this.get(session.id) ?? fail("SESSION_MISSING");
    for (const item of entries) entry(item);
    const path = this.transcriptPath(session.id);
    const line = entries.map((item) => `${JSON.stringify(entry(item))}\n`).join("");
    await appendFile(path, line, { mode: 0o600 });
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) fail("TRANSCRIPT_LIMIT");
    const firstUser = entries.find((item) => item.role === "user");
    const title = current.title === "" && firstUser !== undefined
      ? boundedText(firstUser.text.split("\n")[0]!.slice(0, 80), MAX_TITLE_BYTES, true)
      : current.title;
    const row = this.database.query<SessionRow, [string, number, number, string]>(
      `UPDATE xcb_cli_sessions SET title=?, last_active_at=?, turns=turns+? WHERE id=? RETURNING *`,
    ).get(title, safeInteger(now, 0, Number.MAX_SAFE_INTEGER), entries.length, current.id);
    return row === null ? current : sessionFrom(row);
  }

  /** Remove one session row and its transcript file. Returns false when absent. */
  async remove(id: string): Promise<boolean> {
    const session = this.get(id);
    if (session === null) return false;
    this.database.query<unknown, [string]>("DELETE FROM xcb_cli_sessions WHERE id=?").run(session.id);
    await rm(this.transcriptPath(session.id), { force: true });
    return true;
  }

  /** Remove every session idle since before `beforeMs`; returns the count. */
  async prune(beforeMs: number): Promise<number> {
    const rows = this.database.query<Readonly<{ id: string }>, [number]>(
      "SELECT id FROM xcb_cli_sessions WHERE last_active_at < ?",
    ).all(safeInteger(beforeMs, 0, Number.MAX_SAFE_INTEGER));
    let removed = 0;
    for (const row of rows) {
      if (await this.remove(row.id)) removed += 1;
    }
    return removed;
  }

  async transcript(id: string, limitBytes = MAX_TRANSCRIPT_BYTES): Promise<readonly CliTranscriptEntry[]> {
    const path = this.transcriptPath(id);
    let text: string;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limitBytes) fail("TRANSCRIPT_LIMIT");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
      throw error;
    }
    const lines = text.split("\n").filter((lineText) => lineText !== "");
    if (lines.length > 4096) fail("TRANSCRIPT_LIMIT");
    return Object.freeze(lines.map((lineText) => entry(JSON.parse(lineText))));
  }

  close(): void {
    this.database.close();
  }
}
