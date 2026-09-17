import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AccountLease, AccountLeaseStore } from "../src/accounts.ts";
import type { BrowserSessionBinding } from "../src/browser-session.ts";
import { createManagedAccountController, type ManagedAccountBinding, type ManagedAccountCloseReceipt, type ManagedAccountEvent, type ManagedAccountRequest, type ManagedAccountResponse, type ManagedAccountSemantics, type ManagedAccountTransport, type ManagedAccountUsageReader } from "../src/managed-account.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class Leases implements AccountLeaseStore {
  current: AccountLease | undefined; releases = 0; acquires = 0; generation = 0;
  acquire(input: Parameters<AccountLeaseStore["acquire"]>[0]) {
    this.acquires++;
    if (this.current !== undefined) throw new Error("ACCOUNT_BUSY_OR_RECOVERY_REQUIRED");
    return this.current = Object.freeze({ provider: input.provider, accountId: input.accountId, owner: input.owner, generation: ++this.generation, expiresAt: input.now + input.ttlMs });
  }
  renew(lease: AccountLease) { return lease; }
  release(lease: AccountLease) { if (lease !== this.current) return false; this.releases++; this.current = undefined; return true; }
}
const sessionBinding = (overrides: Partial<BrowserSessionBinding> = {}): BrowserSessionBinding =>
  Object.freeze({ provider: "devin", accountId: "account-one", owner: "owner-one", leaseGeneration: 7, processGeneration: 2, ...overrides });

function fixture(options: { leases?: Leases; factoryFailure?: boolean; operationTimeoutMs?: number; closeTimeoutMs?: number; usageReader?: ManagedAccountUsageReader } = {}) {
  const leases = options.leases ?? new Leases(), calls: string[] = [], requests: ManagedAccountRequest[] = [];
  let binding: ManagedAccountBinding | undefined, event: ((value: ManagedAccountEvent) => void) | undefined;
  let account: unknown = { signedIn: true, secret: "never-exposed" };
  let readGate: ReturnType<typeof deferred<void>> | undefined, loginGate: ReturnType<typeof deferred<void>> | undefined, closeGate: ReturnType<typeof deferred<void>> | undefined;
  const loginEntered = deferred<void>();
  let responseBinding: Partial<ManagedAccountBinding> = {}, responseGenerationDelta = 0;
  let receiptOverrides: Partial<ManagedAccountCloseReceipt> = {};
  let challengeOverride: unknown;
  let loginFailure = false;
  const wrap = (request: ManagedAccountRequest, value: unknown): ManagedAccountResponse => ({ binding: { ...request.binding, ...responseBinding }, accountGeneration: request.accountGeneration + responseGenerationDelta, value });
  const transport: ManagedAccountTransport = {
    async accountRead(request) { calls.push("read"); requests.push(request); if (readGate) await readGate.promise; return wrap(request, account); },
    async startLogin(request) { calls.push(`login:${request.method.type}`); requests.push(request); loginEntered.resolve(); if (loginGate) await loginGate.promise; if (loginFailure) throw new Error("private-login-provider-detail");
      return wrap(request, challengeOverride ?? (request.method.type === "browser-session"
        ? { type: "browser-session", loginId: "login-one", session: request.method.session, navigationUrl: "https://provider.example/login?state=opaque" }
        : { type: "provider-native", method: (request.method as { method: string }).method, loginId: "login-one", fields: { verificationUrl: "https://provider.example/device", userCode: "ABCD-EFGH", token: "never-export" } })); },
    async cancelLogin(request) { calls.push(`cancel:${request.loginId}`); requests.push(request); return wrap(request, { status: "canceled" }); },
    async logout(request) { calls.push("logout"); requests.push(request); account = { signedIn: false }; return wrap(request, {}); },
    async close() { calls.push("close"); if (closeGate) await closeGate.promise; return { binding: binding!, processExited: true, processGroupStopped: true, stdoutEnded: true, stderrEnded: true, writesSettled: true, requestsSettled: true, notificationsSettled: true, ...receiptOverrides }; },
  };
  const semantics: ManagedAccountSemantics = {
    async projectAccount(value) {
      const v = value as Record<string, unknown>;
      if (v.signedIn === true) return { state: "signed-in", planLabel: "synthetic-plan" };
      if (v.pending === true) return { state: "signing-in" };
      if (v.unavailable === true) return { state: "unavailable", detail: "SYNTHETIC_UNAVAILABLE" };
      return { state: "signed-out" };
    },
  };
  const controller = createManagedAccountController({ provider: "devin", accountId: "account-one", owner: "owner-one", processGeneration: 3, leases, semantics,
    ...(options.usageReader === undefined ? {} : { usageReader: options.usageReader }),
    ...(options.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: options.operationTimeoutMs }),
    ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
    transportFactory(value, onEvent) { calls.push("factory"); binding = value; event = onEvent; if (options.factoryFailure) throw new Error("private-launch-error"); return transport; } });
  return { controller, leases, calls, requests, loginEntered,
    account(value: unknown) { account = value; },
    challenge(value: unknown) { challengeOverride = value; }, loginFailure() { loginFailure = true; },
    holdRead() { return readGate = deferred<void>(); }, holdLogin() { return loginGate = deferred<void>(); }, holdClose() { return closeGate = deferred<void>(); },
    wrongBinding(value: Partial<ManagedAccountBinding>) { responseBinding = value; }, wrongGeneration() { responseGenerationDelta = -1; },
    receipt(value: Partial<ManagedAccountCloseReceipt>) { receiptOverrides = value; },
    emit(type: ManagedAccountEvent["type"], extras: Partial<ManagedAccountEvent> = {}) { event!({ binding: binding!, type, ...extras }); },
    binding: () => binding!,
  };
}

