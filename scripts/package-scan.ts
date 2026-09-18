import {
  lstat,
  open,
  readdir,
  readFile,
} from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

const NON_BUN_SCRIPT_EXTENSIONS = new Set(["." + "p" + "y", "." + "p" + "yc", "." + "p" + "yo"]);
const NON_BUN_CACHE_DIRECTORY = ["__", "py", "cache__"].join("");
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const DATABASE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"]);
const MAXIMUM_PACKED_FILE_COUNT = 256;
const MAXIMUM_PACKED_FILE_BYTES = 4 * 1_024 * 1_024;
const MAXIMUM_PACKED_TOTAL_BYTES = 16 * 1_024 * 1_024;
const FORBIDDEN_PACKAGE_TEXT = [
  { label: "private package name", pattern: /@jungle\//u },
  { label: "private source-repository name", pattern: /\bJungle\b/u },
  { label: "former package identity", pattern: /agentrouter/iu },
  { label: "former monorepo identity", pattern: /message-like-me/iu },
  { label: "private source path", pattern: /(?:projects|packages)\/xcb/u },
  { label: "private repository identity", pattern: /0thernet\/jungle/iu },
  { label: "developer home path", pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//u },
  { label: "private key material", pattern: /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/u },
  { label: "GitHub token", pattern: /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/u },
  { label: "OpenAI secret", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u },
] as const;

async function startsWithSqliteHeader(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === bytes.length && bytes.toString("utf8") === "SQLite format 3\u0000";
  } finally {
    await handle.close();
  }
}

export async function scanPackedPackage(root: string): Promise<void> {
  const problems: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    const packagePath = relative(root, path).split(sep).join("/") || ".";
    if (info.isSymbolicLink()) {
      problems.push(`${packagePath} is a symlink`);
      return;
    }
    if (info.isDirectory()) {
      if (basename(path) === NON_BUN_CACHE_DIRECTORY) {
        problems.push(`${packagePath} is a legacy non-Bun script artifact directory`);
      }
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        await visit(join(path, entry.name));
      }
      return;
    }
    if (!info.isFile()) {
      problems.push(`${packagePath} is not a regular file`);
      return;
    }
    fileCount += 1;
    totalBytes += info.size;
    if (fileCount > MAXIMUM_PACKED_FILE_COUNT) {
      problems.push(`package contains more than ${String(MAXIMUM_PACKED_FILE_COUNT)} regular files`);
    }
    if (info.size > MAXIMUM_PACKED_FILE_BYTES) {
      problems.push(`${packagePath} exceeds the per-file byte bound`);
      return;
    }
    if (totalBytes > MAXIMUM_PACKED_TOTAL_BYTES) {
      problems.push(`package exceeds the ${String(MAXIMUM_PACKED_TOTAL_BYTES)}-byte total bound`);
      return;
    }
    const extension = extname(path).toLowerCase();
    if (NON_BUN_SCRIPT_EXTENSIONS.has(extension)) {
      problems.push(`${packagePath} is a legacy non-Bun script artifact`);
    }
    if (DATABASE_EXTENSIONS.has(extension) || await startsWithSqliteHeader(path)) {
      problems.push(`${packagePath} contains a database artifact`);
    }
    if (!TEXT_EXTENSIONS.has(extension) && basename(path) !== "LICENSE") {
      problems.push(`${packagePath} has an unapproved public-package file type`);
      return;
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    } catch {
      problems.push(`${packagePath} is not canonical UTF-8 text`);
      return;
    }
    for (const rule of FORBIDDEN_PACKAGE_TEXT) {
      if (rule.pattern.test(source)) problems.push(`${packagePath} contains ${rule.label}`);
    }
  }
  await visit(root);
  if (problems.length > 0) {
    throw new Error(`Packed standalone boundary failed:\n${[...new Set(problems)].sort().join("\n")}`);
  }
}
