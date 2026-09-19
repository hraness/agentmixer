import { expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkJudgeAnswers, checkJudgeQuestions, checkJudgeState, createSystemOneJudge, hasJudgeKey, parseJudgeEndpoint,
  parseJudgeResponse, removeJudgeKey, resolveJudge, resolveJudgeKey, storeJudgeKey,
  JUDGE_KEY_ENV, JUDGE_KEY_VENDOR_ENV, JUDGE_TOKEN_FILE, MAX_JUDGE_QUESTIONS, SYSTEM_ONE_URL } from "../src/judge.ts";

const TOKEN = "jev-test-key_synthetic.fixture+token=1";
const cleanEnv = () => undefined;
const envWith = (entries: Record<string, string>) => (name: string) => entries[name];

test("question batches are bounded and typed before reaching any backend", () => {
  expect(() => checkJudgeQuestions({})).toThrow("JUDGE_QUESTIONS_LIMIT");
  expect(() => checkJudgeQuestions({ q: { type: "noul", instructions: "ok?" } })).not.toThrow();
  expect(() => checkJudgeQuestions({ "model[1]": { type: "noul", instructions: "ok?" } })).not.toThrow();
  expect(() => checkJudgeQuestions({ "bad:name": { type: "noul", instructions: "ok?" } })).toThrow("JUDGE_NAME_INVALID");
  expect(() => checkJudgeQuestions({ "bad name": { type: "noul", instructions: "ok?" } })).toThrow("JUDGE_NAME_INVALID");
  expect(() => checkJudgeQuestions({ q: { type: "noul", instructions: "x".repeat(4 * 1024 + 1) } })).toThrow();
  const many = Object.fromEntries(Array.from({ length: MAX_JUDGE_QUESTIONS + 1 }, (_, i) => [`q${i}`, { type: "noul" as const, instructions: "ok?" }]));
  expect(() => checkJudgeQuestions(many)).toThrow("JUDGE_QUESTIONS_LIMIT");
  expect(() => checkJudgeQuestions({ q: { type: "choice", instructions: "pick", criteria: {} } })).toThrow("JUDGE_OPTIONS_LIMIT");
  expect(() => checkJudgeQuestions({ q: { type: "score", instructions: "rate", criteria: [] } })).toThrow("JUDGE_CRITERIA_LIMIT");
  expect(() => checkJudgeQuestions({ q: { type: "bogus", instructions: "?" } as never })).toThrow("JUDGE_QUESTION_TYPE");
});

test("state is bounded at the serialized boundary", () => {
  expect(() => checkJudgeState("short")).not.toThrow();
  expect(() => checkJudgeState({ nested: { value: 1 } })).not.toThrow();
  expect(() => checkJudgeState(42 as never)).toThrow("JUDGE_STATE_INVALID");
  expect(() => checkJudgeState("x".repeat(129 * 1024))).toThrow("JUDGE_STATE_LIMIT");
});

