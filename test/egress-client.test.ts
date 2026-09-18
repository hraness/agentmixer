import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { TLSSocket } from "node:tls";
import { createEgressBridge, type EgressBridge, type EgressBridgeDialer } from "../src/egress-bridge.ts";
import {
  EGRESS_SOCKET_ENV, connectEgress, connectEgressTls, createEgressHttpsAgent,
  egressSocketFromEnv, fetchViaEgress,
} from "../src/egress-client.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xcb-egress-client-test-")));
  const socketPath = join(root, "egress.sock");
  return { root, socketPath, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

/** Upstream that replies with a canned response per CONNECT, in call order.
 * A PassThrough is symmetric — client bytes written in would echo back — so
 * the fake is a one-way Duplex: `_write` records the tunneled request, the
 * canned reply is pushed once the request head arrives. */
function cannedDialer(responses: string[]) {
  const calls: string[] = [];
  const dialer: EgressBridgeDialer = {
    connect(host) {
      calls.push(host);
      const index = calls.length - 1;
      let received = "", responded = false;
      const stream = new Duplex({
        write(chunk, _encoding, callback) {
          received += chunk.toString("latin1");
          if (!responded && received.includes("\r\n\r\n")) {
            responded = true;
            stream.push(responses[index] ?? responses[responses.length - 1]!);
            stream.push(null);
          }
          callback();
        },
        read() {},
      });
      return Promise.resolve(stream);
    },
  };
  return { dialer, calls };
}

describe("egressSocketFromEnv", () => {
  test("absent returns null; malformed values fail closed", () => {
    expect(egressSocketFromEnv({})).toBeNull();
    expect(egressSocketFromEnv({ [EGRESS_SOCKET_ENV]: "/abs/egress.sock" })).toBe("/abs/egress.sock");
    expect(() => egressSocketFromEnv({ [EGRESS_SOCKET_ENV]: "relative/sock" })).toThrow("EGRESS_CLIENT_SOCKET_INVALID");
    expect(() => egressSocketFromEnv({ [EGRESS_SOCKET_ENV]: "/abs/bad\tsock" })).toThrow("EGRESS_CLIENT_SOCKET_INVALID");
  });
});

describe("connectEgress", () => {
  test("speaks CONNECT host:443 and returns the tunneled socket", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer, calls } = cannedDialer(["upstream-token"]);
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      const socket = await connectEgress("API.Example.COM", { socketPath: f.socketPath });
      expect(calls).toEqual(["api.example.com"]);
      // Only post-handshake bytes reach the upstream; send a tunneled request
      // and expect the canned reply back over the same socket.
      const chunk = new Promise<Buffer>((done, reject) => {
        socket.once("data", done); socket.once("error", reject);
      });
      socket.write("PING\r\n\r\n");
      expect((await chunk).toString("latin1")).toContain("upstream-token");
      socket.destroy();
      const receipt = await bridge.close(); bridge = undefined;
      expect(receipt.connectionsAccepted).toBe(1);
    } finally { await bridge?.close(); await f.cleanup(); }
  });
  test("surfaces allowlist refusal and a missing socket as typed errors", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer } = cannedDialer([]);
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer, allowlist: ["allowed.example"] });
      await expect(connectEgress("denied.example", { socketPath: f.socketPath })).rejects.toThrow("EGRESS_CLIENT_REFUSED_403");
      await bridge.close(); bridge = undefined;
      await expect(connectEgress("allowed.example", { socketPath: f.socketPath })).rejects.toThrow("EGRESS_CLIENT_SOCKET_FAILED");
    } finally { await bridge?.close(); await f.cleanup(); }
  });
  test("fails closed without the env contract or an explicit path", async () => {
    const saved = process.env[EGRESS_SOCKET_ENV];
    delete process.env[EGRESS_SOCKET_ENV];
    try {
      await expect(connectEgress("api.example.com")).rejects.toThrow("EGRESS_CLIENT_SOCKET_ABSENT");
      await expect(connectEgress("bad host", { socketPath: "/tmp/x.sock" })).rejects.toThrow("EGRESS_CLIENT_HOST_INVALID");
    } finally { if (saved !== undefined) process.env[EGRESS_SOCKET_ENV] = saved; }
  });
});

