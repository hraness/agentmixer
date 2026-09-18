import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { Agent as HttpsAgent } from "node:https";
import { isAbsolute } from "node:path";
import type { Duplex } from "node:stream";

/** In-sandbox consumer for the egress-bridge contract — the reverse seam of
 * `egress-bridge.ts`. A confined process reads `XCB_EGRESS_SOCKET`,
 * speaks `CONNECT host:443` over that unix socket, and receives a raw tunnel
 * to layer TLS or HTTP onto. The bridge owns DNS and dialing; this module
 * never resolves names and never opens a direct socket. Works under Node ≥ 20
 * and Bun; no dependencies beyond node: builtins.
 *
 * Nothing here widens the sandbox: if the bridge refuses (allowlist miss,
 * port, malformed head) the failure surfaces as a typed error and the process
 * keeps whatever isolation it already had. */

export const EGRESS_SOCKET_ENV = "XCB_EGRESS_SOCKET";

const MAX_HEAD_BYTES = 8 * 1024;
const MAX_HOST_BYTES = 253;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024 * 1024;

const fail = (code: string): never => { throw new Error(code); };
function assert(value: unknown, code: string): asserts value { if (!value) fail(code); }

function hostname(value: unknown): string {
  assert(typeof value === "string", "EGRESS_CLIENT_HOST_INVALID");
  const lowered = value.toLowerCase();
  assert(lowered.length > 0 && Buffer.byteLength(lowered) <= MAX_HOST_BYTES
    && /^[a-z0-9._:\[\]-]+$/u.test(lowered) && !lowered.includes(".."), "EGRESS_CLIENT_HOST_INVALID");
  return lowered;
}

/** Read the bridge socket path from an environment map (defaults to
 * `process.env`). Absent → null; present but malformed → typed failure. */
export function egressSocketFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const value = env[EGRESS_SOCKET_ENV];
  if (value === undefined) return null;
  assert(isAbsolute(value) && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value), "EGRESS_CLIENT_SOCKET_INVALID");
  return value;
}

export type EgressConnectOptions = Readonly<{
  /** Bridge socket path; defaults to `XCB_EGRESS_SOCKET`. */
  socketPath?: string;
  timeoutMs?: number;
}>;

function optionsOf(options: EgressConnectOptions | undefined): { socketPath: string; timeoutMs: number } {
  const socketPath = options?.socketPath ?? egressSocketFromEnv() ?? fail("EGRESS_CLIENT_SOCKET_ABSENT");
  assert(isAbsolute(socketPath) && socketPath.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(socketPath), "EGRESS_CLIENT_SOCKET_INVALID");
  const timeoutMs = options?.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS
    : (assert(typeof options.timeoutMs === "number" && Number.isSafeInteger(options.timeoutMs)
      && options.timeoutMs >= 250 && options.timeoutMs <= 120_000, "EGRESS_CLIENT_TIMEOUT_INVALID"), options.timeoutMs);
  return { socketPath, timeoutMs };
}

/** One `CONNECT host:443` over the bridge socket. The returned socket is
 * positioned past the `200` head — bytes after it are tunnel traffic. Any
 * non-200 head, timeout, or socket failure destroys the socket and throws. */
