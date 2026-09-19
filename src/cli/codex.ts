import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, opendir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { SqliteAccountLeases } from "../accounts.ts";
import { createManagedCodexAccountController, type CodexAccountSnapshot, type CodexLoginChallenge } from "../codex-account.ts";
import { createCodexAccountProcess } from "../codex-account-process.ts";
import { createCodexAccountStdioTransport } from "../codex-account-transport.ts";
import { inspectCodexHostExecutable, inspectCodexHostRuntime } from "../codex-host.ts";
import { createCodexManagedProcessLauncher, runCodexManagedOfflineDiagnostic, codexManagedOfflineSandbox } from "../codex-managed-process.ts";
import { CODEX_NATIVE_SHA256, CODEX_NATIVE_VERSION } from "../codex-process.ts";
import { assertCodexProtocolManifest, buildCodexProtocolManifest, type CodexProtocolManifest } from "../codex-protocol-manifest.ts";
import { openAccountDatabase } from "../sqlite-port.ts";
import type { CliBinaryInspection } from "./binaries.ts";
import { readCliQualification } from "./qualification.ts";
import { privateDirectory } from "./state.ts";

export const CLI_CODEX_SCHEMA_SHA256 = "ffb75cdcfe84e2a417ad481e7998a924db9f9cb9b4bea065b0067acbb5886748";
export const CLI_CODEX_SCHEMA_FILES = 416;
export const CLI_CODEX_SCHEMA_BYTES = 4_137_012;
export const CLI_CODEX_BUN_DARWIN_ARM64_SHA256 = "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233";
export const CLI_CODEX_RUNTIME_VERSION = `codex-app-server:${CODEX_NATIVE_VERSION}:managed-task:v2`;

/** The managed Codex boundary is qualified against this exact parent runtime. */
export function cliCodexHostDiagnostic(): string | null {
  if (typeof Bun === "undefined" || Bun.version !== "1.3.14") {
    return "Codex managed mode requires Bun 1.3.14. Launch xcb with Bun 1.3.14, then run `xcb doctor`; Node cannot run this qualified route.";
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return "Codex managed mode requires macOS arm64; this host has no qualified Codex sandbox.";
  }
  return null;
}

function assertCliCodexHost(): void {
  if (typeof Bun === "undefined" || Bun.version !== "1.3.14") throw new Error(`CLI_CODEX_BUN_REQUIRED: ${cliCodexHostDiagnostic()}`);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error(`CLI_CODEX_HOST_UNSUPPORTED: ${cliCodexHostDiagnostic()}`);
}

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export type CliCodexRuntimeIdentity = Readonly<{
  version: typeof CLI_CODEX_RUNTIME_VERSION;
  digest: string;
}>;

export type CliCodexAdmissionEvidence = Readonly<{
  schema: "xcb.cli-codex-admission.v1";
  platform: "darwin-arm64";
  runtime: CliCodexRuntimeIdentity;
  manifest: CodexProtocolManifest;
  nativeSha256: string;
  schemaSha256: string;
  parentSha256: string;
  configurationSha256: string;
  offline: Readonly<{
    passed: true;
    network: "denied";
    bootstrapJoined: true;
    processJoined: true;
    leaseReleased: true;
    methods: readonly ["initialize", "initialized", "config/read"];
    configurationObserved: true;
    disabledNotices: 1;
    frameCount: number;
  }>;
  evidenceDigest: string;
  productionQualified: false;
}>;

export function cliCodexRuntimeIdentity(input: Readonly<{
  nativeSha256: string; schemaSha256: string; parentSha256: string;
}>): CliCodexRuntimeIdentity {
  const digest = hash(JSON.stringify({ version: CLI_CODEX_RUNTIME_VERSION, ...input }));
  return Object.freeze({ version: CLI_CODEX_RUNTIME_VERSION, digest });
}