test("responses map status codes and validate every answer shape", () => {
  expect(() => parseJudgeResponse(401, "{}")).toThrow("JUDGE_KEY_REJECTED");
  expect(() => parseJudgeResponse(403, "{}")).toThrow("JUDGE_KEY_REJECTED");
  expect(() => parseJudgeResponse(429, "{}")).toThrow("JUDGE_RATE_LIMITED");
  expect(() => parseJudgeResponse(500, "{}")).toThrow("JUDGE_REQUEST_FAILED");
  expect(() => parseJudgeResponse(200, "not json")).toThrow("JUDGE_RESPONSE_MALFORMED");
  expect(() => parseJudgeResponse(200, "{}")).toThrow("JUDGE_RESPONSE_MALFORMED");
  expect(() => parseJudgeResponse(200, '{"answers":{}}')).toThrow("JUDGE_RESPONSE_MALFORMED");
  expect(() => parseJudgeResponse(200, '{"answers":{"q":{"noul":1.5}}}')).toThrow("JUDGE_ANSWER_RANGE");
  const parsed = parseJudgeResponse(200, JSON.stringify({
    model: "jev-latest",
    usage: { input_tokens: 12, output_tokens: 3 },
    answers: {
      a: { noul: 0.9 },
      b: { choice: "x", confidence: 0.8, probabilities: { x: 0.8, y: 0.2 } },
      c: { score: 4, confidence: 0.7, probabilities: { "4": 0.7 } },
    },
  }));
  expect(parsed.model).toBe("jev-latest");
  expect(parsed.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
  expect(parsed.answers.a).toEqual({ type: "noul", noul: 0.9 });
  expect(parsed.answers.b?.type === "choice" && parsed.answers.b.choice === "x").toBe(true);
  expect(parsed.answers.c?.type === "score" && parsed.answers.c.score === 4).toBe(true);
  const questions = {
    a: { type: "noul" as const, instructions: "yes?" },
    b: { type: "choice" as const, instructions: "pick", criteria: { x: null, y: null } },
    c: { type: "score" as const, instructions: "score", criteria: ["0", "1", "2", "3", "4"] },
  };
  expect(checkJudgeAnswers(questions, parsed)).toBe(parsed);
  expect(() => checkJudgeAnswers(questions, { ...parsed, answers: { a: parsed.answers.a! } }))
    .toThrow("JUDGE_RESPONSE_QUESTION_MISMATCH");
  expect(() => checkJudgeAnswers({ ...questions, b: { ...questions.b, criteria: { y: null } } }, parsed))
    .toThrow("JUDGE_RESPONSE_OPTION_MISMATCH");
  const choice = parsed.answers.b!;
  if (choice.type !== "choice") throw new Error("fixture");
  expect(() => checkJudgeAnswers(questions, {
    ...parsed, answers: { ...parsed.answers, b: { ...choice, probabilities: { y: 1 } } },
  })).toThrow("JUDGE_RESPONSE_OPTION_MISMATCH");
  expect(() => checkJudgeAnswers({ ...questions, c: { ...questions.c, criteria: ["0", "1"] } }, parsed))
    .toThrow("JUDGE_RESPONSE_SCORE_MISMATCH");
  for (const body of [
    { model: "jev-latest\nforged", answers: { q: { noul: 0.5 } } },
    { answers: { q: { choice: "x\nforged", confidence: 0.5, probabilities: { x: 1 } } } },
    { answers: { q: { choice: "x", confidence: 1.1, probabilities: { x: 1 } } } },
    { answers: { q: { choice: "x", confidence: 0.5, probabilities: { x: -0.1 } } } },
    { answers: { q: { noul: 0.5, choice: "x" } } },
    { usage: { input_tokens: -1 }, answers: { q: { noul: 0.5 } } },
    { usage: { input_tokens: 1, secret: 2 }, answers: { q: { noul: 0.5 } } },
  ]) expect(() => parseJudgeResponse(200, JSON.stringify(body))).toThrow();
});

test("endpoints are https-only with a clean authority", () => {
  expect(() => parseJudgeEndpoint("http://api.typesafe.ai/v1/systemone")).toThrow("JUDGE_ENDPOINT_INVALID");
  expect(() => parseJudgeEndpoint("https://user:pw@api.typesafe.ai/x")).toThrow("JUDGE_ENDPOINT_INVALID");
  expect(() => parseJudgeEndpoint("https://api.typesafe.ai/x?y=1")).toThrow("JUDGE_ENDPOINT_INVALID");
  expect(() => parseJudgeEndpoint("https://api.typesafe.ai/x#frag")).toThrow("JUDGE_ENDPOINT_INVALID");
  expect(() => parseJudgeEndpoint("https://api.typesafe.ai/x\nforged")).toThrow("JUDGE_ENDPOINT_INVALID");
  expect(() => parseJudgeEndpoint("https://api.typesafe.ai/x\tforged")).toThrow("JUDGE_ENDPOINT_INVALID");
  expect(() => parseJudgeEndpoint("not a url")).toThrow("JUDGE_ENDPOINT_INVALID");
  expect(parseJudgeEndpoint(SYSTEM_ONE_URL).hostname).toBe("api.typesafe.ai");
  expect(() => createSystemOneJudge({ token: TOKEN, model: "jev-latest\nforged" })).toThrow("JUDGE_NAME_INVALID");
});

test("SystemOneJudge sends one bounded POST and parses the response", async () => {
  const calls: { url: string; auth: string | null; body: { model: string; questions: Record<string, unknown> } }[] = [];
  const judge = createSystemOneJudge({
    token: TOKEN,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ model: "jev-latest", answers: { route: { choice: "route_1", confidence: 0.77, probabilities: { route_0: 0.23, route_1: 0.77 } } } }), { status: 200 });
    }) as typeof fetch,
  });
  const answers = await judge.ask({ task: "fix the flaky test" }, {
    route: { type: "choice", instructions: "pick one", criteria: { route_0: "claude", route_1: "devin" } },
  });
  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toBe(SYSTEM_ONE_URL);
  expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
  expect(calls[0]!.body.model).toBe("jev-latest");
  expect(answers.answers.route?.type === "choice" && answers.answers.route.choice === "route_1").toBe(true);
  await expect(judge.ask("x".repeat(200 * 1024), { q: { type: "noul", instructions: "?" } })).rejects.toThrow("JUDGE_STATE_LIMIT");
});

