import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { boundedText } from "./validation.ts";

/**
 * Provider-neutral judgment port ("jev-style"): one fast request answers a
 * batch of typed questions against one state object. A `Judge` is a routing,
 * classification, and continuation helper — never an execution or custody
 * boundary. Every consumer keeps a deterministic path when no judge is
 * configured or a call fails, and bounds what it sends.
 *
 * Question kinds mirror the System One wire shape so additional backends can
 * implement the same port: `noul` (yes/no probability), `choice` (pick one of
 * labelled options with confidence), and `score` (score against criteria).
 */

export type JudgeState = string | object;

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}
export type JudgeQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JudgeQuestions = Record<string, JudgeQuestion>;

export interface NoulAnswer { type: "noul"; noul: number }
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}
export type JudgeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JudgeAnswers {
  answers: Record<string, JudgeAnswer>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Anything that can answer a batch of judgment questions. */
export interface Judge {
  ask(state: JudgeState, questions: JudgeQuestions): Promise<JudgeAnswers>;
}

export const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JUDGE_MODEL = "jev-latest";
export const JUDGE_TOKEN_FILE = "jev-api-token";
export const JUDGE_KEY_ENV = "XCB_JEV_API_KEY";
export const JUDGE_KEY_VENDOR_ENV = "TYPESAFE_API_KEY";
export const JUDGE_URL_ENV = "XCB_JEV_URL";
export const JUDGE_MODEL_ENV = "XCB_JEV_MODEL";

export const MAX_JUDGE_STATE_BYTES = 128 * 1024;
export const MAX_JUDGE_QUESTIONS = 64;
export const MAX_JUDGE_INSTRUCTION_BYTES = 4 * 1024;
const MAX_JUDGE_NAME_BYTES = 160;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TOKEN_BYTES = 2048;
const REQUEST_TIMEOUT_MS = 15_000;

const fail = (code: string): never => { throw new Error(code); };
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fail("JUDGE_ANSWER_MALFORMED");
const probability = (value: unknown): number => {
  const result = finite(value);
  return result >= 0 && result <= 1 ? result : fail("JUDGE_ANSWER_RANGE");
};
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.\[\]-]*$/u;

function checkName(name: string): string {
  if (typeof name !== "string" || !NAME.test(name) || bytes(name) > MAX_JUDGE_NAME_BYTES) {
    fail("JUDGE_NAME_INVALID");
  }
  return name;
}

/** Validates a question batch before it reaches any backend. */
export function checkJudgeQuestions(questions: JudgeQuestions): JudgeQuestions {
  if (questions === null || typeof questions !== "object" || Array.isArray(questions)) {
    fail("JUDGE_QUESTIONS_INVALID");
  }
  const names = Object.keys(questions);
  if (names.length === 0 || names.length > MAX_JUDGE_QUESTIONS) fail("JUDGE_QUESTIONS_LIMIT");
  for (const name of names) {
    checkName(name);
    const question = questions[name]!;
    if (question === null || typeof question !== "object") fail("JUDGE_QUESTION_INVALID");
    boundedText(question.instructions, MAX_JUDGE_INSTRUCTION_BYTES);
    if (question.type === "noul") {
      if (question.criteria !== undefined) {
        if (typeof question.criteria !== "object") fail("JUDGE_CRITERIA_INVALID");
        for (const text of [question.criteria.true, question.criteria.false]) {
          if (text !== undefined) boundedText(text, MAX_JUDGE_INSTRUCTION_BYTES);
        }
      }
    } else if (question.type === "choice") {
      const options = Object.keys(question.criteria ?? {});
      if (options.length === 0 || options.length > 64) fail("JUDGE_OPTIONS_LIMIT");
      for (const option of options) {
        checkName(option);
        const description = question.criteria[option];
        if (description !== null) boundedText(description, MAX_JUDGE_INSTRUCTION_BYTES);
      }
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length === 0
        || question.criteria.length > 16) fail("JUDGE_CRITERIA_LIMIT");
      for (const criterion of question.criteria) {
        boundedText(criterion, MAX_JUDGE_INSTRUCTION_BYTES);
      }
    } else {
      fail("JUDGE_QUESTION_TYPE");
    }
  }
  return questions;
}

