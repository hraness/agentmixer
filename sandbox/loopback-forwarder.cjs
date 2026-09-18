"use strict";
/** In-namespace loopback CONNECT forwarder — the stock-binary consumption
 * half of `provider-tcp443-dns`. Runs inside the bwrap network namespace on a
 * mounted JS runtime (node or bun); it is not a launcher and holds no
 * credentials.
 *
 *   <runtime> loopback-forwarder.cjs <bridge-socket> <port> <lo-up-cmd|-> <env-file|-> -- <child argv...>
 *
 * It listens on 127.0.0.1:<port>, accepts only `CONNECT host:443`, forwards
 * each request verbatim onto the mounted host bridge unix socket, relays the
 * bridge's response head, then pipes both directions. The child is spawned
 * with standard proxy variables pointing at the forwarder, so a stock binary
 * (curl, a provider CLI) reaches providers through the bridge with no DNS or
 * direct TCP inside the namespace. `lo-up-cmd` is a diagnostic escape hatch:
 * an absolute path to `ip` runs `ip link set lo up` first; `-` skips (bwrap
 * raises loopback itself on --unshare-net).
 *
 * `env-file` is the secret channel: bwrap `--setenv` values are visible in
 * the wrapper's own argv, so the host writes `KEY=VALUE` pairs into a
 * private file inside the writable scratch instead. The forwarder reads,
 * validates, and deletes it before spawning, injecting the pairs only into
 * the child's environment; proxy variables are forwarder-owned and always
 * win over file entries.
 *
 * Diagnostics go to stderr as `FWD key=json` lines; the child's stdio is
 * inherited verbatim. Exit status is the child's. */
const net = require("node:net");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

const [, , socketPath, portText, loUpPath, envFilePath, separator, ...childArgv] = process.argv;
if (typeof socketPath !== "string" || !socketPath.startsWith("/")
  || !/^[0-9]+$/.test(portText ?? "") || separator !== "--" || childArgv.length === 0) {
  fs.writeSync(2, "FWD usage=<bridge-socket> <port> <lo-up-cmd|-> <env-file|-> -- <child argv...>\n");
  process.exit(2);
}
const report = (key, value) => { try { fs.writeSync(2, "FWD " + key + "=" + JSON.stringify(value) + "\n"); } catch {} };
const status = (() => { try { return fs.readFileSync("/proc/self/status", "utf8"); } catch { return ""; } })();
report("capEff", (/CapEff:\s*([0-9a-f]+)/i.exec(status) || [])[1] ?? null);
report("loOperstate", (() => { try { return fs.readFileSync("/sys/class/net/lo/operstate", "utf8").trim(); } catch { return null; } })());
report("loFlags", (() => { try { return fs.readFileSync("/sys/class/net/lo/flags", "utf8").trim(); } catch { return null; } })());
if (loUpPath !== "-") {
  const raised = spawnSync(loUpPath, ["link", "set", "lo", "up"], { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
  report("loUpStatus", raised.status);
  report("loUpError", raised.error ? String(raised.error.code || raised.error) : null);
  report("loUpStderr", (raised.stderr || "").toString().slice(0, 200));
}

// Secret channel: bounded KEY=VALUE lines the host left inside the writable
// scratch. The file is deleted before the child spawns whether parsing
// succeeds or not — never log its contents.
const PROXY_KEYS = new Set(["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"]);
const fileEnv = Object.create(null);
if (envFilePath !== "-") {
  let text;
  try { text = fs.readFileSync(envFilePath, "utf8"); }
  catch (error) { report("envFileError", String(error && error.code || error)); process.exit(1); }
  try { fs.unlinkSync(envFilePath); } catch {}
  if (Buffer.byteLength(text) > 64 * 1024) { report("envFileError", "limit"); process.exit(1); }
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const eq = line.indexOf("=");
    const key = eq === -1 ? "" : line.slice(0, eq);
    const value = eq === -1 ? "" : line.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || PROXY_KEYS.has(key) || value.includes("\0")) {
      report("envFileError", "invalid"); process.exit(1);
    }
    fileEnv[key] = value;
  }
}

const port = Number(portText);
const server = net.createServer((inbound) => {
  // A raced write into a closing peer must never take the supervisor down —
  // both sockets carry their own error path.
  inbound.on("error", () => {});
  let head = Buffer.alloc(0);
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) { if (head.length > 4096) inbound.destroy(); return; }
    // Consume exactly one head: leaving this listener attached would re-run
    // CONNECT handling for every tunneled byte (a ClientHello would spawn a
    // second bridge connection and inject a second "200" into the TLS stream).
    inbound.removeListener("data", onData);
    const request = head.subarray(0, end).toString("latin1").split("\r\n")[0];
    const match = /^CONNECT ([A-Za-z0-9._-]+):443 HTTP\/1\.[01]$/.exec(request);
    inbound.pause();
    if (match === null) { report("refused", request.slice(0, 120)); inbound.destroy(); return; }
    const upstream = net.createConnection(socketPath, () => {
      upstream.on("error", () => {});
      upstream.write(head.subarray(0, end + 4));
      const clientExtra = head.subarray(end + 4);
      let replyHead = Buffer.alloc(0);
      const onReply = (replyChunk) => {
        replyHead = Buffer.concat([replyHead, replyChunk]);
        const replyEnd = replyHead.indexOf("\r\n\r\n");
        if (replyEnd === -1) { if (replyHead.length > 4096) { upstream.destroy(); inbound.destroy(); } return; }
        upstream.removeListener("data", onReply);
        inbound.write(replyHead.subarray(0, replyEnd + 4));
        // Reply-head tail belongs to the client; the client's own post-head
        // bytes belong upstream. Keep the two directions separate.
        const bridgeExtra = replyHead.subarray(replyEnd + 4);
        if (bridgeExtra.length) inbound.write(bridgeExtra);
        if (clientExtra.length) upstream.write(clientExtra);
        upstream.pipe(inbound);
        inbound.pipe(upstream);
        inbound.resume();
      };
      upstream.on("data", onReply);
    });
    upstream.once("error", () => inbound.destroy());
    inbound.once("close", () => upstream.destroy());
  };
  inbound.on("data", onData);
});
server.listen(port, "127.0.0.1", () => {
  report("listening", server.address());
  const proxy = "http://127.0.0.1:" + port;
  const env = { ...process.env, ...fileEnv,
    http_proxy: proxy, HTTP_PROXY: proxy, https_proxy: proxy, HTTPS_PROXY: proxy,
    all_proxy: proxy, ALL_PROXY: proxy, no_proxy: "", NO_PROXY: "" };
  const child = spawn(childArgv[0], childArgv.slice(1), { stdio: "inherit", env });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => { report("childExit", { code, signal }); process.exit(code ?? 1); });
  child.on("error", (error) => { report("childError", String(error)); process.exit(1); });
});
server.on("error", (error) => { report("listenError", String(error && error.code || error)); process.exit(1); });