test("key resolution is environment-first with the vendor name second", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xcb-judge-test-")));
  try {
    await chmod(root, 0o700);
    expect(await resolveJudgeKey(root, cleanEnv)).toBe(null);
    expect((await resolveJudgeKey(root, envWith({ [JUDGE_KEY_VENDOR_ENV]: "vendor-key" })))?.token).toBe("vendor-key");
    const both = envWith({ [JUDGE_KEY_ENV]: "xcb-key", [JUDGE_KEY_VENDOR_ENV]: "vendor-key" });
    expect((await resolveJudgeKey(root, both))?.token).toBe("xcb-key");
    await storeJudgeKey(root, "vaulted-key");
    expect((await resolveJudgeKey(root, cleanEnv))).toEqual({ token: "vaulted-key", source: "vault" });
    expect((await resolveJudgeKey(root, envWith({ [JUDGE_KEY_ENV]: "env-wins" })))?.source).toBe("env");
    // An invalid environment value falls through to the vault rather than failing.
    expect((await resolveJudgeKey(root, envWith({ [JUDGE_KEY_ENV]: "has whitespace" })))?.token).toBe("vaulted-key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the vault refuses to clobber and rejects planted files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xcb-judge-test-")));
  try {
    await chmod(root, 0o700);
    expect(await hasJudgeKey(root)).toBe(false);
    await expect(storeJudgeKey(root, "not a valid token")).rejects.toThrow("JUDGE_KEY_INVALID");
    await storeJudgeKey(root, TOKEN);
    expect(await hasJudgeKey(root)).toBe(true);
    const stat = await lstat(join(root, JUDGE_TOKEN_FILE));
    expect((stat.mode & 0o777) === 0o600).toBe(true);
    await expect(storeJudgeKey(root, "another-key")).rejects.toThrow("JUDGE_KEY_EXISTS");
    const file = join(root, JUDGE_TOKEN_FILE);
    await chmod(file, 0o644);
    await expect(resolveJudgeKey(root, cleanEnv)).rejects.toThrow("JUDGE_KEY_UNAVAILABLE");
    await chmod(file, 0o600);
    expect(await removeJudgeKey(root)).toBe(true);
    expect(await removeJudgeKey(root)).toBe(false);
    const outside = join(root, "outside");
    await writeFile(outside, TOKEN, { mode: 0o600 });
    await symlink(outside, file);
    await expect(resolveJudgeKey(root, cleanEnv)).rejects.toThrow("JUDGE_KEY_UNAVAILABLE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveJudge stays null when disabled or unkeyed and never leaks the token", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xcb-judge-test-")));
  try {
    await chmod(root, 0o700);
    expect(await resolveJudge({ stateRoot: root, enabled: false, env: envWith({ [JUDGE_KEY_ENV]: TOKEN }) })).toBe(null);
    expect(await resolveJudge({ stateRoot: root, enabled: true, env: cleanEnv })).toBe(null);
    const judge = await resolveJudge({ stateRoot: root, enabled: true, env: envWith({ [JUDGE_KEY_ENV]: TOKEN }) });
    expect(judge).not.toBe(null);
    expect(JSON.stringify(judge).includes(TOKEN)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
