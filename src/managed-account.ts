import type { AccountLease, AccountLeaseStore } from "./accounts.ts";
import type { BrowserSessionBinding } from "./browser-session.ts";
import { boundedText, identifier, provider, safeInteger, type AgentProvider } from "./validation.ts";

/**
 * Provider-neutral managed-account custody. This module owns the custody
 * discipline every provider controller shares — the account lease, the exact
 * binding (`provider`, `accountId`, `owner`, lease and process generations),
 * the serialized state machine, unresolved-login recovery and the joined-close
 * barrier. It is not an execution or authentication qualification: admitting a
 * provider's runtime, its login transport and its usage surface remain
 * separate host evidence.
 *
 * Provider-owned semantics stay behind `ManagedAccountSemantics`: the neutral
 * controller never parses a provider account payload, chooses plan labels or
 * guesses challenge shapes. The transport is a closed port — account reads,
 * login lifecycle, logout and close only; no raw RPC, token export or turn
 * method exists here.
 */
export type ManagedAccountState = "unchecked" | "signed-out" | "signing-in" | "signed-in" | "unavailable" | "recovery-required" | "closed";

export type ManagedAccountBinding = Readonly<{
  provider: AgentProvider; accountId: string; owner: string;
  leaseGeneration: number; processGeneration: number;
}>;

/** How a login is driven. `provider-native` selects a provider-owned variant
 * (Codex `chatgpt`/`chatgptDeviceCode`, Devin web login); `browser-session`
 * drives sign-in inside the caller's per-account browser custody session —
 * the session binding must equal the account's provider, accountId and owner
 * so one account's cookie jar can never authenticate another. */
export type ManagedAccountLoginMethod =
  | Readonly<{ type: "provider-native"; method: string }>
  | Readonly<{ type: "browser-session"; session: BrowserSessionBinding }>;

export type ManagedAccountLoginChallenge =
  | Readonly<{ type: "provider-native"; method: string; loginId: string; fields: Readonly<Record<string, string>> }>
  | Readonly<{ type: "browser-session"; loginId: string; session: BrowserSessionBinding; navigationUrl: string }>;

/** Neutral projection the provider semantics maps its account payload onto.
 * `state` is the only claim the controller interprets; `planLabel`/`detail`
 * are bounded display text and never authority. */
export type ManagedAccountProjection = Readonly<{
  state: "signed-out" | "signing-in" | "signed-in" | "unavailable";
  planLabel?: string;
  detail?: string;
}>;

export type ManagedAccountSnapshot = Readonly<{
  provider: AgentProvider; accountId: string; state: ManagedAccountState;
  accountGeneration: number; processGeneration: number;
  pendingLoginId: string | null; planLabel?: string; detail?: string;
}>;

export type ManagedAccountRequest = Readonly<{
  binding: ManagedAccountBinding; accountGeneration: number; signal: AbortSignal; deadlineMs: number;
}>;
export type ManagedAccountResponse = Readonly<{
  binding: ManagedAccountBinding; accountGeneration: number; value: unknown;
}>;
export type ManagedAccountEvent = Readonly<{
  binding: ManagedAccountBinding;
  type: "account-updated" | "login-completed" | "disconnected";
  loginId?: string | null; success?: boolean;
}>;
export type ManagedAccountCloseReceipt = Readonly<{
  binding: ManagedAccountBinding;
  processExited: boolean; processGroupStopped: boolean;
  stdoutEnded: boolean; stderrEnded: boolean;
  writesSettled: boolean; requestsSettled: boolean; notificationsSettled: boolean;
}>;

/** Trusted implementation owns initialize, runtime/schema admission,
 * credential custody and process custody. There is deliberately no raw RPC,
 * token export or turn method. Return the handle before asynchronous launch,
 * so close can join failed launches. A transport may implement extra
 * provider-owned reads internally; they still run inside this fence. */
export interface ManagedAccountTransport {
  accountRead(request: ManagedAccountRequest): Promise<ManagedAccountResponse>;
  startLogin(request: ManagedAccountRequest & { method: ManagedAccountLoginMethod }): Promise<ManagedAccountResponse>;
  cancelLogin(request: ManagedAccountRequest & { loginId: string }): Promise<ManagedAccountResponse>;
  logout(request: ManagedAccountRequest): Promise<ManagedAccountResponse>;
  close(request: { binding: ManagedAccountBinding; deadlineMs: number }): Promise<ManagedAccountCloseReceipt>;
}