describe("managed account controller", () => {
  test("snapshot and unused close never acquire a lease or launch a transport", async () => {
    const f = fixture();
    expect(f.controller.snapshot()).toMatchObject({ provider: "devin", accountId: "account-one", state: "unchecked", accountGeneration: 1, processGeneration: 3, pendingLoginId: null });
    expect(Object.isFrozen(f.controller.snapshot())).toBe(true);
    expect(f.calls).toEqual([]);
    expect(await f.controller.close()).toEqual({ released: true, state: "closed" });
    expect(f.leases.acquires).toBe(0);
    await expect(f.controller.check()).rejects.toThrow("MANAGED_ACCOUNT_UNAVAILABLE");
  });
  test("check acquires the lease, projects through provider semantics and fences generations", async () => {
    const f = fixture();
    const result = await f.controller.check();
    expect(result).toMatchObject({ provider: "devin", state: "signed-in", planLabel: "synthetic-plan" });
    expect(JSON.stringify(result)).not.toContain("never-exposed");
    expect(f.calls).toEqual(["factory", "read"]);
    expect(f.binding().provider).toBe("devin");
    expect(f.leases.acquires).toBe(1);
    expect(await f.controller.close()).toEqual({ released: true, state: "closed" });
    expect(f.leases.releases).toBe(1);
  });
  test("a second controller cannot steal a held lease", async () => {
    const leases = new Leases();
    const a = fixture({ leases }); await a.controller.check();
    const b = fixture({ leases });
    await expect(b.controller.check()).rejects.toThrow("MANAGED_ACCOUNT_OPERATION_FAILED");
    expect(b.controller.snapshot().state).toBe("unavailable");
    await a.controller.close();
    // The failed controller never launched; close still completes.
    expect(await b.controller.close()).toEqual({ released: true, state: "closed" });
  });
  test("a stale binding or generation in the transport response fails the operation", async () => {
    const f = fixture(); f.wrongBinding({ owner: "owner-two" });
    await expect(f.controller.check()).rejects.toThrow("MANAGED_ACCOUNT_STALE");
    const g = fixture(); g.wrongGeneration();
    await expect(g.controller.check()).rejects.toThrow("MANAGED_ACCOUNT_STALE");
  });
  test("concurrent operations serialize behind one active request", async () => {
    const f = fixture(); const gate = f.holdRead();
    const first = f.controller.check();
    await expect(f.controller.check()).rejects.toThrow("MANAGED_ACCOUNT_BUSY");
    gate.resolve();
    expect((await first).state).toBe("signed-in");
    await f.controller.close();
  });
  test("provider-native login returns a bounded challenge and records pendingLogin", async () => {
    const f = fixture();
    const challenge = await f.controller.startLogin({ type: "provider-native", method: "device-code" });
    expect(challenge).toMatchObject({ type: "provider-native", method: "device-code", loginId: "login-one" });
    expect((challenge as { fields: Record<string, string> }).fields.verificationUrl).toBe("https://provider.example/device");
    expect(f.controller.snapshot()).toMatchObject({ state: "signing-in", pendingLoginId: "login-one" });
    await f.controller.close();
  });
  test("a malformed challenge after dispatch is recovery-required, never a clean failure", async () => {
    const f = fixture();
    f.challenge({ type: "provider-native", method: "oauth-link", loginId: "login-one", fields: {} });
    await expect(f.controller.startLogin({ type: "provider-native", method: "device-code" })).rejects.toThrow("MANAGED_ACCOUNT_OPERATION_FAILED");
    expect(f.controller.snapshot().state).toBe("recovery-required");
    const g = fixture();
    g.challenge({ type: "provider-native", method: "device-code", loginId: 42, fields: {} });
    await expect(g.controller.startLogin({ type: "provider-native", method: "device-code" })).rejects.toThrow("MANAGED_ACCOUNT_OPERATION_FAILED");
    expect(g.controller.snapshot().state).toBe("recovery-required");
  });
  test("browser-session login binds the exact account session or refuses", async () => {
    const f = fixture();
    await expect(f.controller.startLogin({ type: "browser-session", session: sessionBinding({ accountId: "account-two" }) })).rejects.toThrow("MANAGED_ACCOUNT_SESSION_MISMATCH");
    await expect(f.controller.startLogin({ type: "browser-session", session: sessionBinding({ provider: "codex" }) })).rejects.toThrow("MANAGED_ACCOUNT_SESSION_MISMATCH");
    const challenge = await f.controller.startLogin({ type: "browser-session", session: sessionBinding() });
    expect(challenge).toMatchObject({ type: "browser-session", loginId: "login-one", navigationUrl: "https://provider.example/login?state=opaque" });
    expect((challenge as { session: BrowserSessionBinding }).session.accountId).toBe("account-one");
    await f.controller.close();
  });
  test("browser-session challenge requires an https-only navigation URL", async () => {
    const f = fixture();
    f.challenge({ type: "browser-session", loginId: "login-one", session: sessionBinding(), navigationUrl: "http://provider.example/login" });
    // The login was already dispatched when the malformed challenge arrived;
    // the unresolved outcome is custody evidence, not a retryable error.
    await expect(f.controller.startLogin({ type: "browser-session", session: sessionBinding() })).rejects.toThrow("MANAGED_ACCOUNT_OPERATION_FAILED");
    expect(f.controller.snapshot().state).toBe("recovery-required");
  });
  test("a lost login response is recovery-required, never a retryable pending login", async () => {
    const f = fixture(); f.loginFailure();
    await expect(f.controller.startLogin({ type: "provider-native", method: "device-code" })).rejects.toThrow("MANAGED_ACCOUNT_OPERATION_FAILED");
    expect(f.controller.snapshot().state).toBe("recovery-required");
    await expect(f.controller.startLogin({ type: "provider-native", method: "device-code" })).rejects.toThrow("MANAGED_ACCOUNT_UNAVAILABLE");
    // The joined close is itself the recovery: it retires the possibly-live
    // process before the lease can ever be reused.
    expect(await f.controller.close()).toEqual({ released: true, state: "closed" });
    expect(f.leases.releases).toBe(1);
  });
  test("cancelLogin returns the provider status and clears pendingLogin", async () => {
    const f = fixture();
    await f.controller.startLogin({ type: "provider-native", method: "device-code" });
    expect(await f.controller.cancelLogin("login-one")).toEqual({ status: "canceled" });
    expect(f.controller.snapshot().pendingLoginId).toBeNull();
    await expect(f.controller.cancelLogin("login-one")).rejects.toThrow("MANAGED_LOGIN_STALE");
    await f.controller.close();
  });
  test("a login-completed event for another loginId is ignored", async () => {
    const f = fixture();
    await f.controller.startLogin({ type: "provider-native", method: "device-code" });
    f.emit("login-completed", { loginId: "login-nine", success: true });
    expect(f.controller.snapshot()).toMatchObject({ state: "signing-in", pendingLoginId: "login-one" });
    f.emit("login-completed", { loginId: "login-one", success: false });
    expect(f.controller.snapshot().state).toBe("unchecked");
    await f.controller.close();
  });
  test("logout clears the account and re-reads through the same fence", async () => {
    const f = fixture();
    await f.controller.check();
    const result = await f.controller.logout();
    expect(result.state).toBe("signed-out");
    expect(f.calls).toEqual(["factory", "read", "logout", "read"]);
    await f.controller.close();
  });
  test("readUsage is null without an admitted reader and bounded with one", async () => {
    const f = fixture();
    expect(await f.controller.readUsage()).toBeNull();
    const rawSha256 = createHash("sha256").update("synthetic-quota-bytes").digest("hex");
    let usageBinding: ManagedAccountBinding | undefined;
    const g = fixture({ usageReader: { async readUsage(request) {
      usageBinding = request.binding;
      return Object.freeze({ binding: request.binding, observedAt: 1_700_000_000_000, planLabel: "synthetic-plan",
        windows: Object.freeze([{ label: "five-hour", usedPercent: 42.5, resetsAt: 1_700_003_600_000 }, { label: "weekly", usedPercent: null, resetsAt: null }]),
        rawSha256, secret: "never-carried" });
    } } });
    const usage = await g.controller.readUsage();
    expect(usage).toMatchObject({ observedAt: 1_700_000_000_000, planLabel: "synthetic-plan", rawSha256,
      windows: [{ label: "five-hour", usedPercent: 42.5, resetsAt: 1_700_003_600_000 }, { label: "weekly", usedPercent: null, resetsAt: null }] });
    expect(JSON.stringify(usage)).not.toContain("never-carried");
    expect(usageBinding).toEqual(g.binding());
    await g.controller.close();
  });
  test("readUsage rejects a stale binding or out-of-range windows", async () => {
    const stale = fixture({ usageReader: { async readUsage(request) {
      return Object.freeze({ binding: { ...request.binding, accountId: "account-two" }, observedAt: 1, planLabel: null, windows: [], rawSha256: "0".repeat(64) }) as never;
    } } });
    await expect(stale.controller.readUsage()).rejects.toThrow("MANAGED_ACCOUNT_OPERATION_FAILED");
    const bad = fixture({ usageReader: { async readUsage(request) {
      return Object.freeze({ binding: request.binding, observedAt: 1, planLabel: null,
        windows: [{ label: "w", usedPercent: 140, resetsAt: null }], rawSha256: "0".repeat(64) });
    } } });
    await expect(bad.controller.readUsage()).rejects.toThrow("MANAGED_ACCOUNT_OPERATION_FAILED");
  });
  test("close requires the full custody receipt; an unproven field keeps the lease", async () => {
    const f = fixture();
    await f.controller.check();
    f.receipt({ processGroupStopped: false });
    expect(await f.controller.close()).toEqual({ released: false, state: "recovery-required" });
    expect(f.leases.releases).toBe(0);
    expect(f.controller.snapshot().state).toBe("recovery-required");
  });
  test("a second close while transport close is outstanding shares the result", async () => {
    const f = fixture();
    await f.controller.check();
    const gate = f.holdClose();
    const a = f.controller.close(), b = f.controller.close();
    expect(a).toBe(b);
    gate.resolve();
    expect(await a).toEqual({ released: true, state: "closed" });
  });
  test("a factory failure is recovery-required and never launches a transport", async () => {
    const f = fixture({ factoryFailure: true });
    await expect(f.controller.check()).rejects.toThrow("MANAGED_ACCOUNT_FACTORY_FAILED");
    expect(f.controller.snapshot().state).toBe("recovery-required");
  });
  test("an aborted signal cannot open an operation", async () => {
    const f = fixture();
    const signal = AbortSignal.abort();
    await expect(f.controller.check(signal)).rejects.toThrow("MANAGED_ACCOUNT_ABORTED");
    expect(f.calls).toEqual([]);
  });
});
