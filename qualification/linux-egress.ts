/** Bounded Linux kernel-boundary probe for the egress-bridge path: a synthetic
 * CONNECT client inside the bwrap namespace, a synthetic host dialer outside;
 * no accounts, credentials, DNS or model calls. It proves — or honestly
 * reports against — the exact boundary the `provider-tcp443-dns` plan claims:
 * the bridge socket is bind-mounted and reachable (CONNECT handshake answers
 * 200, bytes tunnel both ways), while direct TCP and foreign unix paths stay
 * absent inside the unshared network namespace. If the toolchain, wrapper
 * artifact or namespaces are unavailable the probe reports blocked evidence
 * and exits nonzero. Exit 0 means every assertion held on this host.
 *
 * Usage: bun qualification/linux-egress.ts --bwrap <path> --bwrap-sha256 <hex>
 * Optionally --cc <path> to select the C toolchain (default `cc`). */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { createBwrapOsSandbox } from "../src/os-sandbox.ts";
import { createEgressBridge } from "../src/egress-bridge.ts";

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

const root = await realpath(await mkdtemp(join(tmpdir(), "xcb-linux-egress-probe-")));
let bridge: Awaited<ReturnType<typeof createEgressBridge>> | undefined;
try {
  const scratch = join(root, "scratch"), account = join(root, "account"), runDir = join(root, "runDir"), outside = join(root, "foreign");
  for (const dir of [scratch, account, runDir, outside]) await mkdir(dir, { mode: 0o700 });
  const socketPath = join(runDir, "egress.sock"), absentSocket = join(runDir, "absent.sock");

  // The upstream pair is synthetic: the probe records client bytes and feeds a
  // fixed reply token, so no real resolver or provider endpoint is involved.
  // One-way Duplex: client bytes sink into `_write` (a PassThrough would echo
  // the reply into itself), and the reply is pushed once without ending the
  // stream — ending inline would race the bridge's forwarding before close.
  const clientBytes: Buffer[] = [];
  let replied = false;
  const upstream = new Duplex({
    write(chunk, _encoding, callback) {
      clientBytes.push(chunk);
      if (!replied) { replied = true; upstream.push("PROBE-TOKEN"); }
      callback();
    },
    read() {},
  });
  bridge = await createEgressBridge({ socketPath, allowlist: ["probe.invalid"],
    dialer: { connect: () => Promise.resolve(upstream) } });

  const probe = join(root, "probe"), source = join(root, "probe.c");
  await writeFile(source, `#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <netinet/in.h>
#include <arpa/inet.h>
int main(int argc, char **argv) {
  // argv[1] bridge socket path, argv[2] absent socket path.
  int fd = socket(AF_UNIX, SOCK_STREAM, 0), connected = 0, bridged = 0, tunneled = 0;
  if (fd >= 0) {
    struct sockaddr_un a; memset(&a, 0, sizeof(a)); a.sun_family = AF_UNIX;
    strncpy(a.sun_path, argv[1], sizeof(a.sun_path) - 1);
    if (connect(fd, (struct sockaddr*)&a, sizeof(a)) == 0) { connected = 1;
      const char *req = "CONNECT probe.invalid:443 HTTP/1.1\\r\\n\\r\\nPING";
      write(fd, req, strlen(req));
      char buf[512]; ssize_t n = read(fd, buf, sizeof(buf) - 1);
      if (n > 0) { buf[n] = 0;
        bridged = strstr(buf, "200 Connection Established") != NULL;
        if (!strstr(buf, "PROBE-TOKEN")) { n = read(fd, buf, sizeof(buf) - 1); if (n > 0) buf[n] = 0; }
        tunneled = strstr(buf, "PROBE-TOKEN") != NULL;
      }
    }
    close(fd);
  }
  int absent = socket(AF_UNIX, SOCK_STREAM, 0), absentDenied = 1;
  if (absent >= 0) {
    struct sockaddr_un a; memset(&a, 0, sizeof(a)); a.sun_family = AF_UNIX;
    strncpy(a.sun_path, argv[2], sizeof(a.sun_path) - 1);
    absentDenied = connect(absent, (struct sockaddr*)&a, sizeof(a)) < 0;
    close(absent);
  }
  int sock = socket(AF_INET, SOCK_STREAM, 0), directDenied = 1;
  if (sock >= 0) {
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(443) };
    inet_pton(AF_INET, "203.0.113.1", &a.sin_addr);
    directDenied = connect(sock, (struct sockaddr*)&a, sizeof(a)) < 0;
    close(sock);
  }
  // --die-with-parent keeps a bwrap monitor as pid 1 inside the namespace, so
  // a fresh pidns shows the canary at pid 1 or 2 — never a host-scale pid.
  int pidIsolated = getpid() <= 2;
  printf("{\\"bridgeConnect\\":%s,\\"connectEstablished\\":%s,\\"tunneledReply\\":%s,\\"absentSocketDenied\\":%s,\\"directTcpDenied\\":%s,\\"pidIsolated\\":%s}\\n",
    connected?"true":"false", bridged?"true":"false", tunneled?"true":"false",
    absentDenied?"true":"false", directDenied?"true":"false", pidIsolated?"true":"false");
  return !(connected && bridged && tunneled && absentDenied && directDenied && pidIsolated);
}
`);

  async function run(argv: string[], cwd: string, timeout: number, env?: Record<string, string>) {
    const child = Bun.spawn(argv, { cwd, env: env ?? { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr: stderr.slice(0, 2048) };
  }

  const built = await run([cc, "-O0", "-static", "-o", probe, source], root, 60_000);
  if (built.code !== 0) {
    console.log(JSON.stringify({ profile: "experimental-linux-egress-fixture", blocked: true, stage: "compile",
      stderr: built.stderr, productionQualificationIssued: false }, null, 2));
    process.exitCode = 1;
  } else {
    const backend = createBwrapOsSandbox({ executable: bwrap, sha256: bwrapSha256 });
    const plan = await backend.plan({ platform: "linux", executable: probe, scratch, accountHome: account,
      network: "provider-tcp443-dns", egressSocket: socketPath, policyPath: join(runDir, "sandbox.json") });
    const wrapped = plan.wrap({ args: [socketPath, absentSocket], env: { HOME: scratch, TMPDIR: scratch }, cwd: scratch });
    const result = await run([plan.executable, ...wrapped.args], scratch, 15_000, { PATH: "/usr/bin:/bin" });
    let observed: Record<string, unknown> = {};
    try { observed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}"); } catch { observed = { parse: "failed" }; }
    const receipt = await bridge.close(); bridge = undefined;
    console.log(JSON.stringify({ profile: "experimental-linux-egress-fixture", blocked: false,
      productionQualificationIssued: false, paidModelRequests: 0,
      probeSha256: createHash("sha256").update(await readFile(probe)).digest("hex"),
      policySha256: plan.policySha256, wrapperSha256: bwrapSha256,
      clientBytesUpstream: Buffer.concat(clientBytes).toString("latin1").includes("PING"),
      bridge: { accepted: receipt.connectionsAccepted, refused: receipt.connectionsRefused,
        listenerClosed: receipt.listenerClosed, socketsJoined: receipt.socketsJoined, socketRemoved: receipt.socketRemoved },
      observed, exitCode: result.code, stderr: result.stderr }, null, 2));
    if (result.code !== 0 || !(receipt.listenerClosed && receipt.socketsJoined && receipt.socketRemoved)) process.exitCode = 1;
  }
} finally { await bridge?.close().catch(() => {}); await rm(root, { recursive: true, force: true }); }