/** Provider-owned interpretation. Runs inside the controller's serialized,
 * generation-fenced operation; must throw on any payload it does not fully
 * admit rather than coerce. The controller itself owns the closed challenge
 * envelope and cancel-status enum — the only provider-specific
 * interpretation is the account payload's projection onto the neutral
 * readiness state. */
export interface ManagedAccountSemantics {
  /** Map the transport's accountRead payload to a neutral projection. May
   * issue further provider reads through the same fenced transport (paged
   * model catalogs, quota detail) before returning. */
  projectAccount(value: unknown, request: ManagedAccountRequest, transport: ManagedAccountTransport): Promise<ManagedAccountProjection>;
}

/** Bounded, read-only usage/quota observation. Windows are provider-named
 * labels with optional utilization; `rawSha256` binds the provider's exact
 * response as evidence without carrying it — quota bytes never enter custody
 * journals, receipts or logs. A missing reader means the provider has no
 * admitted usage surface; it is not a zero-usage claim. */
export type ManagedAccountUsageWindow = Readonly<{
  label: string; usedPercent: number | null; resetsAt: number | null;
}>;
export type ManagedAccountUsage = Readonly<{
  binding: ManagedAccountBinding; observedAt: number; planLabel: string | null;
  windows: readonly ManagedAccountUsageWindow[]; rawSha256: string;
}>;
export interface ManagedAccountUsageReader {
  readUsage(request: ManagedAccountRequest): Promise<ManagedAccountUsage>;
}

export type ManagedAccountOptions = Readonly<{
  provider: AgentProvider; accountId: string; owner: string; processGeneration: number;
  leases: AccountLeaseStore;
  transportFactory: (binding: ManagedAccountBinding, onEvent: (event: ManagedAccountEvent) => void) => ManagedAccountTransport;
  semantics: ManagedAccountSemantics;
  usageReader?: ManagedAccountUsageReader;
  now?: () => number; operationTimeoutMs?: number; closeTimeoutMs?: number;
}>;

export interface ManagedAccountController {
  readonly binding: () => ManagedAccountBinding | undefined;
  snapshot(): ManagedAccountSnapshot;
  check(signal?: AbortSignal): Promise<ManagedAccountSnapshot>;
  startLogin(method: ManagedAccountLoginMethod, signal?: AbortSignal): Promise<ManagedAccountLoginChallenge>;
  cancelLogin(loginId: string, signal?: AbortSignal): Promise<Readonly<{ status: "canceled" | "notFound" }>>;
  logout(signal?: AbortSignal): Promise<ManagedAccountSnapshot>;
  /** Bounded quota observation through the admitted reader; `null` when the
   * provider has none. Never extends custody or refreshes credentials. */
  readUsage(signal?: AbortSignal): Promise<ManagedAccountUsage | null>;
  close(): Promise<Readonly<{ released: boolean; state: "closed" | "recovery-required" }>>;
}

