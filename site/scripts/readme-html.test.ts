import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { LANDING_END, LANDING_START, readmeLanding, renderReadmeHtml } from "./readme-html.ts";
import { publishedReadme } from "./published-readme.ts";

const repository = join(import.meta.dir, "..", "..");

test("site installation coordinates stay on the admitted release while new source is prepared", () => {
  const source = [
    "bun add https://github.com/hraness/xcb/releases/download/v0.1.2/hraness-agentmixer-0.1.2.tgz",
    "npm install @hraness/agentmixer@0.1.2",
    "bun add github:hraness/xcb#v0.1.2",
    "Version 0.1.2 and historical @hraness/agentmixer@0.1.0 remain prose.",
    "Unrelated @hraness/agentmixer@0.1.20 and hraness/xcb#v0.1.2-beta.1 stay literal.",
  ].join("\n");
  const projected = publishedReadme(source, "0.1.2", "0.1.1");
  expect(projected).toContain("/v0.1.1/hraness-agentmixer-0.1.1.tgz");
  expect(projected).toContain("npm install @hraness/agentmixer@0.1.1");
  expect(projected).toContain("hraness/xcb#v0.1.1");
  expect(projected).toContain("Version 0.1.2 and historical @hraness/agentmixer@0.1.0 remain prose.");
  expect(projected).toContain("Unrelated @hraness/agentmixer@0.1.20 and hraness/xcb#v0.1.2-beta.1 stay literal.");
  expect(publishedReadme(source, "0.1.2", "0.1.2")).toBe(source);
  expect(publishedReadme(source, "0.1.2", null)).toBe(source);
  expect(() => publishedReadme(source, "0.1.2", "latest")).toThrow();
});

test("renders the repository README with stable heading fragments and repository-rooted relative links", async () => {
  const source = await readFile(join(repository, "README.md"), "utf8");
  const html = renderReadmeHtml(source);
  expect(html).toContain('<h2 id="standalone-package">Standalone package</h2>');
  expect(html).toContain('<h2 id="application-owned-capability-profiles">Application-owned capability profiles</h2>');
  expect(html).toContain('href="https://github.com/hraness/xcb/blob/main/MANAGED-CODEX.md"');
  expect(html).not.toContain("<script");
});

test("extracts the landing block between the shared Hraness markers", async () => {
  const source = await readFile(join(repository, "README.md"), "utf8");
  expect(source.indexOf(LANDING_START)).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(LANDING_END)).toBeGreaterThan(source.indexOf(LANDING_START));
  const landing = readmeLanding(source);
  expect(landing.title).toBe("xcb");
  expect(landing.lead).toContain("terminal-first workspace");
  expect(landing.markdown).toContain("composable extensions");
});

test("rejects unsafe README link targets", () => {
  expect(() => renderReadmeHtml("[x](javascript:alert(1))")).toThrow("disallowed URL scheme");
  expect(() => renderReadmeHtml("[x](//evil.example)")).toThrow("protocol-relative");
  expect(() => renderReadmeHtml("[x](#missing)")).toThrow("no rendered heading");
});


test("omits repository landing markers", async () => {
  const source = await Bun.file(new URL("../../README.md", import.meta.url)).text();
  const html = renderReadmeHtml(source);
  expect(html).not.toContain("hraness:xcb-landing");
});


describe("README HTML boundary", () => {
  test("derives stable fragments from parsed heading text", () => {
    const html = renderReadmeHtml([
      "## **Hello** &amp; `world`",
      "## **Hello** &amp; `world`",
      "[First](#hello--world) [Again](#hello--world-1)",
    ].join("\n\n"));
    expect(html).toContain('<h2 id="hello--world"><strong>Hello</strong> &amp; <code>world</code></h2>');
    expect(html).toContain('<h2 id="hello--world-1">');
  });

  test("keeps raw and nested malformed HTML inert, including inside headings", () => {
    const payloads = [
      '<script>alert(1)</script>',
      '<sc<script>ript>alert(1)</sc</script>ript>',
      '<img src="x" onerror="alert(1)">',
      '<svg onload="alert(1)"><a href="javascript:alert(1)">x</a></svg>',
      '<textarea><img src=x onerror=alert(1)></textarea>',
    ];
    for (const payload of payloads) {
      const html = renderReadmeHtml(`## Literal ${payload}\n\n${payload}`);
      const elements: string[] = [];
      const ids: string[] = [];
      new HTMLRewriter().on("*", {
        element(element) {
          elements.push(element.tagName);
          for (const [name] of element.attributes) expect(name).not.toMatch(/^on/iu);
          const id = element.getAttribute("id");
          if (id !== null) ids.push(id);
        },
      }).transform(html);
      expect(elements).toEqual(["h2", "p"]);
      expect(ids).toHaveLength(1);
      expect(ids[0]).toMatch(/^[\p{Letter}\p{Mark}\p{Number}_-]+$/u);
      expect(html).toContain("&lt;");
    }
  });

  test("rejects executable and protocol-relative Markdown URLs", () => {
    for (const target of ["javascript:alert", "java&#x73;cript:alert", "data:text/html,bad", "//example.com"]) {
      expect(() => renderReadmeHtml(`[link](${target})`)).toThrow();
      expect(() => renderReadmeHtml(`![image](${target})`)).toThrow();
    }
    expect(renderReadmeHtml("[Reference](docs/example.md)")).toContain(
      'href="https://github.com/hraness/xcb/blob/main/docs/example.md"',
    );
  });
});