async function schemaBundleDigest(root: string): Promise<{ sha256: string; files: number; bytes: number }> {
  const paths: string[] = [];
  async function visit(directory: string, relative: string): Promise<void> {
    const iterator = await opendir(directory);
    try {
      for (;;) {
        const entry = await iterator.read();
        if (entry === null) break;
        const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) await visit(join(directory, entry.name), child);
        else if (entry.isFile() && /^[A-Za-z0-9._/-]{1,512}$/u.test(child)) paths.push(child);
        else throw new Error("CLI_CODEX_SCHEMA_ENTRY_INVALID");
        if (paths.length > 1024) throw new Error("CLI_CODEX_SCHEMA_FILES_INVALID");
      }
    } finally {
      await iterator.close();
    }
  }
  await visit(root, "");
  const digest = createHash("sha256");
  let bytes = 0;
  for (const relative of paths.sort()) {
    const contents = await readFile(join(root, relative));
    bytes += contents.length;
    if (bytes > 16 * 1024 * 1024) throw new Error("CLI_CODEX_SCHEMA_BYTES_INVALID");
    digest.update(relative).update("\0").update(String(contents.length)).update("\0").update(contents);
  }
  return { sha256: digest.digest("hex"), files: paths.length, bytes };
}

export async function qualifyCliCodexRuntime(input: Readonly<{
  stateRoot: string; inspection: CliBinaryInspection; now?: () => number;
}>): Promise<CliCodexAdmissionEvidence> {
  assertCliCodexHost();
  if (input.inspection.provider !== "codex" || input.inspection.version !== CODEX_NATIVE_VERSION
    || input.inspection.sha256 !== CODEX_NATIVE_SHA256 || !input.inspection.versionMatches || !input.inspection.digestMatches) {
    throw new Error("CLI_CODEX_RUNTIME_UNADMITTED");
  }
  const stateRoot = await privateDirectory(input.stateRoot), executablePath = await realpath(input.inspection.executablePath);
  await inspectCodexHostExecutable(executablePath, CODEX_NATIVE_SHA256);
  const parent = await inspectCodexHostRuntime({ expectedSha256: CLI_CODEX_BUN_DARWIN_ARM64_SHA256 });
  const temporary = await realpath(await mkdtemp(join(stateRoot, "codex-qualification-")));
  let cleanup = true;
  try {
    const scratch = join(temporary, "schema-scratch"), accountHome = join(temporary, "schema-account"), schemaDirectory = join(scratch, "schema");
    await mkdir(scratch, { mode: 0o700 }); await mkdir(accountHome, { mode: 0o700 }); await mkdir(schemaDirectory, { mode: 0o700 });
    const profile = codexManagedOfflineSandbox({ executable: executablePath, scratch, accountHome });
    const generated = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, executablePath, "app-server", "generate-json-schema", "--experimental", "--out", schemaDirectory], {
      cwd: scratch, env: { PATH: "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    const [code, stdout, stderr] = await Promise.all([generated.exited, new Response(generated.stdout).arrayBuffer(), new Response(generated.stderr).arrayBuffer()]);
    if (code !== 0 || stdout.byteLength > 64 * 1024 || stderr.byteLength > 64 * 1024) throw new Error("CLI_CODEX_SCHEMA_GENERATION_FAILED");
    const schema = await schemaBundleDigest(schemaDirectory);
    if (schema.sha256 !== CLI_CODEX_SCHEMA_SHA256 || schema.files !== CLI_CODEX_SCHEMA_FILES || schema.bytes !== CLI_CODEX_SCHEMA_BYTES) {
      throw new Error("CLI_CODEX_SCHEMA_MISMATCH");
    }
    const manifest = buildCodexProtocolManifest({ protocolVersion: "v2-experimental", sourceVersion: CODEX_NATIVE_VERSION,
      executableSha256: CODEX_NATIVE_SHA256, schemaSha256: schema.sha256, generatedAtUnixMs: (input.now ?? Date.now)() });
    assertCodexProtocolManifest(manifest, { version: CODEX_NATIVE_VERSION, sha256: CODEX_NATIVE_SHA256, schemaSha256: schema.sha256 });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
    let diagnostic;
    try {
      diagnostic = await runCodexManagedOfflineDiagnostic({ directory: temporary,
        runtime: { executablePath, version: CODEX_NATIVE_VERSION, sha256: CODEX_NATIVE_SHA256, schemaSha256: schema.sha256,
          parentRuntime: { expectedSha256: parent.sha256 } }, signal: controller.signal,
        admission: { kind: "managed-offline-lifecycle-diagnostic-v1", nativeSha256: CODEX_NATIVE_SHA256,
          schemaSha256: schema.sha256, parentSha256: parent.sha256 } });
    } finally {
      clearTimeout(timer);
    }
    const protocol = diagnostic.protocol;
    cleanup = diagnostic.bootstrapJoined && diagnostic.processJoined && diagnostic.leaseReleased && protocol?.joined === true;
    if (!diagnostic.passed || !cleanup || protocol === null || protocol.failure !== null || protocol.configurationObserved !== true
      || JSON.stringify(protocol.methods) !== JSON.stringify(["initialize", "initialized", "config/read"])
      || protocol.disabledNotices !== 1) throw new Error("CLI_CODEX_OFFLINE_DIAGNOSTIC_FAILED");
    const runtime = cliCodexRuntimeIdentity({ nativeSha256: CODEX_NATIVE_SHA256, schemaSha256: schema.sha256,
      parentSha256: parent.sha256 });
    const content = Object.freeze({ schema: "xcb.cli-codex-admission.v1" as const, platform: "darwin-arm64" as const,
      runtime, manifest, nativeSha256: CODEX_NATIVE_SHA256, schemaSha256: schema.sha256, parentSha256: parent.sha256,
      configurationSha256: diagnostic.configurationSha256,
      offline: Object.freeze({ passed: true as const, network: "denied" as const, bootstrapJoined: true as const,
        processJoined: true as const, leaseReleased: true as const,
        methods: Object.freeze(["initialize", "initialized", "config/read"] as const), configurationObserved: true as const,
        disabledNotices: 1 as const, frameCount: protocol.frameCount }), productionQualified: false as const });
    return Object.freeze({ ...content, evidenceDigest: hash(JSON.stringify(content)) });
  } finally {
    if (cleanup) await rm(temporary, { recursive: true, force: true });
  }
}

function currentCodexIdentity(): CliCodexRuntimeIdentity {
  return cliCodexRuntimeIdentity({ nativeSha256: CODEX_NATIVE_SHA256, schemaSha256: CLI_CODEX_SCHEMA_SHA256,
    parentSha256: CLI_CODEX_BUN_DARWIN_ARM64_SHA256 });
}

async function admittedCodex(stateRoot: string, inspection: CliBinaryInspection): Promise<CliCodexRuntimeIdentity> {
  assertCliCodexHost();
  if (process.platform !== "darwin" || process.arch !== "arm64" || inspection.provider !== "codex"
    || inspection.version !== CODEX_NATIVE_VERSION || inspection.sha256 !== CODEX_NATIVE_SHA256
    || !inspection.versionMatches || !inspection.digestMatches) throw new Error("CLI_CODEX_RUNTIME_UNADMITTED");
  const expected = currentCodexIdentity(), record = await readCliQualification(stateRoot, "codex");
  if (record === null || record.executablePath !== inspection.executablePath || record.executableSha256 !== CODEX_NATIVE_SHA256
    || record.runtimeVersion !== expected.version || record.runtimeDigest !== expected.digest) throw new Error("CLI_CODEX_RUNTIME_UNADMITTED");
  return expected;
}

export function createCliCodexManagedLauncher(stateRoot: string, inspection: CliBinaryInspection, runtime = currentCodexIdentity()) {
  assertCliCodexHost();
  return createCodexManagedProcessLauncher({ stateRoot,
    runtime: { executablePath: inspection.executablePath, version: CODEX_NATIVE_VERSION, sha256: CODEX_NATIVE_SHA256,
      schemaSha256: CLI_CODEX_SCHEMA_SHA256, parentRuntime: { expectedSha256: CLI_CODEX_BUN_DARWIN_ARM64_SHA256 } },
    admission: { profile: "managed-task-provider-tcp443-dns-candidate-v2", taskRuntimeVersion: runtime.version,
      taskRuntimeDigest: runtime.digest, nativeSha256: CODEX_NATIVE_SHA256, schemaSha256: CLI_CODEX_SCHEMA_SHA256,
      parentSha256: CLI_CODEX_BUN_DARWIN_ARM64_SHA256 },
  });
}

async function withCodexAccount<T>(stateRoot: string, inspection: CliBinaryInspection,
  action: (controller: ReturnType<typeof createManagedCodexAccountController>) => Promise<T>): Promise<T> {
  await admittedCodex(stateRoot, inspection);
  const root = await privateDirectory(stateRoot), database = await openAccountDatabase(join(root, "account-leases.sqlite"));
  const leases = new SqliteAccountLeases(database), owner = `cli-codex-${randomBytes(10).toString("hex")}`;
  const runtime = { executablePath: inspection.executablePath, version: CODEX_NATIVE_VERSION, sha256: CODEX_NATIVE_SHA256,
    schemaSha256: CLI_CODEX_SCHEMA_SHA256, parentRuntime: { expectedSha256: CLI_CODEX_BUN_DARWIN_ARM64_SHA256 } };
  const controller = createManagedCodexAccountController({ accountId: "local", owner, processGeneration: Date.now(), leases,
    transportFactory(binding, onEvent) {
      const processPort = createCodexAccountProcess({ binding, stateRoot: root, runtime, mode: "device-code",
        deviceCodeAdmission: { profile: "codex-account-device-code-tcp443-dns-v3", nativeSha256: CODEX_NATIVE_SHA256,
          schemaSha256: CLI_CODEX_SCHEMA_SHA256, parentSha256: CLI_CODEX_BUN_DARWIN_ARM64_SHA256 } });
      return createCodexAccountStdioTransport({ binding, process: processPort, onEvent, initializeTimeoutMs: 20_000, closeTimeoutMs: 20_000 });
    }, operationTimeoutMs: 30_000, closeTimeoutMs: 20_000 });
  try {
    return await action(controller);
  } finally {
    let released = false;
    try { released = (await controller.close()).released; }
    finally { database.close(); }
    if (!released) throw new Error("CLI_CODEX_ACCOUNT_CLOSE_UNPROVEN");
  }
}

export async function codexAuthStatus(stateRoot: string, inspection: CliBinaryInspection): Promise<Readonly<{
  admitted: boolean; loggedIn: boolean; planType: string | null; models: readonly string[];
}>> {
  try {
    const snapshot = await withCodexAccount(stateRoot, inspection, controller => controller.check());
    return Object.freeze({ admitted: true, loggedIn: snapshot.state === "signed-in", planType: snapshot.planType ?? null,
      models: Object.freeze(snapshot.models.map(model => model.id)) });
  } catch (error) {
    if (error instanceof Error && error.message === "CLI_CODEX_RUNTIME_UNADMITTED") {
      return Object.freeze({ admitted: false, loggedIn: false, planType: null, models: Object.freeze([]) });
    }
    throw error;
  }
}

export async function codexLogin(stateRoot: string, inspection: CliBinaryInspection,
  onChallenge: (challenge: CodexLoginChallenge) => void, signal?: AbortSignal): Promise<CodexAccountSnapshot> {
  return await withCodexAccount(stateRoot, inspection, async controller => {
    let snapshot = await controller.check(signal);
    if (snapshot.state === "signed-in") return snapshot;
    const challenge = await controller.startLogin("chatgptDeviceCode", signal);
    onChallenge(challenge);
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline && !signal?.aborted) {
      await Bun.sleep(1500);
      try { snapshot = await controller.check(signal); }
      catch {
        if (controller.snapshot().state !== "unchecked") throw new Error("CLI_CODEX_LOGIN_FAILED");
        continue;
      }
      if (snapshot.state === "signed-in") return snapshot;
      if (snapshot.state === "recovery-required" || snapshot.state === "unavailable") throw new Error("CLI_CODEX_LOGIN_FAILED");
    }
    await controller.cancelLogin(challenge.loginId).catch(() => {});
    throw new Error(signal?.aborted ? "CLI_CODEX_LOGIN_ABORTED" : "CLI_CODEX_LOGIN_TIMEOUT");
  });
}

export async function codexLogout(stateRoot: string, inspection: CliBinaryInspection): Promise<void> {
  await withCodexAccount(stateRoot, inspection, async controller => { await controller.logout(); });
}
