import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildQualificationRecord, readCliQualification, toTaskQualification, writeCliQualification } from "../src/cli/qualification.ts";
import { createCliWorkspace, createCliWorkspaceProfile } from "../src/cli/workspace.ts";
import { claudeTaskRuntimeIdentity } from "../src/claude-task-adapter.ts";

const sha = (ch: string) => ch.repeat(64);

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xcb-t-")));
  await chmod(root, 0o700);
  const profile = createCliWorkspaceProfile(createCliWorkspace(root));
  const route = Object.freeze({ id: "claude-subscription", provider: "claude" as const, authentication: "subscription" as const });
  const identity = claudeTaskRuntimeIdentity({ executableSha256: sha("a"), cliVersion: "2.1.268", authentication: "subscription" });
  return { root, profile, route, identity };
}

describe("cli qualification records", () => {
  test("round-trips a record and produces qualified evidence", async () => {
    const { root, profile, route, identity } = await fixture();
    const record = buildQualificationRecord({
      provider: "claude", route, executablePath: "/usr/local/bin/claude", executableSha256: sha("a"),
      runtimeVersion: identity.version, runtimeDigest: identity.digest, profileDigest: profile.digest, now: Date.now(),
    });
    expect(record.evidenceDigest).toMatch(/^[a-f0-9]{64}$/u);
    await writeCliQualification(root, record);
    const read = await readCliQualification(root, "claude");
    expect(read?.executableSha256).toBe(sha("a"));
    const qualification = toTaskQualification(read!, {
      route, profile, runtimeVersion: identity.version, runtimeDigest: identity.digest,
    });
    expect(qualification.status).toBe("qualified");
    if (qualification.status === "qualified") {
      expect(qualification.controls.noCommandTools).toBe(true);
      expect(qualification.expiresAt).toBe(record.expiresAtUnixMs);
    }
  });

  test("missing records and provider mismatches stay unqualified", async () => {
    const { root, profile, route, identity } = await fixture();
    expect(await readCliQualification(root, "claude")).toBeNull();
    const record = buildQualificationRecord({
      provider: "claude", route, executablePath: "/x/claude", executableSha256: sha("a"),
      runtimeVersion: identity.version, runtimeDigest: identity.digest, profileDigest: profile.digest, now: Date.now(),
    });
    await writeCliQualification(root, record);
    expect(await readCliQualification(root, "codex")).toBeNull();
    const drifted = toTaskQualification((await readCliQualification(root, "claude"))!, {
      route, profile, runtimeVersion: identity.version, runtimeDigest: sha("f"),
    });
    expect(drifted.status).toBe("unqualified");
  });

  test("legacy Devin records cannot synthesize effective tool-inventory evidence", async () => {
    const { profile, identity } = await fixture();
    const route = { id: "devin-subscription", provider: "devin" as const, authentication: "subscription" as const };
    const record = buildQualificationRecord({ provider: "devin", route, executablePath: "/x/devin", executableSha256: sha("a"),
      runtimeVersion: identity.version, runtimeDigest: identity.digest, profileDigest: profile.digest, now: Date.now() });
    expect(toTaskQualification(record, { route, profile, runtimeVersion: identity.version, runtimeDigest: identity.digest }).status).toBe("unqualified");
  });

  test("expired records read as absent", async () => {
    const { root, profile, route, identity } = await fixture();
    const record = buildQualificationRecord({
      provider: "claude", route, executablePath: "/x/claude", executableSha256: sha("a"),
      runtimeVersion: identity.version, runtimeDigest: identity.digest, profileDigest: profile.digest, now: Date.now() - 8 * 24 * 60 * 60 * 1000,
    });
    await writeCliQualification(root, record);
    expect(await readCliQualification(root, "claude")).toBeNull();
  });
});
