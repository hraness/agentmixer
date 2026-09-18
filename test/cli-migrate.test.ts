import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CliSessionStore } from "../src/cli/sessions.ts";
import { legacyStateRootPath, migrateLegacyState } from "../src/cli/state.ts";
import { openAccountDatabase } from "../src/sqlite-port.ts";
import { SqliteAccountLeases } from "../src/accounts.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");

async function dir(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(path, 0o700);
  return path;
}

const envOf = (values: Record<string, string>) => (name: string) => values[name];

describe("legacy state discovery", () => {
  test("returns null when no legacy root exists", async () => {
    const missing = join(await dir("xcb-mig-none-"), "absent");
    expect(await legacyStateRootPath(envOf({ AGENTMIXER_STATE: missing }))).toBeNull();
    // The ~/.agentmixer default path is covered by the spawned-CLI test below:
    // os.homedir() is fixed at process start, so it cannot be stubbed in-process.
  });

  test("finds the root named by AGENTMIXER_STATE and validates it", async () => {
    const legacy = await dir("xcb-mig-src-");
    expect(await legacyStateRootPath(envOf({ AGENTMIXER_STATE: legacy }))).toBe(legacy);
    await expect(legacyStateRootPath(envOf({ AGENTMIXER_STATE: "relative/path" })))
      .rejects.toThrow("AGENTMIXER_STATE_INVALID");
    expect(await legacyStateRootPath(envOf({ AGENTMIXER_STATE: join(legacy, "missing") }))).toBeNull();
  });
});

