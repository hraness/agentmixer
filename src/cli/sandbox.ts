import { writeFileSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { planSeatbeltPolicy, createSandboxedProviderProcessFactory, type OsSandboxPlan } from "../os-sandbox.ts";
import type { BoundedProviderProcessFactory } from "../provider-process.ts";

const fail = (code: string): never => { throw new Error(code); };
function path(value: unknown): string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4096
    && !/[\x00-\x1f\x7f"\\]/u.test(value) ? value : fail("CLI_SANDBOX_PATH_INVALID");
}

/** Reviewed SBPL profile for one CLI Claude run, verified against Claude Code
 * under sandbox-exec. The model's whole tool surface is the in-process MCP
 * broker, so the OS policy grants: exec of the verified run snapshot only
 * (fork is allowed, but no other binary can be exec'd — the child's attempts
 * to spawn git/sh/security are denied and it continues without them),
 * read-only system runtime surface (dyld cryptexes, ICU, resolver config in
 * /etc, global preferences, zoneinfo), rw on the per-run scratch, the managed
 * auth directory and Claude's own per-user /tmp/claude-<uid> dir, and egress
 * on TCP 443 plus the system resolver and syslog sockets. Keychain and
 * securityd are deliberately absent — the subscription token arrives via
 * CLAUDE_CODE_OAUTH_TOKEN env, so no Mach credential service is needed.
 * Verified note: a denied process cwd makes the bun runtime report a
 * misleading "low max file descriptors" error, so cwd must resolve inside the
 * writable scratch subtree. Host-owned text, never model or settings input. */
export function claudeCliSandboxPolicy(input: { executable: string; scratch: string; accountHome: string }): string {
  const executable = path(input.executable), scratch = path(input.scratch), accountHome = path(input.accountHome);
  const inside = (inner: string, outer: string) => inner === outer || inner.startsWith(outer + "/");
  if (inside(executable, scratch) || inside(executable, accountHome) || inside(scratch, accountHome) || inside(accountHome, scratch)) {
    fail("CLI_SANDBOX_LAYOUT_INVALID");
  }
  const uid = process.getuid?.();
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) fail("CLI_SANDBOX_UID_INVALID");
  const claudeTmp = `/private/tmp/claude-${uid}`;
  const q = JSON.stringify;
  return `(version 1)
(deny default)
(allow process-exec (literal ${q(executable)}))
(allow process-fork)
(allow process-info* (target self))
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow file-ioctl (literal "/dev/null") (subpath "/dev/fd"))
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/dtracehelper") (subpath "/dev/fd"))
(allow file-read* (literal "/") (literal "/tmp") (literal "/etc") (literal "/var") (literal "/Library") (literal "/private/etc") (literal "/private/tmp") (literal "/private/var")
  (literal ${q(executable)})
  (subpath "/System") (subpath "/usr") (subpath "/Library/Preferences") (subpath "/Library/Apple") (subpath "/etc") (subpath "/private/etc") (subpath "/var/db/timezone") (subpath "/private/var/db/timezone"))
(allow file-map-executable (literal ${q(executable)}) (subpath "/System") (subpath "/usr"))
(allow file-read* file-write* (subpath ${q(scratch)}) (subpath ${q(accountHome)}) (subpath ${q(claudeTmp)}))
(allow file-read-metadata (path-ancestors ${q(executable)}) (path-ancestors ${q(scratch)}) (path-ancestors ${q(accountHome)}) (path-ancestors ${q(claudeTmp)}))
(allow network-outbound (literal "/private/var/run/mDNSResponder") (literal "/private/var/run/syslog") (remote tcp "*:443"))
`;
}

const SEATBELT = "/usr/bin/sandbox-exec";

/** Seatbelt is darwin-only; other platforms keep the unwrapped bounded-process
 * custody. The returned factory plans lazily inside the SDK's synchronous
 * spawn callback: the run directory is derived from the snapshot path the
 * adapter hands over, the policy is persisted outside the writable scratch,
 * and argv/env are rewritten onto /usr/bin/sandbox-exec. */
export function claudeCliProcessFactory(accountHome: string): BoundedProviderProcessFactory | undefined {
  if (process.platform !== "darwin") return undefined;
  const home = path(accountHome);
  return (input) => {
    const executable = path(input.executable);
    const runRoot = dirname(executable);
    const scratch = join(runRoot, "scratch");
    const policyPath = join(runRoot, "sandbox.sb");
    const plan: OsSandboxPlan = planSeatbeltPolicy(
      { platform: "darwin", executable, scratch, accountHome: home, network: "provider-tcp443-dns", policyPath },
      claudeCliSandboxPolicy({ executable, scratch, accountHome: home }),
    );
    writeFileSync(policyPath, plan.policy, { mode: 0o400, flag: "w" });
    return createSandboxedProviderProcessFactory(plan)(input);
  };
}

/** Seatbelt availability probe for diagnostics; never admits by itself. */
export async function seatbeltAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await access(SEATBELT, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
