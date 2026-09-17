import {
  MarketingCallToAction,
  MarketingInstallPanel,
  MarketingInterfaceGrid,
  MarketingMaker,
  MarketingPage,
  MarketingPrimitives,
  MarketingProofFrame,
  MarketingQuestionList,
  MarketingSection,
  MarketingSiteHeader,
  MarketingTrustBoundary,
  ProductHero,
} from "@hraness/design-kit/react/server";
import { ThemeMenuButton } from "@hraness/design-kit/react";
import { AskAiAboutThis } from "@hraness/ui";

import { publishedRelease } from "./publication";
import { readmeLead, readmeTitle } from "./readme.generated";

function TopicIcon({ slug }: Readonly<{ slug: string }>) {
  return (
    <img className="agentmixer-topic-icon" src={`/icons/${slug}.svg`} alt="" aria-hidden="true" width="88" height="88" loading="lazy" decoding="async" />
  );
}

const releaseVersion = publishedRelease?.version;
const repository = "https://github.com/hraness/agentmixer";
const archiveUrl = releaseVersion === undefined ? null : `${repository}/releases/download/v${releaseVersion}/hraness-agentmixer-${releaseVersion}.tgz`;

const heading = "One qualified seam between your application and its agents";
const footnote =
  `Free and MIT licensed. Bun 1.3.14 or newer, or Node 22.13 or newer.${releaseVersion === undefined ? " First AgentMixer release in preparation." : ` Current verified release v${releaseVersion}.`}`;

const primitives = [
  {
    icon: "provider-adapters",
    label: "Provider adapters",
    summary: "Claude SDK, Claude API, and Codex adapters sit behind one runtime interface. An adapter stays disabled until the host proves the exact runtime, tool inventory, and confinement it claims.",
  },
  {
    icon: "account-custody",
    label: "Account custody",
    summary: "Provider accounts are opaque host bindings on shared SQLite leases with generation fencing. A failed or ambiguous call retains its lease; recovery needs independent proof the old process stopped.",
  },
  {
    icon: "tool-broker",
    label: "Tool broker",
    summary: "One workspace and one run get a closed set of file, public-web, and messaging operations. There is no shell, executable, or arbitrary RPC operation for a model to reach for.",
  },
  {
    icon: "model-selection",
    label: "Model selection",
    summary: "Classifier output is strictly validated and models are selected from a fresh, host-observed catalog — never from a stale index or a model's own claims.",
  },
  {
    icon: "capability-profiles",
    label: "Capability profiles",
    summary: "Applications define their own tools with createCapabilityProfile() and bind them per workspace and run. The host supplies every descriptor, parser, and handler.",
  },
  {
    icon: "public-web-port",
    label: "Public web port",
    summary: "createPublicWeb() admits bounded HTTPS GETs only: address pinning, per-redirect validation, no ambient credentials, a 15-second deadline, and a 256 KiB text cap.",
  },
] as const;

const trust = [
  {
    label: "Closed and bounded",
    detail: "Broker inputs are serialized, copied before queuing, and capped at 256 KiB with structural limits. Unknown tools are denied; model arguments cannot replace the bound workspace, credentials, or handlers.",
  },
  {
    label: "Qualification, not convention",
    detail: "Admission requires the host to prove the exact runtime, effective tool inventory, configuration isolation, and read/write confinement. A prompt, a cwd, or an expired lease proves nothing.",
  },
  {
    label: "The application owns the product",
    detail: "Enrollment, message policy, memory format, and dispatch authorization stay in the host. AgentMixer owns only the execution seam — messaging ports stage proposed actions and never send.",
  },
] as const;

const questions = [
  {
    question: "What is AgentMixer?",
    answer: "A provider-neutral TypeScript package for applications that run coding agents. It supplies the adapter interface, account-lease custody, model selection, and a scoped tool broker; the application supplies workspaces, credentials, and authorization.",
  },
  {
    question: "Which providers does it support?",
    answer: "Claude through the Agent SDK and a direct API adapter, and Codex through managed account, task, and session adapters. Every adapter must pass explicit runtime qualification before it can run — an unqualified adapter stays disabled.",
  },
  {
    question: "Who uses it today?",
    answer: "Textbutler, the macOS message-butler daemon, is the first consumer. Its contact-confined workspace and brokered messaging are built on these contracts.",
  },
  {
    question: "What does the broker refuse to do?",
    answer: "There is no shell, no arbitrary process execution, no plugin loading, and no RPC escape hatch. Messaging ports stage recipient-bound proposals and return an intent ID; only the application's dispatch boundary can send.",
  },
  {
    question: "How is it published?",
    answer: "Each release is an immutable GitHub Release with a packing receipt, checksums, and signed provenance. The same archive bytes are published to npm from the tag workflow through OIDC trusted publishing.",
  },
  {
    question: "Who made it?",
    answer: "Ben Guo, a musician and builder, formerly a founder and engineering leader at companies including Venmo and Stripe, now building from Puerto Rico. AgentMixer is published by Hraness under the MIT license.",
  },
] as const;

