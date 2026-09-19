import type { ClaudeApiKeyResolver } from "./claude-sdk.ts";
import { identifier } from "./validation.ts";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { assertPrivateDirectory, assertPrivateStat, canonicalizePrivatePath, matchesPrivateStat, openPrivateRead, readFdBounded, sameFileIdentity, PRIVATE_CONTROL_REJECT } from "./private-file.ts";

/**
 * Explicit host-owned account bindings for unattended local use. Only selected
 * environment variables are read, at invocation time. No ambient provider key,
 * personal provider home, subscription token or account discovery is consulted.
 * A desktop Keychain integration can implement the same withApiKey interface.
 */
export function createEnvironmentClaudeApiKeyResolver(
  bindings: Readonly<Record<string, string>>,
  readEnvironment: (name: string) => string | undefined = (name) => process.env[name],
): ClaudeApiKeyResolver {
  const names = new Map<string, string>();
  for (const [accountId, variable] of Object.entries(bindings)) {
    identifier(accountId);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(variable)) throw new Error("CLAUDE_KEY_BINDING_INVALID");
    names.set(accountId, variable);
  }
  return Object.freeze({
    async withApiKey<T>(accountId: string, signal: AbortSignal, use: (apiKey: string) => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      const name = names.get(identifier(accountId));
      if (name === undefined) throw new Error("CLAUDE_ACCOUNT_NOT_BOUND");
      const value = readEnvironment(name);
      if (typeof value !== "string" || !/^sk-ant-api03-[A-Za-z0-9_-]{16,512}$/u.test(value)) throw new Error("CLAUDE_API_KEY_REQUIRED");
      signal.throwIfAborted();
      return use(value);
    },
  });
}

/** Explicit owner-selected files, never contact configuration or provider-home discovery. */
export function createFileClaudeApiKeyResolver(options: Readonly<{
  directory: string;
  bindings: Readonly<Record<string, string>>;
}>): ClaudeApiKeyResolver {
  const directory = canonicalizePrivatePath(options.directory, { code: "CLAUDE_KEY_DIRECTORY_INVALID", reject: PRIVATE_CONTROL_REJECT, maxLength: Infinity });
  const names = new Map<string, string>();
  for (const [accountId, name] of Object.entries(options.bindings)) {
    identifier(accountId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(name)) throw new Error("CLAUDE_KEY_BINDING_INVALID");
    names.set(accountId, name);
  }
  return Object.freeze({
    async withApiKey<T>(accountId: string, signal: AbortSignal, use: (apiKey: string) => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      const name = names.get(identifier(accountId));
      if (!name) throw new Error("CLAUDE_ACCOUNT_NOT_BOUND");
      let value: string;
      const bytes = Buffer.alloc(1025);
      try {
        const root = (await assertPrivateDirectory(directory, { code: "CLAUDE_KEY_FILE_UNAVAILABLE", owner: "self", mode: "ownerOnly", stats: "number" })).metadata;
        const path = join(directory, name);
        const handle = await openPrivateRead(path);
        try {
          const before = await handle.stat();
          assertPrivateStat(before, { kind: "file", owner: "self", links: "single", mode: [{ mask: 0o177, equals: 0 }], size: { max: 1024 } }, "CLAUDE_KEY_FILE_UNAVAILABLE");
          const read = await readFdBounded(handle, before.size, { growth: true, loop: true, into: bytes });
          const after = await handle.stat(), current = await lstat(path), currentRoot = await lstat(directory);
          if (read.bytesRead !== before.size || current.isSymbolicLink() || !sameFileIdentity(current, before, ["dev", "ino"])
            || !sameFileIdentity(currentRoot, root, ["dev", "ino", "mode", "uid"])
            || !matchesPrivateStat(after, { links: "single" }) || !sameFileIdentity(after, before, ["mode", "uid", "size", "mtime", "ctime"])) throw new Error();
          value = new TextDecoder("utf-8", { fatal: true }).decode(read.buffer.subarray(0, read.bytesRead)).replace(/\r?\n$/u, "");
          if (!/^sk-ant-api03-[A-Za-z0-9_-]{16,512}$/u.test(value)) throw new Error();
        } finally { await handle.close(); }
      } catch { throw new Error("CLAUDE_KEY_FILE_UNAVAILABLE"); }
      finally { bytes.fill(0); }
      signal.throwIfAborted();
      return use(value);
    },
  });
}
