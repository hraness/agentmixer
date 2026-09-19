import { lstat, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { CapabilityProfileIdentity } from "../capabilities.ts";
import type { AgentTaskRoute, TaskRuntimeQualification } from "../task-runtime.ts";
import { boundedText, identifier, safeInteger } from "../validation.ts";
import { privateDirectory } from "./state.ts";
import { assertPrivateStat, openPrivateRead, writeFileOnce } from "../private-file.ts";

const MAX_QUALIFICATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RECORD_VERSION = "xcb.cli-qualification.v1";

const fail = (code: string): never => { throw new Error(code); };
const digest = (value: unknown): string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : fail("QUALIFICATION_DIGEST_INVALID");

export type CliQualificationRecord = Readonly<{
  version: typeof RECORD_VERSION;
  provider: string;
  routeId: string;
  authentication: string;
  executablePath: string;
  executableSha256: string;
  runtimeVersion: string;
  runtimeDigest: string;
  profileDigest: string;
  evidenceDigest: string;
  admittedAtUnixMs: number;
  expiresAtUnixMs: number;
}>;

function recordPath(root: string, provider: string): string {
  return join(root, `qualification-${identifier(provider)}.json`);
}

function parseRecord(value: unknown): CliQualificationRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("QUALIFICATION_RECORD_INVALID");
  const raw = value as Record<string, unknown>;
  if (Reflect.ownKeys(raw).sort().join(",")
    !== "admittedAtUnixMs,authentication,evidenceDigest,executablePath,executableSha256,expiresAtUnixMs,profileDigest,provider,routeId,runtimeDigest,runtimeVersion,version") {
    fail("QUALIFICATION_RECORD_INVALID");
  }
  const record: CliQualificationRecord = Object.freeze({
    version: RECORD_VERSION,
    provider: boundedText(raw.provider, 32),
    routeId: identifier(raw.routeId),
    authentication: boundedText(raw.authentication, 32),
    executablePath: boundedText(raw.executablePath, 4096),
    executableSha256: digest(raw.executableSha256),
    runtimeVersion: boundedText(raw.runtimeVersion, 160),
    runtimeDigest: digest(raw.runtimeDigest),
    profileDigest: digest(raw.profileDigest),
    evidenceDigest: digest(raw.evidenceDigest),
    admittedAtUnixMs: safeInteger(raw.admittedAtUnixMs, 0, Number.MAX_SAFE_INTEGER),
    expiresAtUnixMs: safeInteger(raw.expiresAtUnixMs, 0, Number.MAX_SAFE_INTEGER),
  });
  if (raw.version !== RECORD_VERSION || record.expiresAtUnixMs <= record.admittedAtUnixMs) fail("QUALIFICATION_RECORD_INVALID");
  return record;
}

/** Read a locally admitted qualification record. Missing, malformed or expired
 * records return null — callers keep the adapter unqualified. */
export async function readCliQualification(stateRoot: string, provider: string): Promise<CliQualificationRecord | null> {
  const root = await privateDirectory(stateRoot);
  const path = recordPath(root, provider);
  try {
    const stat = await lstat(path);
    assertPrivateStat(stat, { kind: "file", noSymlink: true, owner: "self",
      mode: [{ mask: 0o077, equals: 0 }], size: { max: 8192 } }, "QUALIFICATION_RECORD_INVALID");
    const handle = await openPrivateRead(path, { nonblock: false });
    try {
      const text = await handle.readFile("utf8");
      const record = parseRecord(JSON.parse(text));
      if (record.provider !== provider || record.expiresAtUnixMs <= Date.now()) return null;
      return record;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof Error && error.message === "QUALIFICATION_RECORD_INVALID") return null;
    throw error;
  }
}

/** Persist the host's own admission evidence. The record is mode 0600 inside the
 * private state root; the provider adapter re-verifies the effective boundary on
 * every run regardless of this file. */
