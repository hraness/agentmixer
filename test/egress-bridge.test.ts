import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { connect as netConnect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { createEgressBridge, type EgressBridge, type EgressBridgeDialer } from "../src/egress-bridge.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentmixer-egress-test-")));
  const socketPath = join(root, "egress.sock");
  return { root, socketPath,
    async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

/** Connect to the unix socket and exchange one CONNECT handshake. */
function session(socketPath: string, request: string): Promise<{ socket: Socket; response: Promise<string> }> {
  const socket = netConnect(socketPath);
  const response = new Promise<string>((resolve, reject) => {
    let head = "";
    socket.on("data", chunk => { head += chunk.toString("latin1"); if (head.includes("\r\n\r\n")) resolve(head); });
    socket.once("error", reject);
  });
  return new Promise(resolve => socket.once("connect", () => { socket.write(request); resolve({ socket, response }); }));
}

/** Synthetic dialer: returns a controllable Duplex, records the target and
 * every byte the bridge forwards into it. */
function fakeDialer(impl?: (host: string, port: number) => Promise<Duplex>) {
  const calls: { host: string; port: number }[] = [];
  const streams: PassThrough[] = [];
  const received: string[][] = [];
  const dialer: EgressBridgeDialer = {
    connect(host, port) {
      calls.push({ host, port });
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", chunk => chunks.push(chunk.toString("latin1")));
      streams.push(stream); received.push(chunks);
      return impl ? impl(host, port) : Promise.resolve(stream);
    },
  };
  return { dialer, calls, streams, received };
}

describe("egress-bridge admission", () => {
  test("rejects undeclared keys, relative paths and a missing dialer", async () => {
    const f = await fixture();
    try {
      const { dialer } = fakeDialer();
      await expect(createEgressBridge({ socketPath: f.socketPath, dialer, extra: 1 } as never)).rejects.toThrow();
      await expect(createEgressBridge({ socketPath: "relative/sock", dialer })).rejects.toThrow("EGRESS_BRIDGE_PATH_INVALID");
      await expect(createEgressBridge({ socketPath: f.socketPath } as never)).rejects.toThrow("EGRESS_BRIDGE_DIALER_INVALID");
      await expect(createEgressBridge({ socketPath: f.socketPath, dialer: {} as never })).rejects.toThrow("EGRESS_BRIDGE_DIALER_INVALID");
    } finally { await f.cleanup(); }
  });
  test("rejects a non-private or symlinked parent directory", async () => {
    const f = await fixture();
    try {
      const { dialer } = fakeDialer();
      await chmod(f.root, 0o755);
      await expect(createEgressBridge({ socketPath: f.socketPath, dialer })).rejects.toThrow("EGRESS_BRIDGE_DIRECTORY_PRIVATE");
      await chmod(f.root, 0o700);
      const link = join(f.root, "linked");
      await symlink(f.root, link);
      await expect(createEgressBridge({ socketPath: join(link, "egress.sock"), dialer })).rejects.toThrow();
    } finally { await chmod(f.root, 0o700); await f.cleanup(); }
  });
  test("refuses a preexisting socket path and out-of-range limits", async () => {
    const f = await fixture();
    try {
      const { dialer } = fakeDialer();
      const blocker = createServer();
      await new Promise<void>(done => blocker.listen(f.socketPath, done));
      await expect(createEgressBridge({ socketPath: f.socketPath, dialer })).rejects.toThrow("EGRESS_BRIDGE_SOCKET_EXISTS");
      await new Promise<void>(done => blocker.close(() => done()));
      await expect(createEgressBridge({ socketPath: f.socketPath, dialer, maxConnections: 0 })).rejects.toThrow("EGRESS_BRIDGE_LIMIT_INVALID");
      await expect(createEgressBridge({ socketPath: f.socketPath, dialer, maxConnections: 65 })).rejects.toThrow("EGRESS_BRIDGE_LIMIT_INVALID");
      await expect(createEgressBridge({ socketPath: f.socketPath, dialer, idleTimeoutMs: 10 })).rejects.toThrow("EGRESS_BRIDGE_LIMIT_INVALID");
    } finally { await f.cleanup(); }
  });
  test("rejects malformed or oversized allowlists and hostnames", async () => {
    const f = await fixture();
    try {
      const { dialer } = fakeDialer();
      await expect(createEgressBridge({ socketPath: f.socketPath, dialer, allowlist: ["BAD HOST"] })).rejects.toThrow("EGRESS_BRIDGE_HOST_INVALID");
      await expect(createEgressBridge({ socketPath: f.socketPath, dialer, allowlist: Array.from({ length: 300 }, () => "a.example") })).rejects.toThrow("EGRESS_BRIDGE_ALLOWLIST_INVALID");
    } finally { await f.cleanup(); }
  });
});

describe("egress-bridge handshake", () => {
  test("accepts CONNECT host:443, tunnels bytes and reports counters", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer, calls, streams, received } = fakeDialer();
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      const { socket, response } = await session(f.socketPath, "CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com\r\n\r\n");
      expect(await response).toContain("200 Connection Established");
      expect(calls).toEqual([{ host: "api.example.com", port: 443 }]);
      // Upstream → client.
      streams[0]!.write("upstream-bytes");
      await new Promise<void>(done => socket.once("data", chunk => { expect(chunk.toString()).toBe("upstream-bytes"); done(); }));
      // Client → upstream. The PassThrough is symmetric, so `received`
      // captures both directions; the forwarded payload must be present.
      socket.write("client-bytes");
      const deadline = Date.now() + 2_000;
      while (!received[0]?.join("").includes("client-bytes") && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
      expect(received[0]?.join("")).toContain("client-bytes");
      socket.destroy();
      const receipt = await bridge.close(); bridge = undefined;
      expect(receipt.productionQualified).toBe(false);
      expect(receipt.connectionsAccepted).toBe(1);
      expect(receipt.bytesIn).toBeGreaterThan(0);
      expect(receipt.bytesOut).toBeGreaterThan(0);
      expect(receipt.listenerClosed && receipt.socketsJoined && receipt.socketRemoved).toBe(true);
      await expect(lstat(f.socketPath)).rejects.toThrow();
    } finally { await bridge?.close(); await f.cleanup(); }
  });
  test("rejects non-CONNECT methods and malformed authority with 405", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer, calls } = fakeDialer();
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      for (const request of ["GET / HTTP/1.1\r\n\r\n", "CONNECT host:443\r\n\r\n", "CONNECT host HTTP/1.1\r\n\r\n"]) {
        const { socket, response } = await session(f.socketPath, request);
        expect(await response).toContain("405");
        socket.destroy();
      }
      expect(calls).toEqual([]);
      const receipt = await bridge.close(); bridge = undefined;
      expect(receipt.connectionsRefused).toBe(3);
      expect(receipt.connectionsAccepted).toBe(0);
    } finally { await bridge?.close(); await f.cleanup(); }
  });
  test("rejects every port but 443", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer, calls } = fakeDialer();
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      for (const target of ["host:80", "host:4443", "host:0", "host:65536"]) {
        const { socket, response } = await session(f.socketPath, `CONNECT ${target} HTTP/1.1\r\n\r\n`);
        expect(await response).toContain("405");
        socket.destroy();
      }
      expect(calls).toEqual([]);
    } finally { await bridge?.close(); await f.cleanup(); }
  });
  test("enforces the exact-host allowlist with 403 and case normalization", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer, calls } = fakeDialer();
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer, allowlist: ["allowed.example.com"] });
      const denied = await session(f.socketPath, "CONNECT other.example.com:443 HTTP/1.1\r\n\r\n");
      expect(await denied.response).toContain("403");
      denied.socket.destroy();
      expect(calls).toEqual([]);
      // An uppercase CONNECT target normalizes to the lowercased allowlist.
      const admitted = await session(f.socketPath, "CONNECT ALLOWED.example.COM:443 HTTP/1.1\r\n\r\n");
      expect(await admitted.response).toContain("200");
      expect(calls).toEqual([{ host: "allowed.example.com", port: 443 }]);
      admitted.socket.destroy();
    } finally { await bridge?.close(); await f.cleanup(); }
  });
  test("refuses an oversized handshake head", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer } = fakeDialer();
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      const socket = netConnect(f.socketPath);
      await new Promise<void>(done => socket.once("connect", done));
      socket.write(`CONNECT ${"a".repeat(5000)}:443 HTTP/1.1\r\n\r\n`);
      await new Promise<void>(done => socket.once("close", done));
      const receipt = await bridge.close(); bridge = undefined;
      expect(receipt.connectionsRefused).toBe(1);
      expect(receipt.connectionsAccepted).toBe(0);
    } finally { await bridge?.close(); await f.cleanup(); }
  });
  test("answers a dial failure with 502 and counts it refused", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer } = fakeDialer(() => Promise.reject(new Error("dial failed")));
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      const { socket, response } = await session(f.socketPath, "CONNECT unreachable.example:443 HTTP/1.1\r\n\r\n");
      expect(await response).toContain("502");
      socket.destroy();
      const receipt = await bridge.close(); bridge = undefined;
      expect(receipt.connectionsRefused).toBe(1);
    } finally { await bridge?.close(); await f.cleanup(); }
  });
  test("forwards bytes that arrive inside the handshake chunk", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer, received } = fakeDialer();
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      const socket = netConnect(f.socketPath);
      await new Promise<void>(done => socket.once("connect", done));
      socket.write("CONNECT host.example:443 HTTP/1.1\r\n\r\ntunneled");
      // The bytes riding after the head terminator are forwarded upstream.
      const deadline = Date.now() + 2_000;
      while (received[0]?.join("") !== "tunneled" && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
      expect(received[0]?.join("")).toBe("tunneled");
      socket.destroy();
    } finally { await bridge?.close(); await f.cleanup(); }
  });
});

