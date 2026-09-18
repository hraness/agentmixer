/** Linux mechanism probe for the in-namespace loopback CONNECT forwarder: the
 * consumption half of `provider-tcp443-dns`. A stock client binary (curl) is
 * given only `HTTPS_PROXY=http://127.0.0.1:<port>`; an in-namespace forwarder
 * translates each `CONNECT host:443` into the host bridge's unix socket, so the
 * child reaches the provider without DNS or direct TCP. Two mechanisms are
 * measured for raising `lo` inside the unshared net namespace:
 *
 *   M1 "cap-add":   bwrap retains CAP_NET_ADMIN for the forwarder, which runs
 *                   `ip link set lo up` inside the namespace.
 *   M2 "pre-up":    an outer `unshare --user --map-root-user --net` creates the
 *                   namespaces, `ip` raises lo with host-side tooling, and
 *                   `bwrap --share-net` inherits the prepared net namespace.
 *
 * Both keep the child without any route except the loopback proxy. Evidence is
 * JSON: capability bits, lo-up results, tunnel traffic and the curl outcome.
 * Exit 0 means at least one mechanism carried a stock client end-to-end.
 *
 * Usage: bun qualification/linux-loopback.ts --bwrap <path> --bwrap-sha256 <hex>
 *        [--runtime <path>] [--client <path>] [--ip <path>] [--unshare <path>] */
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer as createNetServer, connect as netConnect, type Server as NetServer } from "node:net";
import { createEgressBridge } from "../src/egress-bridge.ts";

if (process.platform !== "linux") throw new Error("REQUIRES_LINUX");
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const bwrap = argument("--bwrap"), bwrapSha256 = argument("--bwrap-sha256");
const runtime = argument("--runtime") ?? process.execPath;
const client = argument("--client") ?? "/usr/bin/curl";
const ipTool = argument("--ip") ?? "/usr/sbin/ip";
const unshareTool = argument("--unshare") ?? "/usr/bin/unshare";
const shTool = "/bin/sh";
const allowed = new Set(["--bwrap", "--bwrap-sha256", "--runtime", "--client", "--ip", "--unshare"]);
for (const flag of process.argv.slice(2)) {
  if (flag.startsWith("-") && !allowed.has(flag)) throw new Error("INVALID_QUALIFICATION_ARGUMENT");
}
if (!bwrap || !bwrapSha256 || !/^[a-f0-9]{64}$/.test(bwrapSha256)) throw new Error("REQUIRES_ADMITTED_BWRAP_ARTIFACT");

/** Shared-library closure of one dynamic executable via `ldd` (absolute paths
 * only; vdso and loader-internal entries without a path are skipped). */
