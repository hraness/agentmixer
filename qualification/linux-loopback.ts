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
import { createServer as createTlsServer } from "node:tls";
import { connect as netConnect } from "node:net";
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

/** In-namespace forwarder source: CONNECT on loopback → the mounted bridge
 * socket, then spawn the child with standard proxy variables. Plain
 * CommonJS-compatible JavaScript so node and bun both execute it verbatim. */
const FORWARDER = String.raw`"use strict";
const net = require("node:net");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const [, , socketPath, portText, ipPath, separator, ...childArgv] = process.argv;
const report = (key, value) => { try { fs.writeSync(2, "FWD " + key + "=" + JSON.stringify(value) + "\n"); } catch {} };
const status = (() => { try { return fs.readFileSync("/proc/self/status", "utf8"); } catch { return ""; } })();
report("capEff", (/CapEff:\s*([0-9a-f]+)/i.exec(status) || [])[1] ?? null);
if (ipPath !== "-") {
  const raised = spawnSync(ipPath, ["link", "set", "lo", "up"], { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
  report("loUpStatus", raised.status);
  report("loUpError", raised.error ? String(raised.error.code || raised.error) : null);
  report("loUpStderr", (raised.stderr || "").toString().slice(0, 200));
}
const port = Number(portText);
const server = net.createServer((inbound) => {
  let head = Buffer.alloc(0);
  inbound.on("data", (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) { if (head.length > 4096) inbound.destroy(); return; }
    const request = head.subarray(0, end).toString("latin1").split("\r\n")[0];
    const match = /^CONNECT ([A-Za-z0-9._-]+):443 HTTP\/1\.[01]$/.exec(request);
    inbound.pause();
    if (match === null) { report("refused", request.slice(0, 120)); inbound.destroy(); return; }
    const upstream = net.createConnection(socketPath, () => {
      upstream.write(head.subarray(0, end + 4));
      const extra = head.subarray(end + 4);
      let replyHead = Buffer.alloc(0);
      const onReply = (chunk) => {
        replyHead = Buffer.concat([replyHead, chunk]);
        const replyEnd = replyHead.indexOf("\r\n\r\n");
        if (replyEnd === -1) { if (replyHead.length > 4096) { upstream.destroy(); inbound.destroy(); } return; }
        upstream.removeListener("data", onReply);
        inbound.write(replyHead.subarray(0, replyEnd + 4));
        const replyExtra = Buffer.concat([replyHead.subarray(replyEnd + 4), extra]);
        if (replyExtra.length) upstream.write(replyExtra);
        upstream.pipe(inbound); inbound.pipe(upstream);
        inbound.resume();
      };
      upstream.on("data", onReply);
    });
    upstream.once("error", () => inbound.destroy());
  });
});
server.listen(port, "127.0.0.1", () => {
  report("listening", server.address());
  const env = { ...process.env,
    http_proxy: "http://127.0.0.1:" + port, HTTP_PROXY: "http://127.0.0.1:" + port,
    https_proxy: "http://127.0.0.1:" + port, HTTPS_PROXY: "http://127.0.0.1:" + port,
    all_proxy: "http://127.0.0.1:" + port, ALL_PROXY: "http://127.0.0.1:" + port,
    no_proxy: "", NO_PROXY: "" };
  const child = spawn(childArgv[0], childArgv.slice(1), { stdio: "inherit", env });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => { report("childExit", { code, signal }); process.exit(code ?? 1); });
  child.on("error", (error) => { report("childError", String(error)); process.exit(1); });
});
server.on("error", (error) => { report("listenError", String(error && error.code || error)); process.exit(1); });
`;

const root = await realpath(await mkdtemp(join(tmpdir(), "agentmixer-linux-loopback-")));
let bridge: Awaited<ReturnType<typeof createEgressBridge>> | undefined;
try {
  const scratch = join(root, "scratch"), runDir = join(root, "runDir");
  await mkdir(scratch, { mode: 0o700 }); await mkdir(runDir, { mode: 0o700 });
  const socketPath = join(runDir, "egress.sock");
  const forwarderPath = join(runDir, "forwarder.js");
  await writeFile(forwarderPath, FORWARDER, { mode: 0o444 });
  const outerScript = join(runDir, "outer.sh");
  await writeFile(outerScript, `#!/bin/sh\n"${ipTool}" link set lo up && exec "${bwrap}" "$@"\n`, { mode: 0o500 });

  // Host-side TLS upstream behind the bridge: curl -k reaches it through
  // forwarder → unix socket → bridge → this listener. openssl builds a
  // one-day throwaway cert; nothing about it is a secret.
  const key = join(runDir, "key.pem"), cert = join(runDir, "cert.pem");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert,
    "-days", "1", "-nodes", "-subj", "/CN=probe.invalid"], { encoding: "utf8", timeout: 30_000 });
  if (generated.status !== 0) throw new Error("OPENSSL_CERT_UNAVAILABLE");
  const tlsServer = createTlsServer({ key: await readFile(key), cert: await readFile(cert) },
    (socket) => { socket.end("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nLOOPBACK-OK"); });
  await new Promise<void>((ready) => tlsServer.listen(0, "127.0.0.1", ready));
  const tlsPort = (tlsServer.address() as { port: number }).port;
  bridge = await createEgressBridge({ socketPath, allowlist: ["probe.invalid"],
    dialer: { connect: () => new Promise((resolvePromise, reject) => {
      const socket = netConnect({ host: "127.0.0.1", port: tlsPort });
      socket.once("connect", () => resolvePromise(socket)); socket.once("error", reject);
    }) } });

  async function run(argv: string[], timeout: number) {
    const child = Bun.spawn(argv, { cwd: root, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 4096) };
  }

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
    ...mounts, "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", scratch,
    "--chdir", scratch, "--",
    runtime, forwarderPath, socketPath, "48123", loUpPath, "--",
    client, "-skx", "http://127.0.0.1:48123", "--max-time", "10", "https://probe.invalid/",
  ];

  const phases: Record<string, unknown> = {};
  const m1 = await run([bwrap, ...innerArgs(false, true, ipTool)], 60_000);
  phases.M1_capAdd = { code: m1.code, stdout: m1.stdout, stderr: m1.stderr };
  const m2 = await run([unshareTool, "--user", "--map-root-user", "--net", shTool, outerScript,
    ...innerArgs(true, false, "-")], 60_000);
  phases.M2_preUp = { code: m2.code, stdout: m2.stdout, stderr: m2.stderr };

  const receipt = await bridge.close(); bridge = undefined;
  await new Promise<void>((done) => tlsServer.close(() => done()));
  const passed = (phase: { code: number; stdout: string }) => phase.code === 0 && phase.stdout.includes("LOOPBACK-OK");
  console.log(JSON.stringify({ profile: "experimental-linux-loopback-forwarder", blocked: false,
    productionQualificationIssued: false, paidModelRequests: 0,
    runtime, runtimeLibs: runtimeLibs.length, clientLibs: clientLibs.length,
    phases, M1_passed: passed(m1), M2_passed: passed(m2),
    bridge: { accepted: receipt.connectionsAccepted, refused: receipt.connectionsRefused,
      listenerClosed: receipt.listenerClosed, socketsJoined: receipt.socketsJoined, socketRemoved: receipt.socketRemoved } }, null, 2));
  if (!(passed(m1) || passed(m2)) || !(receipt.listenerClosed && receipt.socketsJoined && receipt.socketRemoved)) process.exitCode = 1;
} finally {
  await bridge?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
