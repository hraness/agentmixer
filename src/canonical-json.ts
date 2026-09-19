import { createHash } from "node:crypto";

function invalid(code: string): never {
  throw new Error(code);
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid("CANONICAL_JSON_INVALID_UNICODE");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid("CANONICAL_JSON_INVALID_UNICODE");
  }
}

function encodeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("CANONICAL_JSON_NONFINITE_NUMBER");
    if (Object.is(value, -0)) invalid("CANONICAL_JSON_NEGATIVE_ZERO");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") invalid("CANONICAL_JSON_INVALID_VALUE");
  if (ancestors.has(value)) invalid("CANONICAL_JSON_CYCLE");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor?.value;
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) invalid("CANONICAL_JSON_ARRAY_PROPERTY");
      const ownKeys = Reflect.ownKeys(value);
      if (!ownKeys.includes("length") || ownKeys.some(key => key !== "length" && (typeof key !== "string"
        || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length))) invalid("CANONICAL_JSON_ARRAY_PROPERTY");
      const elements: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) invalid("CANONICAL_JSON_SPARSE_ARRAY");
        if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) invalid("CANONICAL_JSON_ARRAY_PROPERTY");
        elements.push(descriptor.value);
      }
      return `[${elements.map(element => encodeCanonical(element, ancestors)).join(",")}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid("CANONICAL_JSON_NONPLAIN_OBJECT");
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== "string")) invalid("CANONICAL_JSON_OBJECT_PROPERTY");
    const entries = (ownKeys as string[]).map((key): readonly [string, unknown] => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
        invalid("CANONICAL_JSON_OBJECT_PROPERTY");
      }
      return [key, descriptor.value];
    });
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, member]) => {
      assertUnicodeScalarString(key);
      return `${JSON.stringify(key)}:${encodeCanonical(member, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return encodeCanonical(value, new Set());
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