function lddClosure(executable: string): string[] {
  const result = spawnSync("ldd", [executable], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  const paths = new Set<string>();
  for (const match of result.stdout.matchAll(/(?:=>\s*)?(\/[A-Za-z0-9._\/+:-]+)/g)) {
    const candidate = match[1]!;
    if (isAbsolute(candidate)) paths.add(candidate);
  }
  return [...paths].sort();
}

/** The probe exercises the shipped forwarder artifact verbatim — the same
 * file launchers mount — rather than a fixture copy that could drift. */
const FORWARDER_SOURCE = new URL("../sandbox/loopback-forwarder.cjs", import.meta.url);

const root = await realpath(await mkdtemp(join(tmpdir(), "xcb-linux-loopback-")));
let bridge: Awaited<ReturnType<typeof createEgressBridge>> | undefined;
let sServer: ReturnType<typeof Bun.spawn> | undefined;
try {
  const scratch = join(root, "scratch"), runDir = join(root, "runDir");
  await mkdir(scratch, { mode: 0o700 }); await mkdir(runDir, { mode: 0o700 });
  const socketPath = join(runDir, "egress.sock");
  const forwarderPath = join(runDir, "forwarder.js");
  await writeFile(forwarderPath, await readFile(FORWARDER_SOURCE), { mode: 0o444 });
  const outerScript = join(runDir, "outer.sh");
  await writeFile(outerScript, `#!/bin/sh\n"${ipTool}" link set lo up && exec "${bwrap}" "$@"\n`, { mode: 0o500 });

  // Host-side TLS upstream behind the bridge: curl -k reaches it through
  // forwarder → unix socket → bridge → this listener. `openssl s_server` is
  // the endpoint — a stock TLS implementation, deliberately not the runtime
  // under test (Bun's TLSSocket.end(data) writes response bytes unencrypted,
  // which would poison the very tunnel this probe measures). openssl builds
  // a one-day throwaway cert; nothing about it is a secret.
  const key = join(runDir, "key.pem"), cert = join(runDir, "cert.pem");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert,
    "-days", "1", "-nodes", "-subj", "/CN=probe.invalid"], { encoding: "utf8", timeout: 30_000 });
  if (generated.status !== 0) throw new Error("OPENSSL_CERT_UNAVAILABLE");
  // Reserve an ephemeral port by binding then releasing — s_server needs a
  // literal port and the host netns is shared.
  const reserved = await new Promise<number>((ready, failReserve) => {
    const probe: NetServer = createNetServer();
    probe.listen(0, "127.0.0.1", () => { const port = (probe.address() as { port: number }).port; probe.close(() => ready(port)); });
    probe.once("error", failReserve);
  });
  sServer = Bun.spawn(["openssl", "s_server", "-quiet", "-accept", String(reserved),
    "-key", key, "-cert", cert, "-www"], { stdout: "pipe", stderr: "pipe" });
  // Wait until the port accepts before handing it to the bridge dialer.
  for (let attempt = 0; attempt < 50; attempt++) {
    const ready = await new Promise<boolean>((resolvePromise) => {
      const socket = netConnect({ host: "127.0.0.1", port: reserved });
      socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
      socket.once("error", () => resolvePromise(false));
    });
    if (ready) break;
    if (attempt === 49) throw new Error("OPENSSL_S_SERVER_UNAVAILABLE");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const tlsPort = reserved;
  bridge = await createEgressBridge({ socketPath, allowlist: ["probe.invalid"],
    dialer: { connect: () => new Promise((resolvePromise, reject) => {
      const socket = netConnect({ host: "127.0.0.1", port: tlsPort });
      socket.once("connect", () => resolvePromise(socket)); socket.once("error", reject);
    }) } });

  async function run(argv: string[], timeout: number) {
    const child = Bun.spawn(argv, { cwd: root, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout });
    // Watchdog independent of Bun's spawn timeout: if SIGTERM inside the
    // deadline fails to reap the namespace tree, escalate to SIGKILL.
    const watchdog = setTimeout(() => child.kill("SIGKILL"), timeout + 10_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 4096) };
    } finally { clearTimeout(watchdog); }
  }
  const progress = (mark: string) => console.error(`loopback: ${mark}`);

  const runtimeLibs = lddClosure(runtime), clientLibs = lddClosure(client), ipLibs = lddClosure(ipTool);
  const bind = (target: string, mode: "--ro-bind" | "--bind") => [mode, target, target];
  const mounts = [
    ...bind(runtime, "--ro-bind"), ...runtimeLibs.flatMap(p => bind(p, "--ro-bind")),
    ...bind(forwarderPath, "--ro-bind"),
    ...bind(client, "--ro-bind"), ...clientLibs.flatMap(p => bind(p, "--ro-bind")),
    ...bind(ipTool, "--ro-bind"), ...ipLibs.flatMap(p => bind(p, "--ro-bind")),
    ...bind(scratch, "--bind"), ...bind(socketPath, "--bind"),
  ];
  const innerArgs = (shareNet: boolean, capAdd: boolean, loUpPath: string) => [
    "--unshare-all", ...(shareNet ? ["--share-net"] : []), ...(capAdd ? ["--cap-add", "CAP_NET_ADMIN"] : []),
    "--new-session", "--die-with-parent", "--proc", "/proc", "--dev", "/dev",
    "--ro-bind", "/sys/class/net", "/sys/class/net",
    ...mounts, "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", scratch,
    "--chdir", scratch, "--",
    runtime, forwarderPath, socketPath, "48123", loUpPath, "-", "--",
    client, "-skvx", "http://127.0.0.1:48123", "--max-time", "10", "https://probe.invalid/",
  ];

  const phases: Record<string, unknown> = {};
  // M0: no mechanism at all — reports whether bwrap's own loopback setup left
  // lo up inside the namespace (bwrap ≥ 0.8 attempts it on --unshare-net).
  const m0 = await run([bwrap, ...innerArgs(false, false, "-")], 45_000);
  phases.M0_prepared = { code: m0.code, stdout: m0.stdout, stderr: m0.stderr };
  progress(`M0 exit ${m0.code}`);
  const m1 = await run([bwrap, ...innerArgs(false, true, ipTool)], 45_000);
  phases.M1_capAdd = { code: m1.code, stdout: m1.stdout, stderr: m1.stderr };
  progress(`M1 exit ${m1.code}`);
  const m2 = await run([unshareTool, "--user", "--map-root-user", "--net", shTool, outerScript,
    ...innerArgs(true, false, "-")], 45_000);
  phases.M2_preUp = { code: m2.code, stdout: m2.stdout, stderr: m2.stderr };
  progress(`M2 exit ${m2.code}`);

  const bounded = <T>(work: Promise<T>, ms: number, fallback: T) =>
    Promise.race([work, new Promise<T>((resolvePromise) => setTimeout(() => resolvePromise(fallback), ms))]);
  progress("bridge closing");
  const receipt = await bounded(bridge.close(), 15_000,
    { socketPath, productionQualified: false as const, connectionsAccepted: -1, connectionsRefused: -1,
      bytesIn: -1, bytesOut: -1, listenerClosed: false, socketsJoined: false, socketRemoved: false });
  bridge = undefined;
  progress("bridge closed");
  // Exit 0 plus a response body through the tunnel is the assertion: the only
  // listener behind the allowlisted target is our s_server.
  const passed = (phase: { code: number; stdout: string }) => phase.code === 0 && phase.stdout.length > 0;
  console.log(JSON.stringify({ profile: "experimental-linux-loopback-forwarder", blocked: false,
    productionQualificationIssued: false, paidModelRequests: 0,
    runtime, runtimeLibs: runtimeLibs.length, clientLibs: clientLibs.length,
    phases, M0_passed: passed(m0), M1_passed: passed(m1), M2_passed: passed(m2),
    bridge: { accepted: receipt.connectionsAccepted, refused: receipt.connectionsRefused,
      listenerClosed: receipt.listenerClosed, socketsJoined: receipt.socketsJoined, socketRemoved: receipt.socketRemoved } }, null, 2));
  if (!(passed(m0) || passed(m1) || passed(m2)) || !(receipt.listenerClosed && receipt.socketsJoined && receipt.socketRemoved)) process.exitCode = 1;
} finally {
  sServer?.kill("SIGKILL");
  await bridge?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