export async function connectEgress(host: string, options?: EgressConnectOptions): Promise<Socket> {
  const target = hostname(host), { socketPath, timeoutMs } = optionsOf(options);
  return new Promise<Socket>((resolvePromise, reject) => {
    const socket = netConnect(socketPath);
    let head = Buffer.alloc(0), settled = false;
    const done = (error?: Error | string) => {
      if (settled) return;
      settled = true; socket.removeListener("data", onData); socket.setTimeout(0);
      if (error !== undefined) { socket.destroy(); reject(typeof error === "string" ? new Error(error) : error); return; }
      const rest = head.subarray(head.indexOf("\r\n\r\n") + 4);
      resolvePromise(socket);
      if (rest.length > 0) socket.unshift(rest);
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_HEAD_BYTES) done("EGRESS_CLIENT_HEAD_OVERSIZE");
        return;
      }
      const statusLine = head.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
      const match = /^HTTP\/1\.[01] (\d{3})(?: |$)/u.exec(statusLine);
      if (match === null) { done("EGRESS_CLIENT_REPLY_INVALID"); return; }
      if (match[1] !== "200") { done(`EGRESS_CLIENT_REFUSED_${match[1]}`); return; }
      done();
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.write(`CONNECT ${target}:443 HTTP/1.1\r\nHost: ${target}:443\r\n\r\n`));
    socket.on("data", onData);
    socket.once("timeout", () => done("EGRESS_CLIENT_TIMEOUT"));
    socket.once("error", () => done("EGRESS_CLIENT_SOCKET_FAILED"));
  });
}

/** CONNECT plus a TLS handshake over the tunnel. `servername` defaults to the
 * CONNECT host so SNI and verification match the requested origin. Extra
 * `tls.connect` options (ALPN, ca, checkServerIdentity) pass through. */
export async function connectEgressTls(host: string, options?: EgressConnectOptions & Readonly<{
  alpnProtocols?: readonly string[]; rejectUnauthorized?: boolean;
  ca?: string | readonly string[]; servername?: string;
}>): Promise<TLSSocket> {
  const target = hostname(host);
  const tunnel = await connectEgress(target, options);
  return tlsConnect({
    socket: tunnel, servername: options?.servername ?? target,
    ...(options?.alpnProtocols === undefined ? {} : { ALPNProtocols: [...options.alpnProtocols] }),
    ...(options?.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: options.rejectUnauthorized }),
    ...(options?.ca === undefined ? {} : { ca: [...options.ca] }),
  });
}

type AgentConnectCallback = (error: Error | null, socket?: Duplex) => void;

/** `https.Agent` whose connections arrive over the egress bridge. Plug into
 * `https.request`/`https.get` via `{ agent }`; keepAlive stays off because the
 * bridge meters each CONNECT. Only :443 origins are reachable — the bridge
 * refuses everything else. */
export function createEgressHttpsAgent(options?: EgressConnectOptions): HttpsAgent {
  const connectOptions = optionsOf(options);
  const agent = new HttpsAgent({ keepAlive: false });
  agent.createConnection = ((connection: { host?: string; port?: number; servername?: string }, callback: AgentConnectCallback) => {
    const host = hostname(typeof connection.servername === "string" && connection.servername.length > 0
      ? connection.servername : String(connection.host ?? "").split(":")[0]);
    if (Number(connection.port ?? 443) !== 443) { callback(new Error("EGRESS_CLIENT_PORT_UNSUPPORTED")); return undefined; }
    void connectEgress(host, connectOptions).then(tunnel => {
      callback(null, tlsConnect({ socket: tunnel, servername: host }));
    }, error => callback(error as Error));
    return undefined;
  }) as typeof agent.createConnection;
  return agent;
}

export type EgressFetchInput = Readonly<{
  method?: string; headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array; maxBodyBytes?: number; signal?: AbortSignal;
  /** Injectable transport for tests; default is CONNECT + TLS to the host. */
  transport?: (host: string, options: { socketPath: string; timeoutMs: number }) => Promise<Duplex>;
}>;

export type EgressFetchResponse = Readonly<{
  status: number; statusText: string; headers: Readonly<Record<string, readonly string[]>>;
  body: Uint8Array; text(): string; json(): unknown;
}>;

type ParsedHead = Readonly<{
  status: number; statusText: string; headers: Record<string, string[]>;
  chunked: boolean; contentLength: number | undefined;
}>;

