import type { Metadata } from "next";
import { AskAiAboutThis } from "@hraness/ui";

import { publishedRelease } from "../publication";
import { readmeHtml, readmeTitle } from "../readme.generated";

export const metadata: Metadata = {
  title: `${readmeTitle} documentation`,
  description: "xcb documentation: the native terminal direction, local accounts, panes, extensions, and the retained xcb compatibility package.",
  alternates: { canonical: "/docs" },
  openGraph: {
    title: `${readmeTitle} documentation`,
    description: "The complete xcb README.",
    type: "article",
    siteName: "xcb",
    url: "/docs",
  },
  twitter: {
    card: "summary_large_image",
    title: `${readmeTitle} documentation`,
    description: "The complete xcb README.",
  },
};

export default function Docs() {
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <main id="main" tabIndex={-1} className="document-page">
        <nav aria-label="Site" className="document-nav">
          <a href="/">xcb home</a>
          <a href="https://github.com/hraness/xcb">Source on GitHub</a>
          <a href="https://github.com/hraness/xcb/releases">Releases</a>
        </nav>
        {publishedRelease === null && <p>Source preview: the installation steps below build native xcb from source. No xcb package or native release is published. <a href="https://github.com/hraness/xcb/releases">Check published releases before installing</a>.</p>}
        <article dangerouslySetInnerHTML={{ __html: readmeHtml }} />
      </main>
      <AskAiAboutThis className="ask-ai" url="https://xcb.dev/docs" />
    </>
  );
}
