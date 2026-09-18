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
    <img className="xcb-topic-icon" src={`/icons/${slug}.svg`} alt="" aria-hidden="true" width="88" height="88" loading="lazy" decoding="async" />
  );
}

const releaseVersion = publishedRelease?.version;
const repository = "https://github.com/hraness/xcb";
const archiveUrl = releaseVersion === undefined ? null : `${repository}/releases/download/v${releaseVersion}/hraness-xcb-${releaseVersion}.tgz`;

const heading = "Your agents. Your terminal. Your edge.";
const footnote = "Excalibur, for short. Local-first and MIT licensed. Native Rust interface in development; the @hraness/xcb compatibility package remains available.";

const primitives = [
  {
    icon: "account-custody",
    label: "Bring your accounts",
    summary: "Keep named coding-agent accounts together without mixing their credentials. See subscription windows and usage freshness in one compact view.",
  },
  {
    icon: "model-selection",
    label: "Choose your models",
    summary: "Favorites first, the rest below. Pick a model across harnesses, or a provider-managed mode such as Devin Adaptive or Fusion. No task-shape router making the choice for you.",
  },
  {
    icon: "capability-profiles",
    label: "Make it your pane",
    summary: "Choose, edit, or generate a userspace pane with /pane. Reload a valid change without rebuilding the terminal; an invalid edit keeps the last working view.",
  },
  {
    icon: "public-web-port",
    label: "See the pace",
    summary: "Session token velocity, a share of observed local throughput, and subscription runway estimates. Unknown quota stays unknown, not a reassuring full meter.",
  },
  {
    icon: "tool-broker",
    label: "Keep context useful",
    summary: "Gobstopper supplies the context-management strategy. Apply supported compaction at settled boundaries, with the full local transcript retained.",
  },
  {
    icon: "provider-adapters",
    label: "Compose the behavior",
    summary: "Continuation, usage, and context management are separate extensions. Add trusted lifecycle hooks without turning the renderer into the execution kernel.",
  },
] as const;

const trust = [
  {
    label: "Local by default",
    detail: "Accounts, session history, configuration, and panes stay on this machine. No cloud synchronization or required daemon. aiCharts publishing is a separate opt-in, not a condition of local measurement.",
  },
  {
    label: "Continue, not blindly repeat",
    detail: "Automatic continuation stops for questions, authentication, approvals, cancellation, and budget limits. A quota failure can trigger a settled handoff; an uncertain effect cannot authorize replay.",
  },
  {
    label: "A pane is not permission",
    detail: "Pane declarations are bounded presentation data. Generating a view cannot grant credential access, execute a hook, or change provider admission. Executable extensions require a separate trust decision.",
  },
] as const;

const questions = [
  {
    question: "What is xcb?",
    answer: "xcb is Excalibur: a local, terminal-first workspace for coding agents. It is AgentMixer's new name and direction, with a native Rust kernel and a composable terminal interface in development.",
  },
  {
    question: "Is this Oompa in a terminal?",
    answer: "No. xcb carries forward useful ideas about accounts, usage, response state, and handoffs without Oompa's cloud control plane. The core is local; optional extensions add behavior.",
  },
  {
    question: "Can I use Adaptive and Fusion?",
    answer: "The model catalog distinguishes fixed models, Adaptive routing, and Fusion lead/sidekick pairings. Choices must come from the provider's observed catalog; availability in a catalog is not itself proof that a native execution adapter is qualified.",
  },
  {
    question: "Does usage go to aiCharts automatically?",
    answer: "No. Local measurement and publishing are separate. The design supports opt-in idle-boundary exports using aiCharts formats; its upload service is not yet live-qualified. Session text and credentials are not numeric usage data.",
  },
  {
    question: "What can I install today?",
    answer: "The @hraness/xcb TypeScript package remains the verified compatibility release. Native xcb is being developed separately. A compatibility package release is not advertised as a native xcb binary.",
  },
  {
    question: "Who made it?",
    answer: "Ben Guo, a musician and builder, formerly a founder and engineering leader at companies including Venmo and Stripe, now building from Puerto Rico. xcb is published by Hraness under the MIT license.",
  },
] as const;

const navigation = [
  { href: "#model", label: "Building blocks" },
  { href: "#interfaces", label: "Make it yours" },
  { href: "#install", label: "Get started" },
  { href: "/docs", label: "Docs" },
  { href: repository, label: "GitHub" },
] as const;