function parseHead(head: Buffer, maxBody: number): ParsedHead {
  const lines = head.toString("latin1").split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/u.exec(lines[0] ?? "");
  assert(statusMatch !== null, "EGRESS_CLIENT_RESPONSE_INVALID");
  const headers: Record<string, string[]> = Object.create(null);
  for (const line of lines.slice(1)) {
    const split = line.indexOf(":"); if (split === -1) continue;
    const key = line.slice(0, split).trim().toLowerCase(), value = line.slice(split + 1).trim();
    (headers[key] ??= []).push(value);
  }
  const rawLength = headers["content-length"]?.[0];
  const contentLength = rawLength === undefined ? undefined : Number(rawLength);
  assert(contentLength === undefined || (Number.isSafeInteger(contentLength) && contentLength >= 0 && contentLength <= maxBody), "EGRESS_CLIENT_BODY_OVERSIZE");
  return Object.freeze({ status: Number(statusMatch[1]), statusText: statusMatch[2] ?? "",
    headers, chunked: (headers["transfer-encoding"]?.[0] ?? "").toLowerCase().includes("chunked"), contentLength });
}

/** Incremental chunked decoder; `{complete:false}` means more bytes needed. */
function decodeChunked(buffer: Buffer, maxBody: number): { body: Buffer; complete: boolean } {
  const body: Buffer[] = []; let offset = 0, total = 0;
  for (;;) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) return { body: Buffer.concat(body), complete: false };
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString("latin1").trim(), 16);
    if (!Number.isSafeInteger(size) || size < 0) fail("EGRESS_CLIENT_CHUNK_INVALID");
    if (size === 0) return { body: Buffer.concat(body), complete: true };
    total += size;
    if (total > maxBody) fail("EGRESS_CLIENT_BODY_OVERSIZE");
    if (lineEnd + 2 + size + 2 > buffer.length) return { body: Buffer.concat(body), complete: false };
    body.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
}

