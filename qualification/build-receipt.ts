import { readFile, writeFile } from "node:fs/promises";

const bwrap = process.argv[2];
const sha256 = process.argv[3];
const output = process.argv[4];

if (!bwrap || !sha256 || !output || !/^[a-f0-9]{64}$/.test(sha256)) {
  console.error("usage: build-receipt.ts <bwrap-path> <bwrap-sha256> <output.json>");
  process.exit(2);
}

const probes = ["linux-sandbox", "linux-egress", "linux-loopback"] as const;
// Field names are the receipt contract: xcb-runtime's Probe deserializes
// `exit_code`/`passed` verbatim (serde deny_unknown_fields), so camelCase or
// extra keys would silently corrupt — or outright reject — the evidence.
type ProbeResult = { exit_code: number; passed: boolean };
const probeResults: Record<string, ProbeResult> = {};

let allPassed = true;
for (const name of probes) {
  let parsed: Record<string, unknown> = {};
  try {
    const text = await readFile(`evidence/${name}.json`, "utf8");
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  // The probe's process exit code is the authoritative verdict — each probe
  // sets process.exitCode on failure and the workflow records it beside the
  // JSON evidence. A missing or unreadable record means the probe never
  // completed; fail closed rather than default to "ran fine".
  let exitCode = 1;
  try {
    const recorded = (await readFile(`evidence/${name}.exitcode`, "utf8")).trim();
    if (/^\d+$/.test(recorded)) exitCode = Number.parseInt(recorded, 10);
  } catch {
    exitCode = 1;
  }
  const blocked = parsed.blocked === true;
  // "passed" means the probe ran to completion, wasn't blocked, and exited
  // zero. Loopback's per-mechanism M*_passed details stay in its JSON; the
  // receipt carries only the verdict the runtime admission checks.
  const passed = !blocked && exitCode === 0;
  probeResults[name] = { exit_code: exitCode, passed };
  if (!passed) allPassed = false;
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

// The receipt is written above regardless — evidence first — but its verdict
// gates the job: a failed, blocked or unrecorded probe exits nonzero so the
// workflow marks the run failed instead of publishing a passing receipt.
if (!allPassed) {
  console.error("build-receipt: one or more probes did not pass");
  process.exitCode = 1;
}
