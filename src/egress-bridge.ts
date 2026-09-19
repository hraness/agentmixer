import { chmod, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { object } from "./validation.ts";
import { assertPrivateDirectory, canonicalizePrivatePath } from "./private-file.ts";

/** Host-side unix-socket CONNECT bridge for a sandboxed provider process.
 * The kernel boundary never sees sandboxed DNS or TCP: a bwrap plan keeps the
 * network namespace unshared and bind-mounts this socket, and the in-sandbox
 * runtime speaks `CONNECT host:443` over the unix stream. The bridge owns
 * resolution and dialing through the supplied host seam; nothing in this
 * module qualifies an egress path for production — receipts stay
 * `productionQualified: false`. */

const MAX_HANDSHAKE_BYTES = 4 * 1024;
const HANDSHAKE_MS = 5_000;
const MAX_CONNECTIONS = 64;
const IDLE_MS = 30_000;
const MAX_HOST_BYTES = 253;

/** The only network authority the bridge uses; supplied by the trusted host. */
export interface EgressBridgeDialer {
  connect(host: string, port: number): Promise<Duplex>;
}
export type EgressBridgeOptions = Readonly<{
  /** Canonical absolute socket path inside a private 0700 directory. */
  socketPath: string;
  /** Exact hostnames admitted for CONNECT; absent admits any host on :443,
   * matching the seatbelt `remote tcp "*:443"` candidate semantics. */
  allowlist?: readonly string[];
  maxConnections?: number;
  idleTimeoutMs?: number;
  dialer: EgressBridgeDialer;
}>;
export type EgressBridgeReceipt = Readonly<{
  socketPath: string; productionQualified: false;
  connectionsAccepted: number; connectionsRefused: number; bytesIn: number; bytesOut: number;
  listenerClosed: boolean; socketsJoined: boolean; socketRemoved: boolean;
}>;
export interface EgressBridge {
  readonly socketPath: string;
  readonly connections: number;
  close(): Promise<EgressBridgeReceipt>;
}

function fail(code: string): never { throw new Error(code); }
function assert(value: unknown, code: string): asserts value { if (!value) fail(code); }
function path(value: unknown): string {
  return canonicalizePrivatePath(value, { code: "EGRESS_BRIDGE_PATH_INVALID" });
}
function hostname(value: unknown): string {
  assert(typeof value === "string", "EGRESS_BRIDGE_HOST_INVALID");
  const lowered = value.toLowerCase();
  assert(lowered.length > 0 && Buffer.byteLength(lowered) <= MAX_HOST_BYTES
    && /^[a-z0-9._:\[\]-]+$/u.test(lowered), "EGRESS_BRIDGE_HOST_INVALID");
  return lowered;
}
async function privateDirectory(value: string): Promise<void> {
  await assertPrivateDirectory(value, { code: "EGRESS_BRIDGE_DIRECTORY_PRIVATE", owner: "selfOrThrow", mode: "perms", metadataFirst: true });
}

/** Default dialer for the real host seam: a bounded plain TCP connect whose
 * resolver runs host-side. The in-sandbox process never performs DNS. */
export const egressBridgeDialer: EgressBridgeDialer = Object.freeze({
  connect(host: string, port: number) {
    return new Promise<Duplex>((resolvePromise, reject) => {
      const socket = netConnect({ host, port, timeout: 15_000 });
      socket.once("connect", () => { socket.setTimeout(0); resolvePromise(socket); });
      socket.once("timeout", () => { socket.destroy(); reject(fail("EGRESS_BRIDGE_DIAL_TIMEOUT")); });
      socket.once("error", () => { socket.destroy(); reject(fail("EGRESS_BRIDGE_DIAL_FAILED")); });
    });
  },
});

/** Parse one `CONNECT <host>:<port> HTTP/1.x` head. Anything else is refused;
 * CONNECT is the only method this bridge speaks. */
function parseHandshake(head: string): { host: string; port: number } {
  const request = head.split("\r\n")[0] ?? "";
  const match = /^CONNECT ([A-Za-z0-9._:\[\]-]+) HTTP\/1\.[01]$/u.exec(request);
  assert(match !== null, "EGRESS_BRIDGE_METHOD_UNSUPPORTED");
  const authority = match[1]!;
  const split = authority.startsWith("[")
    ? (() => { const end = authority.indexOf("]:"); return end === -1 ? [authority, ""] : [authority.slice(0, end + 1), authority.slice(end + 2)]; })()
    : authority.split(":", 2);
  assert(split.length === 2, "EGRESS_BRIDGE_AUTHORITY_INVALID");
  const host = hostname(split[0]), port = Number(split[1]);
  assert(Number.isSafeInteger(port) && port === 443, "EGRESS_BRIDGE_PORT_UNSUPPORTED");
  return { host, port };
}

export async function createEgressBridge(options: EgressBridgeOptions): Promise<EgressBridge> {
  const raw = object(options, ["socketPath", "allowlist", "maxConnections", "idleTimeoutMs", "dialer"]);
  const socketPath = path(raw.socketPath);
  const allowlist = raw.allowlist === undefined ? undefined : (() => {
    assert(Array.isArray(raw.allowlist) && raw.allowlist.length <= 256, "EGRESS_BRIDGE_ALLOWLIST_INVALID");
    return new Set((raw.allowlist as unknown[]).map(entry => hostname(entry)));
  })();
  assert(raw.dialer !== null && typeof raw.dialer === "object" && typeof (raw.dialer as EgressBridgeDialer).connect === "function", "EGRESS_BRIDGE_DIALER_INVALID");
  const dialer = raw.dialer as EgressBridgeDialer;
  const maxConnections = raw.maxConnections === undefined ? MAX_CONNECTIONS
    : (assert(typeof raw.maxConnections === "number" && Number.isSafeInteger(raw.maxConnections) && raw.maxConnections >= 1 && raw.maxConnections <= MAX_CONNECTIONS, "EGRESS_BRIDGE_LIMIT_INVALID"), raw.maxConnections);
  const idleMs = raw.idleTimeoutMs === undefined ? IDLE_MS
    : (assert(typeof raw.idleTimeoutMs === "number" && Number.isSafeInteger(raw.idleTimeoutMs) && raw.idleTimeoutMs >= 1_000 && raw.idleTimeoutMs <= 300_000, "EGRESS_BRIDGE_LIMIT_INVALID"), raw.idleTimeoutMs);
  await privateDirectory(dirname(socketPath));
  assert((await lstat(socketPath).catch(() => null)) === null, "EGRESS_BRIDGE_SOCKET_EXISTS");

  const sockets = new Set<Socket>();
  let accepted = 0, refused = 0, bytesIn = 0, bytesOut = 0, closing = false;
  const server: Server = createServer({ allowHalfOpen: false }, inbound => {
    if (closing || sockets.size >= maxConnections) { refused++; inbound.destroy(); return; }
    sockets.add(inbound); inbound.setNoDelay(true);
    let head = Buffer.alloc(0), upstream: Duplex | undefined, joined = false;
    let idle = setTimeout(() => { refused++; settle(); }, idleMs); idle.unref();
    const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => { settle(); }, idleMs); idle.unref(); };
    const settle = () => { if (!joined) { joined = true; clearTimeout(idle); sockets.delete(inbound); upstream?.destroy(); inbound.destroy(); } };
    inbound.once("close", () => settle());
    inbound.once("error", () => settle());
    inbound.on("data", chunk => {
      bytesIn += chunk.length; armIdle();
      if (upstream !== undefined) { upstream.write(chunk, () => undefined); return; }
      head = Buffer.concat([head, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (head.length > MAX_HANDSHAKE_BYTES) { refused++; settle(); return; }
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      const extra = head.subarray(end + 4);
      inbound.pause();
      let target: { host: string; port: number };
      try { target = parseHandshake(head.subarray(0, end).toString("latin1")); }
      catch { refused++; inbound.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n", () => settle()); return; }
      if (allowlist !== undefined && !allowlist.has(target.host)) {
        refused++; inbound.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n", () => settle()); return;
      }
      void dialer.connect(target.host, target.port).then(socket => {
        if (closing || joined) { socket.destroy(); return; }
        upstream = socket; accepted++;
        socket.once("error", () => settle()); socket.once("close", () => settle());
        socket.on("data", reply => { bytesOut += reply.length; armIdle(); if (!inbound.destroyed) inbound.write(reply, () => undefined); });
        inbound.resume();
        inbound.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => { if (extra.length) upstream?.write(extra, () => undefined); });
      }, () => { refused++; inbound.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n", () => settle()); });
    });
    setTimeout(() => { if (!joined && upstream === undefined) { refused++; settle(); } }, HANDSHAKE_MS).unref();
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", () => reject(fail("EGRESS_BRIDGE_LISTEN_FAILED")));
    server.listen(socketPath, () => resolvePromise());
  });
  await chmod(socketPath, 0o600);

  return Object.freeze({
    socketPath,
    get connections() { return sockets.size; },
    async close(): Promise<EgressBridgeReceipt> {
      closing = true;
      // `closed` can flag synchronously while `close` still dispatches later;
      // attach the waiter before destroying so the join cannot race it.
      const waits = [...sockets].map(socket => socket.destroyed
        ? Promise.resolve()
        : new Promise<void>(done => socket.once("close", () => done())));
      for (const socket of [...sockets]) socket.destroy();
      const joined = await Promise.race([
        Promise.all(waits).then(async () => {
          // A socket flagged `destroyed` skips its waiter while its `close`
          // dispatch — and settle()'s removal — is still pending; drain a tick
          // so the size check cannot read between the flag and the event.
          await new Promise<void>(done => setImmediate(done));
          return sockets.size === 0;
        }),
        new Promise<boolean>(done => setTimeout(() => done(false), HANDSHAKE_MS)),
      ]);
      const listenerClosed = await new Promise<boolean>(done => server.close(() => done(true)));
      // The listener unlinks its own unix path on close; the socket is removed
      // when our unlink lands or the path is already gone.
      const removed = await unlink(socketPath).then(() => true,
        () => lstat(socketPath).then(() => false, () => true));
      return Object.freeze({ socketPath, productionQualified: false as const,
        connectionsAccepted: accepted, connectionsRefused: refused, bytesIn, bytesOut,
        listenerClosed, socketsJoined: joined, socketRemoved: removed });
    },
  });
}