async function requestOnce(url: URL, input: EgressFetchInput, connectOptions: { socketPath: string; timeoutMs: number }): Promise<EgressFetchResponse> {
  const transport = input.transport ?? ((host: string, opts: { socketPath: string; timeoutMs: number }) => connectEgressTls(host, opts));
  const socket = await transport(hostname(url.hostname), connectOptions);
  const method = (input.method ?? "GET").toUpperCase();
  assert(/^[A-Z][A-Z0-9-]*$/u.test(method), "EGRESS_CLIENT_METHOD_INVALID");
  const bodyBytes = input.body === undefined ? Buffer.alloc(0)
    : typeof input.body === "string" ? Buffer.from(input.body) : Buffer.from(input.body);
  const maxBody = input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  assert(Number.isSafeInteger(maxBody) && maxBody >= 0 && maxBody <= MAX_BODY_BYTES, "EGRESS_CLIENT_LIMIT_INVALID");
  const requestPath = `${url.pathname || "/"}${url.search}`;
  const headLines = [`${method} ${requestPath} HTTP/1.1`, `Host: ${url.hostname.toLowerCase()}`, "Accept: */*",
    `Content-Length: ${bodyBytes.length}`, "Connection: close"];
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    assert(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) && typeof value === "string" && !/[\r\n]/u.test(value), "EGRESS_CLIENT_HEADER_INVALID");
    if (!["host", "content-length", "connection"].includes(name.toLowerCase())) headLines.push(`${name}: ${value}`);
  }
  return await new Promise<EgressFetchResponse>((resolvePromise, reject) => {
    // `transport` may hand back a plain Duplex in tests; only real sockets
    // carry setTimeout, so it is applied defensively.
    const timers = socket as Partial<Socket>;
    let settled = false, parsed: ParsedHead | undefined;
    const chunks: Buffer[] = []; let received = 0;
    const done = (error?: Error | string, value?: EgressFetchResponse) => {
      if (settled) return;
      settled = true; timers.setTimeout?.(0); socket.destroy();
      input.signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(typeof error === "string" ? new Error(error) : error); else resolvePromise(value!);
    };
    const onAbort = () => done("EGRESS_CLIENT_ABORTED");
    const assemble = (body: Buffer) => {
      const frozen = Object.freeze({
        status: parsed!.status, statusText: parsed!.statusText, headers: Object.freeze(parsed!.headers),
        body: new Uint8Array(body), text: () => body.toString("utf8"), json: () => JSON.parse(body.toString("utf8")) as unknown,
      });
      done(undefined, frozen);
    };
    const tryFinish = (ended: boolean) => {
      if (parsed === undefined) {
        const buffered = Buffer.concat(chunks);
        const end = buffered.indexOf("\r\n\r\n");
        if (end === -1) {
          if (buffered.length > MAX_HEAD_BYTES || ended) done(ended ? "EGRESS_CLIENT_RESPONSE_INVALID" : "EGRESS_CLIENT_HEAD_OVERSIZE");
          return;
        }
        try { parsed = parseHead(buffered.subarray(0, end), maxBody); }
        catch (error) { done(error as Error); return; }
        const rest = buffered.subarray(end + 4);
        chunks.length = 0; received = rest.length;
        if (rest.length > 0) chunks.push(rest);
      }
      const buffered = Buffer.concat(chunks);
      try {
        if (parsed.chunked) {
          const decoded = decodeChunked(buffered, maxBody);
          if (decoded.complete || ended) { assemble(decoded.body); return; }
        } else if (parsed.contentLength !== undefined) {
          if (received >= parsed.contentLength) { assemble(buffered.subarray(0, parsed.contentLength)); return; }
          if (ended) { assemble(buffered.subarray(0, Math.min(buffered.length, parsed.contentLength))); return; }
        } else if (ended) { assemble(buffered); return; }
      } catch (error) { done(error as Error); return; }
    };
    timers.setTimeout?.(connectOptions.timeoutMs);
    socket.once("timeout", () => done("EGRESS_CLIENT_TIMEOUT"));
    socket.once("error", () => done("EGRESS_CLIENT_SOCKET_FAILED"));
    input.signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length; chunks.push(chunk);
      if (received > maxBody + MAX_HEAD_BYTES) { done("EGRESS_CLIENT_BODY_OVERSIZE"); return; }
      tryFinish(false);
    });
    socket.once("end", () => { if (!settled) tryFinish(true); });
    socket.write(Buffer.concat([Buffer.from(headLines.join("\r\n") + "\r\n\r\n", "latin1"), bodyBytes]));
  });
}

/** Minimal `fetch`-shaped HTTPS client over the egress bridge: https URLs on
 * :443 only, bounded redirects and body. This is a request primitive, not a
 * full fetch implementation — no cookies, cache, streaming request bodies or
 * HTTP/2. */
export async function fetchViaEgress(rawUrl: string, input?: EgressFetchInput & EgressConnectOptions): Promise<EgressFetchResponse> {
  const connectOptions = optionsOf(input);
  let url = (() => { try { return new URL(rawUrl); } catch { return fail("EGRESS_CLIENT_URL_INVALID"); } })();
  let method = input?.method, body = input?.body;
  for (let hop = 0; ; hop += 1) {
    assert(url.protocol === "https:" && (url.port === "" || url.port === "443") && url.username === "" && url.password === "", "EGRESS_CLIENT_URL_UNSUPPORTED");
    const response = await requestOnce(url, { ...(input ?? {}), ...(method === undefined ? {} : { method }), ...(body === undefined ? {} : { body }) }, connectOptions);
    if (![301, 302, 303, 307, 308].includes(response.status) || hop >= MAX_REDIRECTS) return response;
    const location = response.headers.location?.[0];
    assert(typeof location === "string" && location.length <= 4096, "EGRESS_CLIENT_REDIRECT_INVALID");
    try { url = new URL(location, url); } catch { return fail("EGRESS_CLIENT_REDIRECT_INVALID"); }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== undefined && !["GET", "HEAD"].includes(method.toUpperCase()))) {
      method = "GET"; body = undefined;
    }
  }
}