/** Validates the serialized state before it reaches any backend. */
export function checkJudgeState(state: JudgeState): JudgeState {
  if (typeof state !== "string" && (state === null || typeof state !== "object")) {
    fail("JUDGE_STATE_INVALID");
  }
  const size = bytes(JSON.stringify(state));
  if (size === 0 || size > MAX_JUDGE_STATE_BYTES) fail("JUDGE_STATE_LIMIT");
  return state;
}

function parseAnswer(name: string, value: unknown): JudgeAnswer {
  checkName(name);
  if (value === null || typeof value !== "object") fail(`JUDGE_ANSWER_MALFORMED:${name}`);
  const answer = value as Record<string, unknown>;
  const kinds = (["noul", "choice", "score"] as const).filter(kind => kind in answer);
  const kind = kinds[0];
  if (kind === undefined || kinds.length !== 1 || (answer.type !== undefined && answer.type !== kind)) {
    return fail("JUDGE_ANSWER_MALFORMED");
  }
  if (kind === "noul") return { type: "noul", noul: probability(answer.noul) };
  const probabilities = answer.probabilities;
  if (probabilities === null || typeof probabilities !== "object" || Array.isArray(probabilities)) {
    return fail("JUDGE_ANSWER_MALFORMED");
  }
  const entries = Object.entries(probabilities as Record<string, unknown>)
    .map(([key, value]) => [checkName(key), probability(value)] as const);
  if (entries.length === 0) return fail("JUDGE_ANSWER_MALFORMED");
  if (kind === "choice") {
    if (typeof answer.choice !== "string") return fail("JUDGE_ANSWER_MALFORMED");
    return {
      type: "choice",
      choice: checkName(answer.choice),
      confidence: probability(answer.confidence),
      probabilities: Object.fromEntries(entries),
    };
  }
  return {
    type: "score",
    score: finite(answer.score),
    confidence: probability(answer.confidence),
    probabilities: Object.fromEntries(entries),
  };
}

/** Validates a System One response body; throws on anything malformed. */
export function parseJudgeResponse(status: number, body: string): JudgeAnswers {
  if (status < 200 || status >= 300) {
    if (status === 401 || status === 403) fail("JUDGE_KEY_REJECTED");
    if (status === 429) fail("JUDGE_RATE_LIMITED");
    fail("JUDGE_REQUEST_FAILED");
  }
  if (bytes(body) > MAX_RESPONSE_BYTES) fail("JUDGE_RESPONSE_LIMIT");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail("JUDGE_RESPONSE_MALFORMED");
  }
  if (parsed === null || typeof parsed !== "object") fail("JUDGE_RESPONSE_MALFORMED");
  const response = parsed as Record<string, unknown>;
  const raw = response.answers;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("JUDGE_RESPONSE_MALFORMED");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) fail("JUDGE_RESPONSE_MALFORMED");
  const answers: Record<string, JudgeAnswer> = {};
  for (const [name, value] of entries) answers[name] = parseAnswer(name, value);
  const result: JudgeAnswers = { answers };
  const responseModel = response.model;
  if (responseModel !== undefined) {
    if (typeof responseModel !== "string") return fail("JUDGE_RESPONSE_MALFORMED");
    result.model = checkName(responseModel);
  }
  const usage = response.usage;
  if (usage !== undefined) {
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
      return fail("JUDGE_RESPONSE_MALFORMED");
    }
    const record = usage as Record<string, unknown>;
    if (Object.keys(record).some(key => !["input_tokens", "output_tokens"].includes(key))) {
      return fail("JUDGE_RESPONSE_MALFORMED");
    }
    const admitted: { input_tokens?: number; output_tokens?: number } = {};
    for (const key of ["input_tokens", "output_tokens"] as const) {
      const value = record[key];
      if (value !== undefined) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          return fail("JUDGE_RESPONSE_MALFORMED");
        }
        admitted[key] = value;
      }
    }
    result.usage = admitted;
  }
  return result;
}

