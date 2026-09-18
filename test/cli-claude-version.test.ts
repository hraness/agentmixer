import { describe, expect, test } from "bun:test";

import {
  CLAUDE_CODE_MAX_MAJOR,
  CLAUDE_CODE_MIN_VERSION,
  CLAUDE_SDK_CODE_VERSION,
  claudeCodeVersionAdmitted,
} from "../src/claude-sdk.ts";

describe("claude code version admission", () => {
  test("the floor is a bounded major line, not an exact pin", () => {
    expect(CLAUDE_CODE_MIN_VERSION).toBe("2.1.268");
    expect(CLAUDE_CODE_MAX_MAJOR).toBe(2);
    expect(CLAUDE_SDK_CODE_VERSION).toBe("2.1.268");
    for (const admitted of ["2.1.268", "2.1.269", "2.1.300", "2.2.0", "2.99.0"]) {
      expect(claudeCodeVersionAdmitted(admitted), admitted).toBe(true);
    }
    for (const rejected of [
      "2.1.267", "2.0.9", "1.9.9", "3.0.0", "10.1.268", "2.1", "2.1.268.1", "2.1.x", "v2.1.268", "2.1.268-beta", "",
    ]) {
      expect(claudeCodeVersionAdmitted(rejected), rejected).toBe(false);
    }
  });
});
