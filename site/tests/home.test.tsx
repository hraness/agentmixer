import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import Home from "../app/page";
import Docs from "../app/docs/page";
import { publishedRelease } from "../app/publication";
import RootLayout from "../app/layout";

test("every public route has one optional support footer without product signup", () => {
  for (const Page of [Home, Docs]) {
    const html = renderToStaticMarkup(<RootLayout><Page /></RootLayout>);
    expect(html.match(/<footer\b/gu)).toHaveLength(1);
    expect(html).toContain("https://account.hraness.com/support?product=xcb&amp;source=web#support");
    expect(html).toContain("Support ongoing development of a local, composable terminal workspace for coding agents.");
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain('source=web#updates');
  }
});

test("the homepage leads with the README identity and the verified install command", () => {
  const html = renderToStaticMarkup(<Home />);
  expect(html.match(/<h1\b/gu)).toHaveLength(1);
  expect(html).toContain("Your agents. Your terminal. Your edge.");
  if (publishedRelease === null) {
    expect(html).toContain("First xcb package release in preparation");
    expect(html).not.toContain(".tgz");
  } else {
    expect(html).toContain(`hraness-xcb-${publishedRelease.version}.tgz`);
    expect(html).toContain("@hraness/xcb");
    expect(html).toContain(publishedRelease.verificationRun);
  }
  expect(html).not.toContain("hraness.com/agentmixer");
});

test("the docs page renders the README with its package anchor", () => {
  const html = renderToStaticMarkup(<Docs />);
  expect(html).toContain('id="standalone-package"');
  expect(html).toContain('id="application-owned-capability-profiles"');
  expect(html).toContain("createCapabilityBroker");
  expect(html).not.toContain("data-hraness-marketing-preset");
});

test("scopes the editorial preset to the homepage header and real contract example", () => {
  const html = renderToStaticMarkup(<Home />);
  const elements: string[] = [];
  new HTMLRewriter()
    .on('[data-hraness-marketing-preset="editorial"] .hraness-marketing-header.hraness-material-chrome', {
      element() { elements.push("header"); },
    })
    .on('[data-hraness-marketing-preset="editorial"] #main .hraness-material-wall .hraness-marketing-proof-frame.hraness-material-pane', {
      element() { elements.push("proof"); },
    })
    .transform(html);
  expect(elements).toEqual(["header", "proof"]);
  expect(html).toContain("The pane is a declaration, not a fork of the harness.");
  expect(html).toContain("Less activity. More signal.");
});