export function createManagedAccountController(options: ManagedAccountOptions): ManagedAccountController {
  const providerName = provider(options.provider);
  const accountId = identifier(options.accountId), owner = identifier(options.owner);
  const processGeneration = safeInteger(options.processGeneration, 1, Number.MAX_SAFE_INTEGER);
  const now = options.now ?? Date.now;
  const operationTimeoutMs = safeInteger(options.operationTimeoutMs ?? 40_000, 1, 120_000);
  const closeTimeoutMs = safeInteger(options.closeTimeoutMs ?? 10_000, 1, 120_000);
  const semantics = options.semantics;
  if (semantics === null || typeof semantics !== "object" || typeof semantics.projectAccount !== "function") throw new Error("MANAGED_ACCOUNT_SEMANTICS_INVALID");
  let accountGeneration = 1;
  let pendingLogin: string | undefined;
  let snapshot: ManagedAccountSnapshot = freezeSnapshot("unchecked");
  let lease: AccountLease | undefined, binding: ManagedAccountBinding | undefined, transport: ManagedAccountTransport | undefined;
  let loginDispatch = false;
  let unresolvedLogin = false;
  const earlyLoginCompletions = new Map<string, boolean>();
  let active: AbortController | undefined;
  const unsettled = new Set<Promise<unknown>>();
  const unsettledCloses = new Set<Promise<ManagedAccountCloseReceipt>>();
  let closing = false;
  let closeTask: Promise<Readonly<{ released: boolean; state: "closed" | "recovery-required" }>> | undefined;

  function freezeSnapshot(state: ManagedAccountState, extra: { planLabel?: string; detail?: string } = {}): ManagedAccountSnapshot {
    return Object.freeze({ provider: providerName, accountId, state, accountGeneration, processGeneration, pendingLoginId: pendingLogin ?? null, ...extra });
  }
  function publish(state: ManagedAccountState, extra?: Parameters<typeof freezeSnapshot>[1]): void { snapshot = freezeSnapshot(state, extra); }
  function invalidate(state: ManagedAccountState, detail?: string): void {
    accountGeneration = safeInteger(accountGeneration + 1, 1, Number.MAX_SAFE_INTEGER);
    publish(state, detail === undefined ? {} : { detail });
  }
  function onEvent(event: ManagedAccountEvent): void {
    if (closing || unresolvedLogin || binding === undefined || !sameBinding(event.binding, binding)) return;
    if (event.type === "login-completed") {
      if (typeof event.loginId !== "string" || typeof event.success !== "boolean") return;
      if (pendingLogin === undefined && loginDispatch) {
        // Native notifications can precede the login/start response carrying its ID.
        // Admission is already closed; correlate only after that response arrives.
        if (event.loginId.length <= 160 && earlyLoginCompletions.size < 8) earlyLoginCompletions.set(event.loginId, event.success);
        return;
      }
      if (event.loginId !== pendingLogin) return;
    }
    if (event.type !== "account-updated" && event.type !== "login-completed" && event.type !== "disconnected") return;
    pendingLogin = undefined;
    // Synchronous invalidation is the authority barrier. Only check() can reopen it.
    invalidate(event.type === "disconnected" ? "unavailable" : "unchecked",
      event.type === "disconnected" ? "MANAGED_ACCOUNT_DISCONNECTED" : event.type === "login-completed" && !event.success ? "MANAGED_LOGIN_FAILED" : undefined);
    active?.abort();
  }
  function ensureTransport(): ManagedAccountTransport {
    if (transport !== undefined) return transport;
    if (lease !== undefined) throw new Error("MANAGED_ACCOUNT_RECOVERY_REQUIRED");
    lease = options.leases.acquire({ provider: providerName, accountId, owner, now: now(), ttlMs: 120_000 });
    binding = Object.freeze({ provider: providerName, accountId, owner, leaseGeneration: lease.generation, processGeneration });
    try { transport = options.transportFactory(binding, onEvent); }
    catch { publish("recovery-required", { detail: "MANAGED_ACCOUNT_FACTORY_FAILED" }); throw new Error("MANAGED_ACCOUNT_FACTORY_FAILED"); }
    return transport;
  }
  function sameBinding(a: ManagedAccountBinding | undefined, b: ManagedAccountBinding): boolean {
    return a !== undefined && a !== null && a.provider === b.provider && a.accountId === b.accountId
      && a.owner === b.owner && a.leaseGeneration === b.leaseGeneration && a.processGeneration === b.processGeneration;
  }
  function assertCurrent(request: ManagedAccountRequest): void {
    if (closing || request.signal.aborted || request.accountGeneration !== accountGeneration || binding === undefined || !sameBinding(request.binding, binding)) throw new Error("MANAGED_ACCOUNT_STALE");
  }
  function response(request: ManagedAccountRequest, result: ManagedAccountResponse): unknown {
    assertCurrent(request);
    if (result === null || typeof result !== "object" || !sameBinding(result.binding, request.binding) || result.accountGeneration !== request.accountGeneration) throw new Error("MANAGED_ACCOUNT_STALE");
    return result.value;
  }
  async function run<T>(signal: AbortSignal | undefined, action: (driver: ManagedAccountTransport, request: ManagedAccountRequest) => Promise<T>): Promise<T> {
    if (closing || snapshot.state === "closed" || snapshot.state === "recovery-required") throw new Error("MANAGED_ACCOUNT_UNAVAILABLE");
    if (signal?.aborted) throw new Error("MANAGED_ACCOUNT_ABORTED");
    if (active !== undefined || loginDispatch) throw new Error("MANAGED_ACCOUNT_BUSY");
    const controller = new AbortController(); active = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    invalidate("unchecked");
    const generation = accountGeneration;
    let task: Promise<T> | undefined;
    try {
      const driver = ensureTransport();
      const request = Object.freeze({ binding: binding!, accountGeneration: generation, signal: controller.signal, deadlineMs: now() + operationTimeoutMs });
      task = Promise.resolve().then(async () => { assertCurrent(request); return action(driver, request); });
      unsettled.add(task);
      const retainedTask = task;
      void task.finally(() => { unsettled.delete(retainedTask); if (active === controller) active = undefined; }).catch(() => {});
      return await bounded(task, operationTimeoutMs, controller.signal, () => controller.abort());
    } catch (error) {
      if (generation === accountGeneration && !closing && (snapshot.state as ManagedAccountState) !== "recovery-required") publish("unavailable", { detail: error instanceof Error && error.message === "MANAGED_ACCOUNT_TIMEOUT" ? "MANAGED_ACCOUNT_TIMEOUT" : "MANAGED_ACCOUNT_OPERATION_FAILED" });
      throw new Error(error instanceof Error && ["MANAGED_ACCOUNT_BUSY", "MANAGED_ACCOUNT_TIMEOUT", "MANAGED_ACCOUNT_ABORTED", "MANAGED_ACCOUNT_STALE", "MANAGED_ACCOUNT_FACTORY_FAILED"].includes(error.message) ? error.message : "MANAGED_ACCOUNT_OPERATION_FAILED");
    } finally {
      signal?.removeEventListener("abort", abort);
      if (task === undefined && active === controller) active = undefined;
    }
  }
  async function read(driver: ManagedAccountTransport, request: ManagedAccountRequest): Promise<ManagedAccountSnapshot> {
    const result = record(response(request, await driver.accountRead(request)));
    const projection = record(await semantics.projectAccount(result, request, driver));
    assertCurrent(request);
    const state = projection.state;
    if (state !== "signed-out" && state !== "signing-in" && state !== "signed-in" && state !== "unavailable") throw new Error("INVALID_ACCOUNT_PROJECTION");
    const planLabel = projection.planLabel === undefined ? undefined : cleanText(projection.planLabel, 128);
    const detail = projection.detail === undefined ? undefined : cleanText(projection.detail, 256);
    publish(state === "signing-in" && pendingLogin === undefined ? "signed-out" : state,
      { ...(planLabel === undefined ? {} : { planLabel }), ...(detail === undefined ? {} : { detail }) });
    return snapshot;
  }
  function methodOf(raw: ManagedAccountLoginMethod): ManagedAccountLoginMethod {
    const value = record(raw);
    const type = value.type;
    if (type === "provider-native") {
      return Object.freeze({ type, method: cleanText(value.method, 64) });
    }
    if (type === "browser-session") {
      const session = value.session;
      if (session === null || typeof session !== "object") throw new Error("MANAGED_ACCOUNT_SESSION_INVALID");
      const bound = session as BrowserSessionBinding;
      // The session binding must equal this account's identity so another
      // account's cookie jar can never satisfy this login. Session
      // generations are the browser session's own custody, not this lease's.
      if (bound.provider !== providerName || bound.accountId !== accountId || bound.owner !== owner) throw new Error("MANAGED_ACCOUNT_SESSION_MISMATCH");
      return Object.freeze({ type, session: Object.freeze({ provider: provider(bound.provider), accountId: identifier(bound.accountId), owner: identifier(bound.owner),
        leaseGeneration: safeInteger(bound.leaseGeneration, 1, Number.MAX_SAFE_INTEGER), processGeneration: safeInteger(bound.processGeneration, 1, Number.MAX_SAFE_INTEGER) }) });
    }
    throw new Error("MANAGED_ACCOUNT_METHOD_INVALID");
  }
  return Object.freeze({
    binding: () => binding,
    snapshot: () => snapshot,
    check: (signal?: AbortSignal) => run(signal, read),
    startLogin: (method: ManagedAccountLoginMethod, signal?: AbortSignal) => {
      let admitted: ManagedAccountLoginMethod;
      try { admitted = methodOf(method); } catch (error) { return Promise.reject(error); }
      if (pendingLogin !== undefined) return Promise.reject(new Error("MANAGED_LOGIN_PENDING"));
      let dispatched = false, completed = false;
      return run(signal, async (driver, request) => {
        loginDispatch = true; dispatched = true;
        const challenge = parseChallenge(response(request, await driver.startLogin({ ...request, method: admitted })), admitted);
        if (earlyLoginCompletions.has(challenge.loginId)) {
          const success = earlyLoginCompletions.get(challenge.loginId)!;
          completed = true;
          invalidate("unchecked", success ? undefined : "MANAGED_LOGIN_FAILED");
          throw new Error("MANAGED_ACCOUNT_STALE");
        }
        pendingLogin = challenge.loginId; publish("signing-in"); return challenge;
      }).catch(error => {
        if (dispatched && !completed && !closing) {
          // Losing login/start's response does not cancel provider polling. Its
          // unknown login ID cannot authorize another attempt or an account
          // recheck. Only joined close can retire this process and its lease.
          unresolvedLogin = true; pendingLogin = undefined; earlyLoginCompletions.clear();
          invalidate("recovery-required", "MANAGED_LOGIN_OUTCOME_UNRESOLVED");
        }
        throw error;
      }).finally(() => { if (dispatched) { loginDispatch = false; earlyLoginCompletions.clear(); } });
    },
    cancelLogin: (loginId: string, signal?: AbortSignal) => {
      try { cleanText(loginId, 160); } catch { return Promise.reject(new Error("INVALID_LOGIN_ID")); }
      if (loginId !== pendingLogin) return Promise.reject(new Error("MANAGED_LOGIN_STALE"));
      return run(signal, async (driver, request) => {
        const value = record(response(request, await driver.cancelLogin({ ...request, loginId })));
        const status = value.status;
        if (status !== "canceled" && status !== "notFound") throw new Error("INVALID_LOGIN_CANCEL");
        pendingLogin = undefined; publish("unchecked");
        return Object.freeze({ status });
      });
    },
    logout: (signal?: AbortSignal) => run(signal, async (driver, request) => {
      const value = record(response(request, await driver.logout(request)));
      if (Object.keys(value).length !== 0) throw new Error("INVALID_LOGOUT_RESULT");
      pendingLogin = undefined;
      return read(driver, request);
    }),
    readUsage: (signal?: AbortSignal) => {
      const reader = options.usageReader;
      if (reader === undefined) return Promise.resolve(null);
      return run(signal, async (_driver, request) => {
        const usage = await reader.readUsage(request);
        assertCurrent(request);
        if (usage === null || typeof usage !== "object" || !sameBinding(usage.binding, request.binding)) throw new Error("MANAGED_USAGE_STALE");
        return parseUsage(usage, request);
      });
    },
    close: () => {
      if (closeTask !== undefined) return closeTask;
      closing = true;
      // Publish the shared promise before abort listeners or a trusted close
      // implementation can synchronously reenter and duplicate cleanup.
      const task = Promise.resolve().then(async () => {
        if (lease === undefined) { publish("closed"); return Object.freeze({ released: true, state: "closed" as const }); }
        try {
          if (transport === undefined || binding === undefined) throw new Error("CLOSE_UNPROVEN");
          const deadlineMs = now() + closeTimeoutMs;
          const remaining = () => {
            const duration = deadlineMs - now();
            if (duration <= 0) throw new Error("CLOSE_UNPROVEN");
            return Math.min(duration, closeTimeoutMs);
          };
          const stop = Promise.resolve().then(() => transport!.close({ binding: binding!, deadlineMs }));
          unsettledCloses.add(stop);
          void stop.then(() => unsettledCloses.delete(stop), () => unsettledCloses.delete(stop));
          const receipt = await bounded(stop, remaining());
          await bounded(Promise.allSettled([...unsettled, ...unsettledCloses]), remaining());
          if (!sameBinding(receipt.binding, binding) || receipt.processExited !== true || receipt.processGroupStopped !== true || receipt.stdoutEnded !== true || receipt.stderrEnded !== true || receipt.writesSettled !== true || receipt.requestsSettled !== true || receipt.notificationsSettled !== true || unsettled.size !== 0 || unsettledCloses.size !== 0) throw new Error("CLOSE_UNPROVEN");
          if (!options.leases.release(lease)) throw new Error("LEASE_RELEASE_UNPROVEN");
          publish("closed"); return Object.freeze({ released: true, state: "closed" as const });
        } catch { publish("recovery-required", { detail: "MANAGED_ACCOUNT_STOP_UNPROVEN" }); return Object.freeze({ released: false, state: "recovery-required" as const }); }
      });
      closeTask = task;
      // The published attempt makes reentrant abort listeners safe. Revoke the
      // request synchronously, before an already queued transport write runs.
      active?.abort(); pendingLogin = undefined; invalidate("unchecked");
      void task.then(result => { if (!result.released && closeTask === task) closeTask = undefined; });
      return task;
    },
  });
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_MANAGED_RESPONSE");
  return value as Record<string, unknown>;
}
function cleanText(value: unknown, max: number, empty = false): string {
  const text = boundedText(value, max, empty);
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(text)) throw new Error("INVALID_MANAGED_TEXT");
  return text;
}
function parseChallenge(value: unknown, method: ManagedAccountLoginMethod): ManagedAccountLoginChallenge {
  const challenge = record(value);
  // The neutral layer parses only the envelope; provider semantics own the
  // fields' meaning and validate URLs/codes before anything displays them.
  const loginId = cleanText(challenge.loginId, 160);
  const type = challenge.type;
  if (type === "provider-native" && method.type === "provider-native") {
    const methodName = cleanText(challenge.method, 64);
    if (methodName !== method.method) throw new Error("UNEXPECTED_LOGIN_METHOD");
    const rawFields = record(challenge.fields);
    const fields: Record<string, string> = Object.create(null);
    for (const key of Reflect.ownKeys(rawFields)) {
      if (typeof key !== "string" || Object.keys(fields).length >= 16) throw new Error("INVALID_LOGIN_CHALLENGE");
      fields[key] = cleanText(rawFields[key], 8_192);
    }
    return Object.freeze({ type, method: methodName, loginId, fields: Object.freeze(fields) });
  }
  if (type === "browser-session" && method.type === "browser-session") {
    const session = challenge.session;
    if (session === null || typeof session !== "object") throw new Error("INVALID_LOGIN_CHALLENGE");
    const bound = session as BrowserSessionBinding;
    return Object.freeze({ type, loginId, session: Object.freeze({ provider: provider(bound.provider), accountId: identifier(bound.accountId), owner: identifier(bound.owner),
      leaseGeneration: safeInteger(bound.leaseGeneration, 1, Number.MAX_SAFE_INTEGER), processGeneration: safeInteger(bound.processGeneration, 1, Number.MAX_SAFE_INTEGER) }),
      navigationUrl: loginUrl(challenge.navigationUrl) });
  }
  throw new Error("UNEXPECTED_LOGIN_METHOD");
}
function loginUrl(value: unknown): string {
  const text = cleanText(value, 8_192), url = new URL(text);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") throw new Error("INVALID_LOGIN_URL");
  return text;
}
function parseUsage(value: ManagedAccountUsage, request: ManagedAccountRequest): ManagedAccountUsage {
  const raw = record(value);
  const observedAt = safeInteger(raw.observedAt, 0, Number.MAX_SAFE_INTEGER);
  if (observedAt > request.deadlineMs + 120_000) throw new Error("MANAGED_USAGE_FUTURE");
  const planLabel = raw.planLabel === null || raw.planLabel === undefined ? null : cleanText(raw.planLabel, 128);
  const rawWindows = raw.windows;
  if (!Array.isArray(rawWindows) || rawWindows.length > 16) throw new Error("INVALID_USAGE_WINDOWS");
  const windows = rawWindows.map(entry => {
    const window = record(entry);
    const label = cleanText(window.label, 128);
    const usedPercent = window.usedPercent === null || window.usedPercent === undefined ? null
      : (() => { const n = window.usedPercent; if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100) throw new Error("INVALID_USAGE_WINDOW"); return n; })();
    const resetsAt = window.resetsAt === null || window.resetsAt === undefined ? null : safeInteger(window.resetsAt, 0, Number.MAX_SAFE_INTEGER);
    return Object.freeze({ label, usedPercent, resetsAt });
  });
  const rawSha256 = raw.rawSha256;
  if (typeof rawSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(rawSha256)) throw new Error("INVALID_USAGE_DIGEST");
  return Object.freeze({ binding: request.binding, observedAt, planLabel, windows: Object.freeze(windows), rawSha256 });
}
function bounded<T>(task: Promise<T>, timeoutMs: number, signal?: AbortSignal, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(new Error("MANAGED_ACCOUNT_ABORTED")));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); fn(); };
    timer = setTimeout(() => finish(() => { reject(new Error("MANAGED_ACCOUNT_TIMEOUT")); onTimeout?.(); }), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    task.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
