import { readFile, writeFile } from "node:fs/promises";

const bwrap = process.argv[2];
const sha256 = process.argv[3];
const output = process.argv[4];

if (!bwrap || !sha256 || !output || !/^[a-f0-9]{64}$/.test(sha256)) {
  console.error("usage: build-receipt.ts <bwrap-path> <bwrap-sha256> <output.json>");
  process.exit(2);
}

const probes = ["linux-sandbox", "linux-egress", "linux-loopback"] as const;
type ProbeResult = { exitCode: number; blocked?: boolean; passed?: boolean };
const probeResults: Record<string, ProbeResult> = {};

for (const name of probes) {
  let parsed: Record<string, unknown> = {};
  try {
    const text = await readFile(`evidence/${name}.json`, "utf8");
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : 1;
  const blocked = parsed.blocked === true;
  // Each probe reports its own exitCode; "passed" means it wasn't blocked and
  // exited zero. The loopback probe additionally needs at least one mechanism
  // to pass, but if exitCode is zero the probe already took that into account.
  probeResults[name] = { exitCode, passed: !blocked && exitCode === 0 };
}

const unprivileged = await readFile("/proc/sys/kernel/unprivileged_userns_clone", "utf8").catch(() => "absent");
const max = await readFile("/proc/sys/user/max_user_namespaces", "utf8").catch(() => "0");

const receipt = {
  schema: "xcb.qualification.linux.v1" as const,
  wrapper: { path: bwrap, sha256 },
  namespaces: {
    unprivileged_userns_clone: unprivileged.trim() || "absent",
    max_user_namespaces: max.trim() || "0",
  },
  probes: probeResults,
  observed_at_ms: Date.now(),
};

await writeFile(output, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt, null, 2));