describe("egress-bridge lifecycle", () => {
  test("close joins an active tunnel, closes the listener and removes the socket", async () => {
    const f = await fixture();
    const { dialer, streams } = fakeDialer();
    const bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
    const { socket, response } = await session(f.socketPath, "CONNECT host.example:443 HTTP/1.1\r\n\r\n");
    expect(await response).toContain("200");
    expect(bridge.connections).toBe(1);
    const closing = bridge.close();
    // The inbound socket is destroyed by close; the upstream pair joins too.
    await new Promise<void>(done => socket.once("close", done));
    const receipt = await closing;
    expect(receipt.listenerClosed && receipt.socketsJoined && receipt.socketRemoved).toBe(true);
    expect(streams[0]!.destroyed).toBe(true);
    await expect(lstat(f.socketPath)).rejects.toThrow();
    // New connections are refused after close.
    await expect(new Promise<void>((resolve, reject) => {
      const late = netConnect(f.socketPath);
      late.once("connect", () => { late.destroy(); resolve(); });
      late.once("error", () => reject(new Error("connect refused")));
    })).rejects.toThrow("connect refused");
    await f.cleanup();
  });
  test("a second bridge cannot reuse a live socket path", async () => {
    const f = await fixture();
    const { dialer } = fakeDialer();
    const first = await createEgressBridge({ socketPath: f.socketPath, dialer });
    await expect(createEgressBridge({ socketPath: f.socketPath, dialer })).rejects.toThrow("EGRESS_BRIDGE_SOCKET_EXISTS");
    await first.close();
    const second = await createEgressBridge({ socketPath: f.socketPath, dialer });
    await second.close();
    await f.cleanup();
  });
  test("refuses connections past the connection bound", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer } = fakeDialer(() => new Promise<Duplex>(() => {}));
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer, maxConnections: 1 });
      const held = netConnect(f.socketPath);
      await new Promise<void>(done => held.once("connect", done));
      held.write("CONNECT host.example:443 HTTP/1.1\r\n\r\n");
      await new Promise<void>(done => setTimeout(done, 100));
      const overflow = netConnect(f.socketPath);
      await new Promise<void>(done => overflow.once("close", done));
      expect(bridge.connections).toBe(1);
      held.destroy();
    } finally { await bridge?.close(); await f.cleanup(); }
  });
});