const navigation = [
  { href: "#model", label: "Contract" },
  { href: "#interfaces", label: "Interfaces" },
  { href: "#install", label: "Install" },
  { href: "/docs", label: "Docs" },
  { href: repository, label: "GitHub" },
] as const;

function BrandMark() {
  return <img alt="" height={20} src="/icon.png" width={20} />;
}

export default function Home() {
  const structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareSourceCode",
      codeRepository: repository,
      description: readmeLead,
      license: "https://opensource.org/license/mit",
      name: readmeTitle,
      programmingLanguage: "TypeScript",
      runtimePlatform: "Bun",
      url: "https://agentmixer.dev",
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: questions.map(({ answer, question }) => ({
        "@type": "Question",
        acceptedAnswer: { "@type": "Answer", text: answer },
        name: question,
      })),
    },
  ];

  return (
    <div data-hraness-marketing-preset="editorial">
      <script
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        type="application/ld+json"
      />
      <a className="skip-link" href="#main">Skip to content</a>
      <MarketingSiteHeader
        className="hraness-material-chrome"
        action={{ href: "#install", label: "Install AgentMixer" }}
        brand={<><BrandMark />AgentMixer</>}
        brandLabel="AgentMixer home"
        links={navigation}
        trailing={<ThemeMenuButton aria-label="Appearance" />}
      />

      <main id="main" tabIndex={-1}>
        <MarketingPage>
          <div className="hraness-material-wall">
          <ProductHero
            align="start"
            actions={[
              { href: "#install", label: "Install AgentMixer" },
              { href: "/docs", label: "Read the docs" },
            ]}
            boundary={footnote}
            className="agentmixer-marketing-hero"
            eyebrow=""
            frame={(
              <MarketingProofFrame
                className="hraness-material-pane"
                caption="A host-defined capability profile: one bounded tool, bound to one workspace and one run."
                credit="From the README"
                title="Give the agent only the tools the host declared"
              >
                <pre className="transcript" tabIndex={0}><code>{`const profile = createCapabilityProfile({
  id: "notes", version: 1,
  tools: [{
    name: "notes.write",
    description: "Replace the bound workspace's note.",
    inputSchema: { /* bounded schema */ },
    parseInput(input) { /* trusted parser */ },
    execute(input, context) {
      context.assertActive();
      notes.set(context.workspaceId, input);
      return { stored: true };
    },
  }],
});
const broker = createCapabilityBroker({
  profile, workspaceId: "workspace-1", runId: "run-1",
  isActive: () => hostState.active,
});
await broker.invoke("notes.write", { text: "First note." });`}</code></pre>
              </MarketingProofFrame>
            )}
            heading={heading}
            headingId="hero-title"
            name=""
            summary={readmeLead}
          />
          </div>

          <MarketingPrimitives
            heading="Explicit contracts, derived nothing."
            headingId="model-title"
            id="model"
            items={primitives.map((primitive) => ({
              example: <TopicIcon slug={primitive.icon} />,
              label: primitive.label,
              summary: primitive.summary,
            }))}
            label=""
            summary="AgentMixer supplies the execution seam: routing, custody, and a closed tool surface. Everything the agent can touch is declared by the host and bounded before the run begins."
          />

          <MarketingInterfaceGrid
            heading="One seam, three surfaces."
            headingId="interfaces-title"
            id="interfaces"
            interfaces={[
              {
                label: "Runtime API",
                summary: "Route one qualified agent run with an explicit request: route, account, profile, model, effort, and limits.",
                example: (
                  <>
                    <TopicIcon slug="sdk" />
                    <pre tabIndex={0}><code>{`import { AgentMixer } from "@hraness/agentmixer";

const mixer = new AgentMixer({ adapters, catalog });
const result = await mixer.run(request, broker);`}</code></pre>
                  </>
                ),
              },
              {
                label: "Capability broker",
                summary: "Define application-owned tools and bind them to one workspace and run, with host-supplied parsers and handlers.",
                example: (
                  <>
                    <TopicIcon slug="tool-broker" />
                    <pre tabIndex={0}><code>{`const broker = createCapabilityBroker({
  profile, workspaceId, runId, isActive,
});
await broker.invoke("notes.write", input);
await broker.close();`}</code></pre>
                  </>
                ),
              },
              {
                label: "Provider adapters",
                summary: "Claude SDK, Claude API, and Codex adapters behind explicit runtime qualification.",
                example: (
                  <>
                    <TopicIcon slug="provider-adapters" />
                    {releaseVersion === undefined ? <p>The first AgentMixer release is in preparation.</p> : <pre tabIndex={0}><code>{`bun add @hraness/agentmixer@${releaseVersion}`}</code></pre>}
                    <p className="interface-link"><a href={`${repository}/blob/main/MANAGED-CODEX.md`}>Read the managed Codex contract</a></p>
                  </>
                ),
              },
            ]}
            label=""
            summary="The runtime, the broker, and the adapters share one qualification contract. There is no agent-only path behind the declared one."
          />

          <MarketingSection
            heading="What AgentMixer will not do."
            headingId="boundary-title"
            id="boundary"
            label=""
            summary="AgentMixer refuses to let model output become authority, and refuses to let a lease lapse become a takeover."
          >
            <MarketingTrustBoundary
              heading="Small enough to qualify."
              headingId="kernel-title"
              id="kernel"
              items={trust}
              label=""
              summary="These rules are enforced by the runtime, the broker, and their tests — not by convention."
            />
          </MarketingSection>

          <MarketingInstallPanel
            eyebrow=""
            heading="Install the package."
            headingId="install-title"
            id="install"
          >
            <p className="install-note">{releaseVersion === undefined ? "First AgentMixer release in preparation" : `Current verified release · v${releaseVersion}`}</p>
            {publishedRelease !== null && archiveUrl !== null ? (
              <>
                <pre className="install-command" tabIndex={0}><code>{`bun add ${archiveUrl}`}</code></pre>
                <pre className="install-command" tabIndex={0}><code>{`import { AgentMixer, createCapabilityBroker } from "@hraness/agentmixer";`}</code></pre>
                <p className="install-note">
                  <a href={publishedRelease.verificationRun}>Public release verification</a>.{" "}
                  GitHub Releases are the canonical distribution. Needs Bun 1.3.14 or newer.{" "}
                  <a href="/docs#standalone-package">Read the full package reference</a>.
                </p>
              </>
            ) : (
              <p className="install-note">
                AgentMixer is being prepared for its first release.{" "}
                <a href={`${repository}/releases`}>Check published releases</a> or{" "}
                <a href="/docs">read the documentation</a>.
              </p>
            )}
          </MarketingInstallPanel>

          <MarketingQuestionList
            heading="Before you install."
            headingId="questions-title"
            id="questions"
            label=""
            questions={questions.map(({ answer, question }) => ({
              answer: <p>{answer}</p>,
              question,
            }))}
          />

          <MarketingMaker
            heading="Built by Ben Guo"
            headingId="maker-title"
            id="maker"
            label=""
            links={[
              { href: "https://hraness.com", label: "hraness.com" },
              { href: "https://x.com/hraness", label: "@hraness" },
              { href: repository, label: "GitHub" },
            ]}
          >
            <p>
              AgentMixer is built by Ben Guo, a musician and builder, formerly a founder and engineering
              leader at companies including Venmo and Stripe, now building from Puerto Rico. It is
              published by Hraness under the MIT license.
            </p>
          </MarketingMaker>

          <MarketingCallToAction
            actions={[
              { href: "#install", label: "Install AgentMixer" },
              { href: "/docs", label: "Read the docs" },
            ]}
            footnote={footnote}
            heading="Give the agent only the tools the host declared."
            headingId="cta-title"
            summary="Add the package, bind one capability profile, and qualify the exact runtime before anything runs."
          />
        </MarketingPage>
      </main>

      <AskAiAboutThis className="ask-ai" url="https://agentmixer.dev" />

      <div className="site-footer">
        <p>AgentMixer is open source for developers and the agents working beside them.</p>
        <nav aria-label="Project links">
          <a href="/docs">Docs</a>
          <a href={repository}>hraness/agentmixer</a>
          <a href="https://hraness.com/projects">Hraness projects</a>
        </nav>
      </div>
    </div>
  );
}