export async function writeCliQualification(stateRoot: string, record: CliQualificationRecord): Promise<CliQualificationRecord> {
  const root = await privateDirectory(stateRoot);
  const parsed = parseRecord(JSON.parse(JSON.stringify(record)));
  const path = recordPath(root, parsed.provider);
  const temp = `${path}.tmp-${process.pid}`;
  await writeFileOnce(temp, JSON.stringify(parsed, null, 2) + "\n", { exclusive: false, truncate: true, syncFile: true });
  await rename(temp, path);
  return parsed;
}

/** Convert a live local record into the adapter-facing qualification. Bound to
 * the exact route, runtime identity and capability profile the adapter was
 * constructed with — drift anywhere fails the adapter's own checks. */
export function toTaskQualification(record: CliQualificationRecord, expected: Readonly<{
  route: AgentTaskRoute; profile: CapabilityProfileIdentity; runtimeVersion: string; runtimeDigest: string;
}>): TaskRuntimeQualification {
  // Legacy doctor records contain only a binary identity, not the missing
  // Devin tool-inventory and configuration-confinement evidence.
  if (record.provider === "devin" || expected.route.provider === "devin") {
    return Object.freeze({ status: "unqualified", reason: "Devin host qualification is not implemented; legacy binary-only admission is insufficient." });
  }
  if (record.provider !== expected.route.provider || record.routeId !== expected.route.id || record.authentication !== expected.route.authentication
    || record.profileDigest !== expected.profile.digest || record.runtimeVersion !== expected.runtimeVersion
    || record.runtimeDigest !== expected.runtimeDigest || record.expiresAtUnixMs <= Date.now()) {
    return Object.freeze({ status: "unqualified", reason: "Local admission record does not match this route, runtime and profile." });
  }
  return Object.freeze({
    status: "qualified",
    route: Object.freeze({ ...expected.route }),
    profile: Object.freeze({ id: expected.profile.id, version: expected.profile.version, digest: expected.profile.digest }),
    runtimeVersion: record.runtimeVersion,
    runtimeDigest: record.runtimeDigest,
    evidenceDigest: record.evidenceDigest,
    expiresAt: record.expiresAtUnixMs,
    controls: Object.freeze({
      noCommandTools: true as const, exactToolInventory: true as const, workspaceReadIsolation: true as const,
      workspaceWriteIsolation: true as const, isolatedConfiguration: true as const, authOutsideWorkspace: true as const,
      hostBrokerOnly: true as const,
    }),
  });
}

/** Build the record a doctor run persists. Evidence binds the inspected binary,
 * runtime identity, profile and admission time; it never attests beyond the
 * controls the runtime itself enforces. */
export function buildQualificationRecord(input: {
  provider: string; route: AgentTaskRoute; executablePath: string; executableSha256: string;
  runtimeVersion: string; runtimeDigest: string; profileDigest: string; now: number; evidenceDigest?: string;
}): CliQualificationRecord {
  const admittedAtUnixMs = safeInteger(input.now, 0, Number.MAX_SAFE_INTEGER);
  const record: CliQualificationRecord = Object.freeze({
    version: RECORD_VERSION,
    provider: boundedText(input.provider, 32),
    routeId: identifier(input.route.id),
    authentication: boundedText(input.route.authentication, 32),
    executablePath: boundedText(input.executablePath, 4096),
    executableSha256: digest(input.executableSha256),
    runtimeVersion: boundedText(input.runtimeVersion, 160),
    runtimeDigest: digest(input.runtimeDigest),
    profileDigest: digest(input.profileDigest),
    evidenceDigest: "",
    admittedAtUnixMs,
    expiresAtUnixMs: admittedAtUnixMs + MAX_QUALIFICATION_AGE_MS,
  });
  const evidenceDigest = input.evidenceDigest === undefined
    ? createHash("sha256").update(JSON.stringify({ ...record, evidenceDigest: "" })).digest("hex")
    : digest(input.evidenceDigest);
  return Object.freeze({ ...record, evidenceDigest });
}
