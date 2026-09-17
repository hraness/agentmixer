import type { Metadata } from "next";
import { AskAiAboutThis } from "@hraness/ui";

import { publishedRelease } from "../publication";
import { readmeHtml, readmeTitle } from "../readme.generated";

export const metadata: Metadata = {
  title: `${readmeTitle} documentation`,
  description: "The complete AgentMixer README: adapters, qualification, account custody, capability profiles, and release notes.",
  alternates: { canonical: "/docs" },
  openGraph: {
    title: `${readmeTitle} documentation`,
    description: "The complete AgentMixer README.",
    type: "article",
    siteName: "AgentMixer",
    url: "/docs",
  },
  twitter: {
    card: "summary_large_image",
    title: `${readmeTitle} documentation`,
    description: "The complete AgentMixer README.",
  },
};

export default function Docs() {
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <main id="main" tabIndex={-1} className="document-page">
        <nav aria-label="Site" className="document-nav">
          <a href="/">AgentMixer home</a>
          <a href="https://github.com/hraness/agentmixer">Source on GitHub</a>
          <a href="https://github.com/hraness/agentmixer/releases">Releases</a>
        </nav>
        {publishedRelease === null && <p>Release preview: the installation examples below target the forthcoming AgentMixer release. <a href="https://github.com/hraness/agentmixer/releases">Check published releases before installing</a>.</p>}
        <article dangerouslySetInnerHTML={{ __html: readmeHtml }} />
      </main>
      <AskAiAboutThis className="ask-ai" url="https://agentmixer.dev/docs" />
    </>
  );
}
