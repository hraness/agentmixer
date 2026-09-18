import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CliSessionStore } from "../src/cli/sessions.ts";
import { privateDirectory } from "../src/cli/state.ts";

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "xcb-t-")));
  await chmod(base, 0o700);
  return { base, open: () => CliSessionStore.open(join(base, "sessions")) };
}

describe("cli session store", () => {
  test("creates, reads and lists sessions", async () => {
    const { open } = await fixture();
    const store = await open();
    try {
      const first = await store.create({ provider: "claude", accountId: "local", workspace: "/w", model: "m", now: 1000 });
      const second = await store.create({ provider: "claude", accountId: "local", workspace: "/w", model: "m", now: 2000 });
      expect(first.id).toMatch(/^s_[a-f0-9]{24}$/u);
      expect(store.get(first.id)?.provider).toBe("claude");
      expect(store.get("s_missing")).toBeNull();
      expect(store.list().map((s) => s.id)).toEqual([second.id, first.id]);
    } finally {
      store.close();
    }
  });

  test("records bounded transcript entries and titles", async () => {
    const { open } = await fixture();
    const store = await open();
    try {
      const session = await store.create({ provider: "claude", accountId: "local", workspace: "/w", model: "m", now: 1 });
      const updated = await store.record(session, [
        { role: "user" as const, text: "first question about files", at: 10 },
        { role: "assistant" as const, text: "answer", at: 11 },
      ], 20);
      expect(updated.title).toBe("first question about files");
      expect(updated.turns).toBe(2);
      const transcript = await store.transcript(session.id);
      expect(transcript.map((e) => e.role)).toEqual(["user", "assistant"]);
      expect(transcript[0]!.text).toBe("first question about files");
    } finally {
      store.close();
    }
  });

  test("rejects malformed transcript entries on write", async () => {
    const { open } = await fixture();
    const store = await open();
    try {
      const session = await store.create({ provider: "claude", accountId: "local", workspace: "/w", model: "m", now: 1 });
      await expect(store.record(session, [
        { role: "tool" as never, text: "x", at: 1 },
      ], 2)).rejects.toThrow("TRANSCRIPT_ENTRY_INVALID");
    } finally {
      store.close();
    }
  });

  test("remove deletes the row and transcript file, and is false when absent", async () => {
    const { open } = await fixture();
    const store = await open();
    try {
      const session = await store.create({ provider: "claude", accountId: "local", workspace: "/w", model: "m", now: 1 });
      await store.record(session, [{ role: "user" as const, text: "hello", at: 2 }], 3);
      expect(await store.transcript(session.id)).toHaveLength(1);
      expect(await store.remove(session.id)).toBe(true);
      expect(store.get(session.id)).toBeNull();
      expect(await store.transcript(session.id)).toHaveLength(0);
      expect(await store.remove(session.id)).toBe(false);
    } finally {
      store.close();
    }
  });

  test("prune removes only sessions idle before the cutoff", async () => {
    const { open } = await fixture();
    const store = await open();
    try {
      const old = await store.create({ provider: "claude", accountId: "local", workspace: "/w", model: "m", now: 1 });
      await store.record(old, [{ role: "user" as const, text: "old", at: 2 }], 2);
      const fresh = await store.create({ provider: "claude", accountId: "local", workspace: "/w", model: "m", now: 10_000 });
      await store.record(fresh, [{ role: "user" as const, text: "new", at: 10_000 }], 10_000);
      expect(await store.prune(5_000)).toBe(1);
      expect(store.get(old.id)).toBeNull();
      expect(store.get(fresh.id)?.id).toBe(fresh.id);
      expect(await store.prune(0)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("state root requires a physical private directory", async () => {
    const { base } = await fixture();
    await chmod(join(base), 0o755);
    await expect(privateDirectory(base)).rejects.toThrow("XCB_DIRECTORY_NOT_PRIVATE");
    await chmod(base, 0o700);
    await expect(privateDirectory(base)).resolves.toBe(base);
  });
});