/** Validates a complete response against the exact questions that were sent. */
export function checkJudgeAnswers(questions: JudgeQuestions, response: JudgeAnswers): JudgeAnswers {
  checkJudgeQuestions(questions);
  const names = Object.keys(questions), answered = Object.keys(response.answers);
  if (answered.length !== names.length || names.some(name => !(name in response.answers))) {
    return fail("JUDGE_RESPONSE_QUESTION_MISMATCH");
  }
  for (const name of names) {
    const question = questions[name]!, answer = response.answers[name]!;
    if (answer.type === "choice") {
      if (question.type !== "choice") return fail("JUDGE_RESPONSE_TYPE_MISMATCH");
      const criteria = question.criteria, buckets = Object.keys(answer.probabilities);
      if (!(answer.choice in criteria) || !(answer.choice in answer.probabilities)
        || buckets.length === 0 || buckets.some(bucket => !(bucket in criteria))) {
        return fail("JUDGE_RESPONSE_OPTION_MISMATCH");
      }
    } else if (answer.type === "score") {
      if (question.type !== "score") return fail("JUDGE_RESPONSE_TYPE_MISMATCH");
      const criteria = question.criteria, buckets = Object.keys(answer.probabilities);
      if (answer.score < 0 || answer.score > criteria.length - 1 || buckets.length === 0
        || buckets.some(bucket => !/^(0|[1-9][0-9]*)$/u.test(bucket)
          || Number(bucket) >= criteria.length)) {
        return fail("JUDGE_RESPONSE_SCORE_MISMATCH");
      }
    } else if (question.type !== "noul") {
      return fail("JUDGE_RESPONSE_TYPE_MISMATCH");
    }
  }
  return response;
}

/** Where a resolved judge key came from; `status` reports it, secrets never print. */
export type JudgeKeySource = "env" | "vault";

function validJudgeToken(token: string): boolean {
  return token.length > 0 && token.length <= 512 && /^[A-Za-z0-9_\-.=+]+$/u.test(token);
}

/** One HTTPS endpoint the judge may call; only `https` with a clean authority. */
export function parseJudgeEndpoint(url: string): URL {
  boundedText(url, 1024);
  if (/[\u0000-\u0020\u007f]/u.test(url)) fail("JUDGE_ENDPOINT_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail("JUDGE_ENDPOINT_INVALID");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== "" || parsed.hostname === "") {
    return fail("JUDGE_ENDPOINT_INVALID");
  }
  return parsed;
}

export interface SystemOneOptions {
  /** The API key. Never logged or persisted by the client. */
  token: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Defaults to the System One endpoint. */
  endpoint?: string;
  /** Injectable transport for tests; defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Request timeout in ms; defaults to 15000. */
  timeoutMs?: number;
}

/** The TypeSafe System One backend: a `Judge` over one bounded HTTPS POST. */
export function createSystemOneJudge(options: SystemOneOptions): Judge {
  if (!validJudgeToken(options.token)) fail("JUDGE_KEY_INVALID");
  const endpoint = parseJudgeEndpoint(options.endpoint ?? SYSTEM_ONE_URL).toString();
  const model = checkName(options.model ?? DEFAULT_JUDGE_MODEL);
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) fail("JUDGE_TIMEOUT_INVALID");
  return Object.freeze({
    async ask(state: JudgeState, questions: JudgeQuestions): Promise<JudgeAnswers> {
      checkJudgeState(state);
      checkJudgeQuestions(questions);
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ model, state, questions }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      return checkJudgeAnswers(
        questions,
        parseJudgeResponse(response.status, await boundedBody(response)),
      );
    },
  });
}

/** Reads a response body with a hard cap — `response.text()` alone would
 * buffer whatever a hostile endpoint streams before validation runs. */
async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return response.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      fail("JUDGE_RESPONSE_LIMIT");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

const JUDGE_TOKEN_MAX = MAX_TOKEN_BYTES;

