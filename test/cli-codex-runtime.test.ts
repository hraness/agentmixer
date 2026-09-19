import { expect, test } from "bun:test";
import { resolve } from "node:path";

// Isolated Node subprocesses cover Node and drifted Bun parents without changing
// this test runner or launching a provider process.
for (const runtime of ["undefined", "{ version: '1.3.13' }"]) {
  test.skipIf(Bun.which("node") === null)(`Codex rejects unsupported parent runtime ${runtime} with an actionable diagnostic`, async () => {
    const moduleUrl = new URL("../src/cli/codex.ts", import.meta.url).href;
    const code = `import { cliCodexHostDiagnostic, qualifyCliCodexRuntime } from ${JSON.stringify(moduleUrl)};
      Object.defineProperty(globalThis, "Bun", { value: ${runtime}, configurable: true });
      console.log(cliCodexHostDiagnostic());
      try { await qualifyCliCodexRuntime({ stateRoot: "/unused", inspection: {} }); }
      catch (error) { console.log(error.message); }`;
    const child = Bun.spawn([Bun.which("node")!, "--experimental-transform-types", "--no-warnings", "--input-type=module", "--eval", code], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("requires Bun 1.3.14");
    expect(stdout).toContain("CLI_CODEX_BUN_REQUIRED");
    expect(stdout).not.toContain("ReferenceError");
  });
}