describe("connectEgressTls / agent", () => {
  test("wraps the tunnel in a TLSSocket with the CONNECT host as SNI", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer, calls } = cannedDialer(["x"]);
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      const tls = await connectEgressTls("api.example.com", { socketPath: f.socketPath, rejectUnauthorized: false });
      expect(tls).toBeInstanceOf(TLSSocket);
      expect(calls).toEqual(["api.example.com"]);
      tls.destroy();
    } finally { await bridge?.close(); await f.cleanup(); }
  });
  test("the https agent creates tunnel sockets and refuses non-443 origins", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer, calls } = cannedDialer(["x"]);
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      const agent = createEgressHttpsAgent({ socketPath: f.socketPath });
      const socket = await new Promise<Duplex>((done, reject) => {
        (agent.createConnection as (o: object, cb: (e: Error | null, s?: Duplex) => void) => void)(
          { host: "api.example.com", port: 443, servername: "api.example.com" }, (error, value) => error ? reject(error) : done(value!));
      });
      expect(socket).toBeInstanceOf(TLSSocket);
      expect(calls).toEqual(["api.example.com"]);
      socket.destroy();
      await new Promise<void>(done => {
        (agent.createConnection as (o: object, cb: (e: Error | null) => void) => void)(
          { host: "api.example.com", port: 80 }, error => { expect((error as Error).message).toBe("EGRESS_CLIENT_PORT_UNSUPPORTED"); done(); });
      });
      agent.destroy();
    } finally { await bridge?.close(); await f.cleanup(); }
  });
});

describe("fetchViaEgress", () => {
  const plain = (socketPath: string) => (host: string, options: { socketPath: string; timeoutMs: number }) =>
    connectEgress(host, { socketPath, timeoutMs: options.timeoutMs });
  test("issues an HTTP/1.1 request over the tunnel and parses the response", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer, calls } = cannedDialer(["HTTP/1.1 200 OK\r\nContent-Length: 5\r\nX-Marker: yes\r\n\r\nHELLO"]);
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      const response = await fetchViaEgress("https://api.example.com/v1?q=1", { socketPath: f.socketPath, transport: plain(f.socketPath) });
      expect(response.status).toBe(200);
      expect(response.text()).toBe("HELLO");
      expect(response.headers["x-marker"]).toEqual(["yes"]);
      expect(calls).toEqual(["api.example.com"]);
    } finally { await bridge?.close(); await f.cleanup(); }
  });
  test("decodes chunked bodies and follows a redirect to a second host", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer, calls } = cannedDialer([
        "HTTP/1.1 302 Found\r\nLocation: https://other.example/final\r\nContent-Length: 0\r\n\r\n",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nPART\r\n2\r\n-1\r\n0\r\n\r\n",
      ]);
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      const response = await fetchViaEgress("https://api.example.com/start", { socketPath: f.socketPath, transport: plain(f.socketPath) });
      expect(response.status).toBe(200);
      expect(response.text()).toBe("PART-1");
      expect(calls).toEqual(["api.example.com", "other.example"]);
    } finally { await bridge?.close(); await f.cleanup(); }
  });
  test("refuses non-443 or non-https URLs and oversized bodies", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      const { dialer } = cannedDialer(["HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\n"]);
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      await expect(fetchViaEgress("http://api.example.com/", { socketPath: f.socketPath })).rejects.toThrow("EGRESS_CLIENT_URL_UNSUPPORTED");
      await expect(fetchViaEgress("https://api.example.com:4443/", { socketPath: f.socketPath })).rejects.toThrow("EGRESS_CLIENT_URL_UNSUPPORTED");
      await expect(fetchViaEgress("https://api.example.com/", { socketPath: f.socketPath, transport: plain(f.socketPath), maxBodyBytes: 8 }))
        .rejects.toThrow("EGRESS_CLIENT_BODY_OVERSIZE");
    } finally { await bridge?.close(); await f.cleanup(); }
  });
  test("honors an abort signal", async () => {
    const f = await fixture();
    let bridge: EgressBridge | undefined;
    try {
      // The upstream swallows the request and never answers, so only the
      // abort can settle it.
      const dialer: EgressBridgeDialer = { connect: () => Promise.resolve(new Duplex({ write(_c, _e, cb) { cb(); }, read() {} })) };
      bridge = await createEgressBridge({ socketPath: f.socketPath, dialer });
      const controller = new AbortController();
      const pending = fetchViaEgress("https://api.example.com/", { socketPath: f.socketPath, transport: plain(f.socketPath), signal: controller.signal });
      setTimeout(() => controller.abort(), 25);
      await expect(pending).rejects.toThrow("EGRESS_CLIENT_ABORTED");
    } finally { await bridge?.close(); await f.cleanup(); }
  });
});
