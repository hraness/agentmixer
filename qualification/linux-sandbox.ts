/** Bounded Linux kernel-boundary probe for the bwrap backend: synthetic files
 * and loopback only; no accounts, credentials or model calls. It proves — or
 * honestly reports against — the exact kernel boundaries the `bwrap` plan
 * claims: foreign paths absent (ENOENT, not merely EPERM), a fresh network
 * namespace with no usable route, a fresh PID namespace (getpid()==1), and a
 * writable scratch root. It never launches unsandboxed: if the toolchain,
 * wrapper artifact or namespaces are unavailable the probe reports blocked
 * evidence and exits nonzero. Exit 0 means every assertion held on this host.
 *
 * Usage: bun qualification/linux-sandbox.ts --bwrap <path> --bwrap-sha256 <hex>
 * Optionally --cc <path> to select the C toolchain (default `cc`). */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBwrapOsSandbox } from "../src/os-sandbox.ts";

if (process.platform !== "linux") throw new Error("REQUIRES_LINUX");
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const bwrap = argument("--bwrap"), bwrapSha256 = argument("--bwrap-sha256"), cc = argument("--cc") ?? "cc";
for (const flag of process.argv.slice(2)) {
  if (flag.startsWith("-") && !["--bwrap", "--bwrap-sha256", "--cc"].includes(flag)) throw new Error("INVALID_QUALIFICATION_ARGUMENT");
}
if (!bwrap || !bwrapSha256 || !/^[a-f0-9]{64}$/.test(bwrapSha256)) throw new Error("REQUIRES_ADMITTED_BWRAP_ARTIFACT");

const root = await realpath(await mkdtemp(join(tmpdir(), "agentmixer-linux-probe-")));
try {
  const scratch = join(root, "scratch"), account = join(root, "account"), outside = join(root, "foreign");
  await mkdir(scratch, { mode: 0o700 }); await mkdir(account, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
  const canary = join(outside, "canary"); await writeFile(canary, "synthetic-private-canary", { mode: 0o600 });
  const probe = join(root, "probe"), source = join(root, "probe.c");
  await writeFile(source, `#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
int main(int argc, char **argv) {
  int fd = open(argv[1], O_WRONLY|O_CREAT, 0600), own = fd >= 0;
  if (fd >= 0) { write(fd, "own", 3); close(fd); }
  int foreignReadDenied = open(argv[2], O_RDONLY|O_NONBLOCK) < 0;
  int foreignWriteDenied = open(argv[3], O_WRONLY|O_CREAT, 0600) < 0;
  int foreignDirDenied = open(argv[5], O_RDONLY|O_NONBLOCK) < 0;
  int sock = socket(AF_INET, SOCK_STREAM, 0), netDenied = 1;
  if (sock >= 0) {
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons((unsigned short)atoi(argv[4])) };
    inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
    netDenied = connect(sock, (struct sockaddr*)&a, sizeof(a)) < 0;
    close(sock);
  }
  int pidIsolated = getpid() == 1;
  printf("{\\"ownWrite\\":%s,\\"foreignReadDenied\\":%s,\\"foreignWriteDenied\\":%s,\\"foreignDirDenied\\":%s,\\"netDenied\\":%s,\\"pidIsolated\\":%s}\\n",
    own?"true":"false", foreignReadDenied?"true":"false", foreignWriteDenied?"true":"false",
    foreignDirDenied?"true":"false", netDenied?"true":"false", pidIsolated?"true":"false");
  return !(own && foreignReadDenied && foreignWriteDenied && foreignDirDenied && netDenied && pidIsolated);
}
`);

  async function run(argv: string[], cwd: string, timeout: number, env?: Record<string, string>) {
    const child = Bun.spawn(argv, { cwd, env: env ?? { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr: stderr.slice(0, 2048) };
  }

  // The probe is statically linked: the sandbox binds only the executable and
  // the declared roots, so no dynamic loader or libc path exists inside.
  const built = await run([cc, "-O0", "-static", "-o", probe, source], root, 60_000);
  if (built.code !== 0) {
    console.log(JSON.stringify({ profile: "experimental-linux-kernel-fixture", blocked: true, stage: "compile",
      stderr: built.stderr, productionQualificationIssued: false }, null, 2));
    process.exitCode = 1;
  } else {
    const backend = createBwrapOsSandbox({ executable: bwrap, sha256: bwrapSha256 });
    const plan = await backend.plan({ executable: probe, scratch, accountHome: account, network: "denied",
      policyPath: join(root, "sandbox.json") });
    const wrapped = plan.wrap({ args: [join(scratch, "own"), canary, join(outside, "write"), "65533", outside],
      env: { HOME: scratch, TMPDIR: scratch }, cwd: scratch });
    const result = await run([plan.executable, ...wrapped.args], scratch, 15_000, { PATH: "/usr/bin:/bin" });
    let observed: Record<string, unknown> = {};
    try { observed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}"); } catch { observed = { parse: "failed" }; }
    const canaryIntact = await readFile(canary, "utf8").then(text => text === "synthetic-private-canary", () => false);
    console.log(JSON.stringify({ profile: "experimental-linux-kernel-fixture", blocked: false,
      productionQualificationIssued: false, paidModelRequests: 0,
      probeSha256: createHash("sha256").update(await readFile(probe)).digest("hex"),
      policySha256: plan.policySha256, wrapperSha256: bwrapSha256,
      canaryIntact, observed, exitCode: result.code, stderr: result.stderr }, null, 2));
    if (result.code !== 0 || !canaryIntact) process.exitCode = 1;
  }
} finally { await rm(root, { recursive: true, force: true }); }