/** Stores a judge key in the private state root; refuses to clobber. */
export async function storeJudgeKey(stateRoot: string, key: string | Uint8Array): Promise<void> {
  const token = (typeof key === "string" ? key : new TextDecoder("utf-8", { fatal: true }).decode(key)).trim();
  if (!validJudgeToken(token)) fail("JUDGE_KEY_INVALID");
  const root = await privateRoot(stateRoot);
  const path = join(root, JUDGE_TOKEN_FILE);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return fail("JUDGE_KEY_EXISTS");
      return fail("JUDGE_KEY_UNAVAILABLE");
    });
  try {
    await handle.writeFile(token);
  } finally {
    await handle.close();
  }
}

/** Removes the vaulted judge key; returns whether a file was removed. */
export async function removeJudgeKey(stateRoot: string): Promise<boolean> {
  const path = join(await privateRoot(stateRoot), JUDGE_TOKEN_FILE);
  const exists = await lstat(path).then(stat => stat.isFile(), () => false);
  if (!exists) return false;
  await rm(path);
  return true;
}

export async function hasJudgeKey(stateRoot: string): Promise<boolean> {
  try {
    const path = join(await privateRoot(stateRoot), JUDGE_TOKEN_FILE);
    return await lstat(path).then(stat => stat.isFile(), () => false);
  } catch {
    return false;
  }
}

async function privateRoot(stateRoot: string): Promise<string> {
  const actual = await realpath(stateRoot);
  const stat = await lstat(stateRoot);
  if (actual !== stateRoot || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    fail("XCB_DIRECTORY_NOT_PRIVATE");
  }
  return actual;
}

async function vaultKey(stateRoot: string): Promise<string | null> {
  const root = await privateRoot(stateRoot);
  const path = join(root, JUDGE_TOKEN_FILE);
  const buffer = Buffer.alloc(JUDGE_TOKEN_MAX + 1);
  let token: string | null = null;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        return fail("JUDGE_KEY_UNAVAILABLE");
      });
    if (handle === null) return null;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1
        || (before.mode & 0o177) !== 0 || before.size > JUDGE_TOKEN_MAX) {
        fail("JUDGE_KEY_UNAVAILABLE");
      }
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const after = await handle.stat();
      if (size === 0 || size > JUDGE_TOKEN_MAX || size !== before.size
        || after.ino !== before.ino || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        fail("JUDGE_KEY_UNAVAILABLE");
      }
      token = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)).trim();
    } finally {
      await handle.close();
    }
  } finally {
    buffer.fill(0);
  }
  if (token === null || !validJudgeToken(token)) fail("JUDGE_KEY_UNAVAILABLE");
  return token;
}

/** Resolves the effective judge key: environment first, then the vault file. */
export async function resolveJudgeKey(
  stateRoot: string,
  env: (name: string) => string | undefined = (name) => process.env[name],
): Promise<{ token: string; source: JudgeKeySource } | null> {
  for (const name of [JUDGE_KEY_ENV, JUDGE_KEY_VENDOR_ENV]) {
    const value = env(name)?.trim();
    if (value !== undefined && validJudgeToken(value)) {
      return { token: value, source: "env" };
    }
  }
  const token = await vaultKey(stateRoot);
  return token === null ? null : { token, source: "vault" };
}

export interface ResolveJudgeOptions {
  /** Private state root holding the vault file. */
  stateRoot: string;
  /** The judge extension gate; resolution returns null when false. */
  enabled: boolean;
  model?: string;
  endpoint?: string;
  env?: (name: string) => string | undefined;
  fetch?: typeof fetch;
}

/** Resolves a ready judge when enabled and keyed; null for either absence. */
export async function resolveJudge(options: ResolveJudgeOptions): Promise<Judge | null> {
  if (!options.enabled) return null;
  const env = options.env ?? ((name: string) => process.env[name]);
  const key = await resolveJudgeKey(options.stateRoot, env);
  if (key === null) return null;
  const model = options.model ?? env(JUDGE_MODEL_ENV);
  const endpoint = options.endpoint ?? env(JUDGE_URL_ENV);
  return createSystemOneJudge({
    token: key.token,
    ...(model === undefined ? {} : { model }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