function BrandMark() {
  return <span aria-hidden="true" style={{ fontFamily: "monospace" }}>†</span>;
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
      programmingLanguage: ["Rust", "TypeScript"],
      url: "https://xcb.dev",
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
        action={{ href: "#install", label: "Explore xcb" }}
        brand={<><BrandMark />xcb</>}
        brandLabel="xcb home"
        links={navigation}
        trailing={<ThemeMenuButton aria-label="Appearance" />}
      />

      <main id="main" tabIndex={-1}>
        <MarketingPage>
          <div className="hraness-material-wall">
          <ProductHero
            align="start"
            actions={[
              { href: "#install", label: "Explore xcb" },
              { href: "/docs", label: "Read the docs" },
            ]}
            boundary={footnote}
            className="xcb-marketing-hero"
            eyebrow="xcb / Excalibur"
            frame={(
              <MarketingProofFrame
                className="hraness-material-pane"
                caption="An illustrative focus pane. Quiet by default; yours to reshape."
                credit="Native interface design"
                title="Less activity. More signal."
              >
                <pre className="transcript" tabIndex={0}><code>{`xcb · factory / renderer             usage: unmeasured

You
Make the interface feel like mine.

▸ Thinking                           collapsed
▸ Earlier responses                  collapsed

The pane is a declaration, not a fork of the harness.
Edit it here. Keep working. See it reload.

Subagents    renderer: working · tests: complete

───────────────────────────────────────────────────
› /pane focus
───────────────────────────────────────────────────
Claude · Fable 5.1                 [ working ]`}</code></pre>
              </MarketingProofFrame>
            )}
            heading={heading}
            headingId="hero-title"
            name=""
            summary={readmeLead}
          />
          </div>

          <MarketingPrimitives
            heading="A small core. The parts you choose."
            headingId="model-title"
            id="model"
            items={primitives.map((primitive) => ({
              example: <TopicIcon slug={primitive.icon} />,
              label: primitive.label,
              summary: primitive.summary,
            }))}
            label=""
            summary="The native direction: accounts and sessions in the kernel, behavior in extensions, presentation in userspace. No cloud control plane required."
          />

          <MarketingInterfaceGrid
            heading="Shape the harness from inside it."
            headingId="interfaces-title"
            id="interfaces"
            interfaces={[
              {
                label: "Panes",
                summary: "A layout you can read, edit, and reload. Keep the prompt and safety controls in trusted terminal chrome.",
                example: (
                  <>
                    <TopicIcon slug="sdk" />
                    <pre tabIndex={0}><code>{`/pane
/pane focus
/pane edit
/pane generate a compact swarm view`}</code></pre>
                  </>
                ),
              },
              {
                label: "Models",
                summary: "Choose a fixed favorite or a provider-managed mode. Fusion pairings stay pairings, not invented capability scores.",
                example: (
                  <>
                    <TopicIcon slug="model-selection" />
                    <pre tabIndex={0}><code>{`Devin       SWE-2 · Astra Max · Sol Max
Modes       Adaptive · Fusion
Claude      Fable 5.1 · Opus 5
Codex       Astra Ultra · Sol Ultra`}</code></pre>
                  </>
                ),
              },
              {
                label: "Extensions",
                summary: "Useful defaults, individually switchable. Publishing and executable hooks need their own explicit opt-in.",
                example: (
                  <>
                    <TopicIcon slug="capability-profiles" />
                    <pre tabIndex={0}><code>{`auto-continue    on · bounded
gobstopper       on · safe boundaries
usage           local
aiCharts upload off`}</code></pre>
                    <p className="interface-link"><a href="/docs#native-xcb">Read the native interface guide</a></p>
                  </>
                ),
              },
            ]}
            label=""
            summary="These are the native interface's design targets. See the docs for the current implementation and provider qualification limits."
          />

          <MarketingSection
            heading="Malleable, without being fragile."
            headingId="boundary-title"
            id="boundary"
            label=""
            summary="Make the interface personal. Keep the important boundaries explicit."
          >
            <MarketingTrustBoundary
              heading="The kernel keeps custody."
              headingId="kernel-title"
              id="kernel"
              items={trust}
              label=""
              summary="A prompt is not isolation. A timeout is not proof that a process stopped. A fresh view is not permission to repeat a mutation."
            />
          </MarketingSection>

          <MarketingInstallPanel
            eyebrow=""
            heading="Start with the source."
            headingId="install-title"
            id="install"
          >
            <p className="install-note">Native xcb is in development. The source tree keeps the Rust work separate from the published TypeScript compatibility package.</p>
            <p><a href={repository}>Follow the native work</a> · <a href="/docs#native-xcb">Read the native interface guide</a></p>
            <h3>xcb compatibility package</h3>
            <p className="install-note">{releaseVersion === undefined ? "First xcb package release in preparation" : `Current verified compatibility release · v${releaseVersion}`}</p>
            {publishedRelease !== null && archiveUrl !== null ? (
              <>
                <pre className="install-command" tabIndex={0}><code>{`bun add ${archiveUrl}`}</code></pre>
                <p className="install-note">
                  <a href={publishedRelease.verificationRun}>Public release verification</a>.{" "}
                  This installs <code>@hraness/xcb</code>, not a native xcb release.{" "}
                  <a href="/docs#standalone-package">Compatibility package reference</a>.
                </p>
              </>
            ) : (
              <p className="install-note">
                The first release is being prepared.{" "}
                <a href={`${repository}/releases`}>Check published releases</a> or{" "}
                <a href="/docs">read the documentation</a>.
              </p>
            )}
          </MarketingInstallPanel>

          <MarketingQuestionList
            heading="Before you start."
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
              xcb is built by Ben Guo, a musician and builder, formerly a founder and engineering
              leader at companies including Venmo and Stripe, now building from Puerto Rico.
              Published by Hraness under the MIT license.
            </p>
          </MarketingMaker>

          <MarketingCallToAction
            actions={[
              { href: "/docs", label: "Read the docs" },
              { href: repository, label: "Explore the source" },
            ]}
            footnote={footnote}
            heading="An edge of your own."
            headingId="cta-title"
            summary="Keep the accounts. Choose the models. Make the terminal yours."
          />
        </MarketingPage>
      </main>

      <AskAiAboutThis className="ask-ai" url="https://xcb.dev" />

      <div className="site-footer">
        <p>xcb — Excalibur. Open source for developers and their coding agents.</p>
        <nav aria-label="Project links">
          <a href="/docs">Docs</a>
          <a href={repository}>Source on GitHub</a>
          <a href="https://hraness.com/projects">Hraness projects</a>
        </nav>
      </div>
    </div>
  );
}