describe("migrateLegacyState", () => {
  test("copies the legacy tree, preserves modes, and leaves the source intact", async () => {
    const legacy = await dir("xcb-mig-src-");
    const target = await dir("xcb-mig-dst-");
    await mkdir(join(legacy, "sessions"), { mode: 0o700 });
    await writeFile(join(legacy, "claude-oauth-token"), "token\n", { mode: 0o600 });
    await writeFile(join(legacy, "sessions", "sessions.sqlite"), "db", { mode: 0o600 });
    const migrated = await migrateLegacyState(target, envOf({ AGENTMIXER_STATE: legacy }));
    expect(migrated.source).toBe(legacy);
    expect(migrated.entries).toBe(3);
    expect(await readFile(join(target, "claude-oauth-token"), "utf8")).toBe("token\n");
    expect((await lstat(join(target, "claude-oauth-token"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(target, "sessions"))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(legacy, "claude-oauth-token"), "utf8")).toBe("token\n");
  });

  test("refuses a non-empty target and a source equal to the target", async () => {
    const legacy = await dir("xcb-mig-src-");
    const target = await dir("xcb-mig-dst-");
    await writeFile(join(target, "existing"), "x", { mode: 0o600 });
    await expect(migrateLegacyState(target, envOf({ AGENTMIXER_STATE: legacy })))
      .rejects.toThrow("XCB_STATE_TARGET_NOT_EMPTY");
    await expect(migrateLegacyState(legacy, envOf({ AGENTMIXER_STATE: legacy })))
      .rejects.toThrow("XCB_LEGACY_STATE_SAME_AS_TARGET");
  });

  test("fails absent source, symlinks, and non-private directories", async () => {
    const target = await dir("xcb-mig-dst-");
    const missing = join(await dir("xcb-mig-empty-"), "absent");
    await expect(migrateLegacyState(target, envOf({ AGENTMIXER_STATE: missing })))
      .rejects.toThrow("XCB_LEGACY_STATE_ABSENT");
    const linked = await dir("xcb-mig-src-");
    await symlink("/etc/hostname", join(linked, "link"));
    await expect(migrateLegacyState(target, envOf({ AGENTMIXER_STATE: linked })))
      .rejects.toThrow("XCB_LEGACY_ENTRY_UNSUPPORTED");
    const open = await dir("xcb-mig-src-");
    await mkdir(join(open, "world"), { mode: 0o755 });
    await expect(migrateLegacyState(target, envOf({ AGENTMIXER_STATE: open })))
      .rejects.toThrow("XCB_LEGACY_ENTRY_NOT_PRIVATE");
  });
});

describe("legacy sqlite namespaces", () => {
  test("renames agentmixer_cli_sessions on open and keeps the rows", async () => {
    const base = await dir("xcb-mig-db-");
    const database = await openAccountDatabase(join(base, "sessions.sqlite"));
    database.exec(`CREATE TABLE agentmixer_cli_sessions (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, account_id TEXT,
      workspace TEXT NOT NULL, model TEXT NOT NULL, title TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, turns INTEGER NOT NULL
    )`);
    database.exec(`INSERT INTO agentmixer_cli_sessions
      (id, provider, account_id, workspace, model, title, created_at, last_active_at, turns)
      VALUES ('s_0123456789abcdef01234567', 'claude', 'local', '/w', 'm', 'legacy', 1, 2, 3)`);
    database.close();
    const store = await CliSessionStore.open(base);
    try {
      const session = store.get("s_0123456789abcdef01234567");
      expect(session?.title).toBe("legacy");
      expect(session?.turns).toBe(3);
    } finally {
      store.close();
    }
    const check = await openAccountDatabase(join(base, "sessions.sqlite"));
    const names = check.query<Readonly<{ name: string }>, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    expect(names).toContain("xcb_cli_sessions");
    expect(names).not.toContain("agentmixer_cli_sessions");
    check.close();
  });

  test("renames agentmixer_account_leases on open and keeps held leases", async () => {
    const base = await dir("xcb-mig-db-");
    const database = await openAccountDatabase(join(base, "account-leases.sqlite"));
    database.exec(`CREATE TABLE agentmixer_account_leases (
      provider TEXT NOT NULL, account_id TEXT NOT NULL, owner TEXT,
      generation INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(provider, account_id)
    )`);
    database.exec(`INSERT INTO agentmixer_account_leases
      (provider, account_id, owner, generation, expires_at)
      VALUES ('claude', 'acct', 'owner', 4, 999)`);
    database.close();
    const leases = new SqliteAccountLeases(await openAccountDatabase(join(base, "account-leases.sqlite")));
    const held = leases.inspect("claude", "acct");
    expect(held?.owner).toBe("owner");
    expect(held?.generation).toBe(4);
  });
});

describe("xcb migrate command", () => {
  async function cliMigrate(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([process.execPath, CLI, "migrate"], {
      cwd: ROOT,
      env: {
        ...process.env, NO_COLOR: "1",
        XCB_CLAUDE: join(env.HOME ?? "/", "no-such-claude"), XCB_CODEX: join(env.HOME ?? "/", "no-such-codex"),
        PATH: join(env.HOME ?? "/", "empty-path"),
        ...env,
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  }

  test("reports absent legacy state without creating it", async () => {
    const home = await dir("xcb-mig-home-");
    const target = join(home, "state");
    const { code, stderr } = await cliMigrate({ HOME: home, XCB_STATE: target });
    expect(code).toBe(1);
    expect(stderr).toContain("XCB_LEGACY_STATE_ABSENT");
  });

  test("copies ~/.agentmixer into the canonical root end to end", async () => {
    const home = await dir("xcb-mig-home-");
    const legacy = join(home, ".agentmixer");
    await mkdir(legacy, { mode: 0o700 });
    await writeFile(join(legacy, "claude-oauth-token"), "tok\n", { mode: 0o600 });
    const target = join(home, ".xcb-target");
    const { code, stdout } = await cliMigrate({ HOME: home, XCB_STATE: target });
    expect(code).toBe(0);
    expect(stdout).toContain("migrated 1 entries");
    expect(await readFile(join(target, "claude-oauth-token"), "utf8")).toBe("tok\n");
    expect(await readFile(join(legacy, "claude-oauth-token"), "utf8")).toBe("tok\n");
  });
});
